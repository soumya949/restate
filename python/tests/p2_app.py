"""P2 test services: OpenAI Agents SDK (govern_agent / governed_function_tool) with a fake model,
multi-agent parent → child over Restate RPC, and governed_parallel (architecture §22.4)."""

from __future__ import annotations

import base64
from typing import Any

import httpx
import restate
from agents import Agent, ModelResponse, Usage, set_tracing_disabled
from agents.models.interface import Model
from agents.models.multi_provider import MultiProvider
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText
from restate.exceptions import TerminalError
from restate.ext.openai import DurableRunner, durable_function_tool, restate_context

from openbox_restate import OpenBoxRestate, governed_run, is_blocked, openbox_handler
from openbox_restate.governed_run import ParallelCall, governed_parallel
from openbox_restate.multi_agent import governed_sub_agent
from openbox_restate.openai import govern_agent, governed_function_tool

from .fake_core import FakeCore

set_tracing_disabled(True)

agent_core = FakeCore()
parent_core = FakeCore()
child_core = FakeCore()
ran: list[str] = []

_seed = Ed25519PrivateKey.generate().private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
PARENT_DID = "did:aip:6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"


def _rt(core: FakeCore, key: str, **extra: Any) -> OpenBoxRestate:
    return OpenBoxRestate(
        async_transport=httpx.MockTransport(core.handler),
        api_url="http://localhost:8787",
        api_key=key,
        environ={},
        governance_max_retries=2,
        approval_poll_interval_ms=100,
        **extra,
    )


rt_agent = _rt(agent_core, "obx_test_openaiagent")
rt_parent = _rt(
    parent_core,
    "obx_test_parentagent",
    agent_did=PARENT_DID,
    agent_private_key=base64.b64encode(_seed).decode(),
)
rt_child = _rt(child_core, "obx_test_childagent")


# ── fake model: asks for the scripted tool calls, then answers with the tool outputs ──

SCRIPTS: dict[str, list[tuple[str, str, str]]] = {
    "weather": [("call_w1", "get_weather", '{"city": "Paris"}')],
    "delete": [("call_d1", "delete_records", '{"table": "users"}')],
    "wire": [("call_x1", "wire_money", '{"account": "A1", "amount": 5}')],
    "email": [("call_e1", "send_email", '{"to": "bob@example.com"}')],
    "both": [("call_b1", "get_weather", '{"city": "Rome"}'), ("call_b2", "get_weather", '{"city": "Oslo"}')],
}


class FakeModel(Model):
    async def get_response(self, system_instructions: Any, input: Any, *args: Any, **kwargs: Any) -> ModelResponse:
        items = input if isinstance(input, list) else [{"role": "user", "content": input}]
        outputs = [
            str(i.get("output")) for i in items if isinstance(i, dict) and i.get("type") == "function_call_output"
        ]
        if outputs:
            text = ResponseOutputText(type="output_text", text="done: " + " | ".join(outputs), annotations=[])
            msg = ResponseOutputMessage(id="m1", type="message", role="assistant", status="completed", content=[text])
            return ModelResponse(output=[msg], usage=Usage(), response_id=None)
        prompt = next(str(i.get("content")) for i in items if isinstance(i, dict) and i.get("role") == "user")
        calls = [
            ResponseFunctionToolCall(type="function_call", call_id=cid, name=name, arguments=args, id=f"fc_{cid}")
            for cid, name, args in SCRIPTS[prompt]
        ]
        return ModelResponse(output=list(calls), usage=Usage(), response_id=None)

    def stream_response(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError


# DurableRunner's provider asks MultiProvider for the model; hand it the fake instead of OpenAI.
MultiProvider.get_model = lambda self, model_name=None: FakeModel()  # type: ignore[method-assign,assignment]


# ── tools: plain durable tools governed by govern_agent, plus one decorator-built tool ──


def _side_effect(label: str, value: Any) -> Any:
    async def call() -> Any:
        ran.append(label)
        return value

    return restate_context().run_typed(label, call)


@durable_function_tool
async def get_weather(city: str) -> dict[str, Any]:
    """Get the weather for a city."""
    return await _side_effect(f"weather:{city}", {"city": city, "temperature": 23})  # type: ignore[no-any-return]


@durable_function_tool
async def delete_records(table: str) -> str:
    """Delete all records of a table."""
    return await _side_effect(f"delete:{table}", "deleted")  # type: ignore[no-any-return]


@durable_function_tool
async def wire_money(account: str, amount: float) -> str:
    """Wire money."""
    return await _side_effect(f"wire:{account}", "wired")  # type: ignore[no-any-return]


@governed_function_tool(type="EMAIL_SEND")
async def send_email(to: str) -> str:
    """Send an email."""
    return await _side_effect(f"email:{to}", "sent")  # type: ignore[no-any-return]


mail_agent = Agent(
    name="MailAgent",
    instructions="Use the tools.",
    tools=[get_weather, delete_records, wire_money, send_email],
)
governed_mail_agent = govern_agent(mail_agent, type_map={"delete_records": "DATABASE_WRITE"})

oai = restate.Service("oai")


@oai.handler()
@openbox_handler(runtime=rt_agent, agent_name="mail-agent", prompt_from=lambda s: s)
async def run(_ctx: restate.Context, script: str) -> str:
    result = await DurableRunner.run(governed_mail_agent, script)
    return str(result.final_output)


# ── multi-agent: parent → child over Restate RPC ──

research = restate.Service("research")


@research.handler("run")
@openbox_handler(runtime=rt_child, agent_name="research-agent", prompt_from=lambda t: t)
async def research_run(ctx: restate.Context, topic: str) -> str:
    async def search(t: str) -> str:
        return await _side_effect(f"search:{t}", f"facts about {t}")  # type: ignore[no-any-return]

    r = await governed_run(ctx, "web_search", search, input=topic, tool_call_id="s1")
    return "blocked" if is_blocked(r) else str(r)


lead = restate.Service("lead")


@lead.handler()
@openbox_handler(runtime=rt_parent, agent_name="lead-agent", prompt_from=lambda t: f"research {t}")
async def delegate(ctx: restate.Context, topic: str) -> dict[str, Any]:
    r = await governed_sub_agent(
        ctx,
        agent_name="research",
        input=topic,
        tool_call_id="call_r1",
        invoke=lambda t, headers: ctx.service_call(research_run, arg=t, headers=headers),
    )
    if is_blocked(r):
        return {"blocked": True, "reason": r.reason}
    return {"result": r}


@lead.handler()
@openbox_handler(runtime=rt_parent, agent_name="parallel-agent")
async def parallel(ctx: restate.Context, _: Any = None) -> list[Any]:
    def tool(label: str) -> Any:
        async def go(arg: str) -> dict[str, Any]:
            return await _side_effect(f"{label}:{arg}", {"arg": arg})  # type: ignore[no-any-return]

        return go

    results = await governed_parallel(
        ctx,
        [
            ParallelCall("get_weather", tool("weather"), arguments="Rome", tool_call_id="p1"),
            ParallelCall("delete_records", tool("delete"), arguments="users", tool_call_id="p2"),
            ParallelCall("get_weather", tool("weather"), arguments="Oslo", tool_call_id="p3"),
        ],
    )
    return [f"blocked:{r.reason}" if is_blocked(r) else r for r in results]


def describe(e: BaseException) -> dict[str, Any]:
    if isinstance(e, TerminalError):
        return {"error": type(e).__name__, "code": e.status_code}
    return {"error": str(e)}


SERVICES = [oai, research, lead]
