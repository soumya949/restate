"""P4 test services: Google ADK, Pydantic AI and LangChain agents governed through the drop-in
OpenBox versions of Restate's integrations, each with a deterministic fake model (architecture §22.6)."""

from __future__ import annotations

import json
from typing import Any

import httpx
import restate

from openbox_restate import OpenBoxRestate, openbox_handler

from .fake_core import FakeCore

adk_core = FakeCore()
pyd_core = FakeCore()
lc_core = FakeCore()
ran: list[str] = []

SCRIPTS: dict[str, tuple[str, str, dict[str, Any]]] = {
    "weather": ("call_w1", "get_weather", {"city": "Paris"}),
    "delete": ("call_d1", "delete_records", {"table": "users"}),
    "wire": ("call_x1", "wire_money", {"account": "A1", "amount": 5}),
    "email": ("call_e1", "send_email", {"to": "bob@example.com"}),
}


def _rt(core: FakeCore, key: str) -> OpenBoxRestate:
    return OpenBoxRestate(
        async_transport=httpx.MockTransport(core.handler),
        api_url="http://localhost:8787",
        api_key=key,
        environ={},
        governance_max_retries=2,
        approval_poll_interval_ms=100,
    )


rt_adk, rt_pyd, rt_lc = (
    _rt(adk_core, "obx_test_adkagent"),
    _rt(pyd_core, "obx_test_pydagent"),
    _rt(lc_core, "obx_test_lcagent"),
)


async def _side_effect(label: str, value: Any) -> Any:
    from restate.extensions import current_context

    async def call() -> Any:
        ran.append(label)
        return value

    ctx = current_context()
    assert ctx is not None
    return await ctx.run_typed(label, call)


# The four tools, shared by the three frameworks (plain async functions).
async def get_weather(city: str) -> dict[str, Any]:
    """Get the weather for a city."""
    return await _side_effect(f"weather:{city}", {"city": city, "temperature": 23})  # type: ignore[no-any-return]


async def delete_records(table: str) -> str:
    """Delete all records of a table."""
    return await _side_effect(f"delete:{table}", "deleted")  # type: ignore[no-any-return]


async def wire_money(account: str, amount: float) -> str:
    """Wire money."""
    return await _side_effect(f"wire:{account}", "wired")  # type: ignore[no-any-return]


async def send_email(to: str) -> str:
    """Send an email."""
    return await _side_effect(f"email:{to}", "sent")  # type: ignore[no-any-return]


TOOLS = [get_weather, delete_records, wire_money, send_email]


# ── Google ADK ───────────────────────────────────────────────────────────────

from google.adk import Runner  # noqa: E402
from google.adk.agents.llm_agent import Agent as AdkAgent  # noqa: E402
from google.adk.apps import App  # noqa: E402
from google.adk.models.base_llm import BaseLlm  # noqa: E402
from google.adk.models.llm_request import LlmRequest  # noqa: E402
from google.adk.models.llm_response import LlmResponse  # noqa: E402
from google.adk.sessions import InMemorySessionService  # noqa: E402
from google.genai import types  # noqa: E402

from openbox_restate.adk import OpenBoxRestatePlugin  # noqa: E402


class FakeAdkModel(BaseLlm):
    model: str = "fake-adk"

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> Any:
        usage = types.GenerateContentResponseUsageMetadata(prompt_token_count=12, candidates_token_count=5)
        parts = [p for c in llm_request.contents or [] for p in (c.parts or [])]
        results = [p.function_response for p in parts if p.function_response]
        if results:
            text = "done: " + " | ".join(json.dumps(r.response, default=str) for r in results)
            yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=text)]), usage_metadata=usage)
            return
        prompt = next(p.text for p in parts if p.text)
        cid, name, args = SCRIPTS[prompt]
        call = types.Part(function_call=types.FunctionCall(id=cid, name=name, args=args))
        yield LlmResponse(content=types.Content(role="model", parts=[call]), usage_metadata=usage)


adk_app = App(
    name="adk_agents",
    root_agent=AdkAgent(model=FakeAdkModel(), name="adk_agent", instruction="Use the tools.", tools=list(TOOLS)),
    plugins=[OpenBoxRestatePlugin(type_map={"delete_records": "DATABASE_WRITE"})],
)
adk_sessions = InMemorySessionService()
adk = restate.Service("adk")


@adk.handler()
@openbox_handler(runtime=rt_adk, agent_name="adk-agent", prompt_from=lambda s: s)
async def adk_run(ctx: restate.Context, script: str) -> str | None:
    session_id = str(ctx.uuid())
    # As in Restate's template: the attempt may be a replay, so only create the session once.
    if not await adk_sessions.get_session(app_name="adk_agents", user_id="u1", session_id=session_id):
        await adk_sessions.create_session(app_name="adk_agents", user_id="u1", session_id=session_id)
    runner = Runner(app=adk_app, session_service=adk_sessions)
    final = None
    async for event in runner.run_async(
        user_id="u1", session_id=session_id, new_message=types.Content(role="user", parts=[types.Part(text=script)])
    ):
        if event.is_final_response() and event.content and event.content.parts and event.content.parts[0].text:
            final = event.content.parts[0].text
    return final


# ── Pydantic AI ──────────────────────────────────────────────────────────────

from pydantic_ai import Agent as PydAgent  # noqa: E402
from pydantic_ai.messages import (  # noqa: E402
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel  # noqa: E402
from pydantic_ai.usage import RequestUsage  # noqa: E402

from openbox_restate.pydantic_ai import OpenBoxRestateAgent  # noqa: E402


def _pyd_model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
    usage = RequestUsage(input_tokens=12, output_tokens=5)
    parts = [p for m in messages if isinstance(m, ModelRequest) for p in m.parts]
    returns = [p for p in parts if isinstance(p, ToolReturnPart)]
    if returns:
        text = "done: " + " | ".join(str(r.content) for r in returns)
        return ModelResponse(parts=[TextPart(text)], usage=usage, model_name="fake-pydantic")
    prompt = next(str(p.content) for p in parts if isinstance(p, UserPromptPart))
    cid, name, args = SCRIPTS[prompt]
    return ModelResponse(
        parts=[ToolCallPart(tool_name=name, args=args, tool_call_id=cid)], usage=usage, model_name="fake-pydantic"
    )


pyd_agent: PydAgent[None, str] = PydAgent(FunctionModel(_pyd_model), system_prompt="Use the tools.")
for _t in TOOLS:
    pyd_agent.tool_plain(_t)
pyd_restate_agent = OpenBoxRestateAgent(pyd_agent, type_map={"delete_records": "DATABASE_WRITE"})
pyd = restate.Service("pyd")


@pyd.handler()
@openbox_handler(runtime=rt_pyd, agent_name="pydantic-agent", prompt_from=lambda s: s)
async def pyd_run(_ctx: restate.Context, script: str) -> str:
    result = await pyd_restate_agent.run(script)
    return str(result.output)


# ── LangChain ────────────────────────────────────────────────────────────────

from langchain.agents import create_agent  # noqa: E402
from langchain_core.language_models.chat_models import BaseChatModel  # noqa: E402
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage  # noqa: E402
from langchain_core.outputs import ChatGeneration, ChatResult  # noqa: E402
from langchain_core.tools import tool as lc_tool  # noqa: E402

from openbox_restate.langchain import OpenBoxRestateMiddleware  # noqa: E402


class FakeLcModel(BaseChatModel):
    @property
    def _llm_type(self) -> str:
        return "fake-langchain"

    def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
        return self

    def _generate(
        self, messages: list[BaseMessage], stop: Any = None, run_manager: Any = None, **kw: Any
    ) -> ChatResult:
        usage = {"input_tokens": 12, "output_tokens": 5, "total_tokens": 17}
        meta = {"model_name": "fake-langchain"}
        results = [m for m in messages if isinstance(m, ToolMessage)]
        if results:
            text = "done: " + " | ".join(str(r.content) for r in results)
            msg = AIMessage(content=text, usage_metadata=usage, response_metadata=meta)  # type: ignore[arg-type]
        else:
            prompt = next(str(m.content) for m in messages if isinstance(m, HumanMessage))
            cid, name, args = SCRIPTS[prompt]
            msg = AIMessage(
                content="",
                tool_calls=[{"name": name, "args": args, "id": cid, "type": "tool_call"}],
                usage_metadata=usage,  # type: ignore[arg-type]
                response_metadata=meta,
            )
        return ChatResult(generations=[ChatGeneration(message=msg)])


lc_agent = create_agent(
    model=FakeLcModel(),
    tools=[lc_tool(t) for t in TOOLS],
    system_prompt="Use the tools.",
    middleware=[OpenBoxRestateMiddleware(type_map={"delete_records": "DATABASE_WRITE"})],
)
lc = restate.Service("lc")


@lc.handler()
@openbox_handler(runtime=rt_lc, agent_name="langchain-agent", prompt_from=lambda s: s)
async def lc_run(_ctx: restate.Context, script: str) -> str:
    result = await lc_agent.ainvoke({"messages": [{"role": "user", "content": script}]})
    return str(result["messages"][-1].content)


SERVICES = [adk, pyd, lc]
CORES = {"adk": adk_core, "pyd": pyd_core, "lc": lc_core}
