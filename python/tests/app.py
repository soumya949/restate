"""Test services — mirrors typescript/test/restate/governance.test.ts (scenario numbers: architecture §18.3)."""

from __future__ import annotations

from typing import Any

import httpx
import restate
from restate.exceptions import TerminalError

from openbox_restate import OpenBoxRestate, governed_call, governed_run, is_blocked, openbox_handler

from .fake_core import FakeCore

core = FakeCore()
counters = {"tool": 0}
crash = {"done": False}


def _runtime(**extra: Any) -> OpenBoxRestate:
    opts: dict[str, Any] = {
        "api_url": "http://localhost:8787",
        "api_key": "obx_test_restatesdk",
        "environ": {},
        "governance_max_retries": 2,
        "approval_poll_interval_ms": 100,
        **extra,
    }
    return OpenBoxRestate(async_transport=httpx.MockTransport(core.handler), **opts)


rt_open = _runtime(on_api_error="fail_open")
rt_closed = _runtime(on_api_error="fail_closed")
rt_no_hitl = _runtime(hitl_enabled=False)
rt_fast_outage = _runtime(max_consecutive_poll_failures=2)


def describe(e: BaseException) -> dict[str, Any]:
    if isinstance(e, TerminalError):
        return {"error": type(e).__name__, "code": e.status_code}
    return {"error": str(e)}


async def weather(ctx: restate.Context, city: str) -> dict[str, Any]:
    async def call() -> dict[str, Any]:
        counters["tool"] += 1
        return {"city": city, "temperature": 23}

    return await ctx.run_typed(f"weather {city}", call)


async def side_effect(ctx: restate.Context, value: Any) -> Any:
    async def call() -> Any:
        counters["tool"] += 1
        return value

    return await ctx.run_typed("side effect", call)


agent = restate.Service("agent")


def _out(r: Any) -> Any:
    return {"blocked": True, "reason": r.reason, "policy_id": r.policy_id} if is_blocked(r) else r


@agent.handler()
@openbox_handler(runtime=rt_open, agent_name="weather-agent", prompt_from=lambda c: f"weather in {c}?")
async def allow(ctx: restate.Context, city: str) -> dict[str, Any]:
    r = await governed_run(ctx, "get_weather", lambda c: weather(ctx, c), input=city, tool_call_id="call_1")
    return {"result": _out(r)}


@agent.handler()
@openbox_handler(runtime=rt_open, agent_name="weather-agent")
async def crash_once(ctx: restate.Context, city: str) -> dict[str, Any]:
    async def tool(c: str) -> dict[str, Any]:
        if not crash["done"]:
            crash["done"] = True
            raise RuntimeError("simulated crash after openbox:pre")
        return await weather(ctx, c)

    r = await governed_run(ctx, "get_weather", tool, input=city, tool_call_id="call_1")
    return {"result": _out(r)}


@agent.handler()
@openbox_handler(runtime=rt_open, agent_name="db-agent")
async def block(ctx: restate.Context, _: Any) -> dict[str, Any]:
    r = await governed_call(
        ctx,
        tool_name="delete_db",
        tool_call_id="call_1",
        arguments={"table": "users"},
        run=lambda a: side_effect(ctx, "deleted"),
    )
    return {"result": _out(r)}


@agent.handler()
@openbox_handler(runtime=rt_open, agent_name="money-agent")
async def halt(ctx: restate.Context, _: Any) -> dict[str, Any]:
    await governed_run(
        ctx, "wire_money", lambda a: side_effect(ctx, "sent"), input={"amount": 5000}, tool_call_id="call_1"
    )
    await governed_run(ctx, "get_weather", lambda c: weather(ctx, c), input="Paris", tool_call_id="call_2")
    return {"unreachable": True}


@agent.handler()
@openbox_handler(runtime=rt_open, agent_name="crm-agent")
async def redact(ctx: restate.Context, _: Any) -> dict[str, Any]:
    r = await governed_run(
        ctx, "lookup_user", lambda a: side_effect(ctx, {"ssn": "123-45-6789"}), input={"id": 7}, tool_call_id="call_1"
    )
    return {"result": _out(r)}


@agent.handler()
@openbox_handler(runtime=rt_open, agent_name="c-agent")
async def constrain(ctx: restate.Context, _: Any) -> dict[str, Any]:
    try:
        await governed_run(ctx, "constrained_tool", lambda a: side_effect(ctx, 1), input=1, tool_call_id="call_1")
        return {"ok": True}
    except TerminalError as e:
        return describe(e)


async def _wrapped(ctx: restate.Context, rt: OpenBoxRestate, agent_name: str) -> dict[str, Any]:
    @openbox_handler(runtime=rt, agent_name=agent_name)
    async def inner(ctx: restate.Context, _: Any) -> dict[str, Any]:
        return {"ok": True}

    try:
        return await inner(ctx, None)
    except TerminalError as e:
        return describe(e)


@agent.handler()
async def closed_outage(ctx: restate.Context, _: Any) -> dict[str, Any]:
    return await _wrapped(ctx, rt_closed, "x")


@agent.handler()
async def auth(ctx: restate.Context, _: Any) -> dict[str, Any]:
    return await _wrapped(ctx, rt_closed, "x")


@agent.handler()
@openbox_handler(runtime=rt_open, agent_name="weather-agent")
async def open_outage(ctx: restate.Context, _: Any) -> dict[str, Any]:
    r = await governed_run(ctx, "get_weather", lambda c: weather(ctx, c), input="Oslo", tool_call_id="call_1")
    return {"result": _out(r)}


@agent.handler()
@openbox_handler(runtime=rt_open, agent_name="mail-agent")
async def approve(ctx: restate.Context, _: Any) -> dict[str, Any]:
    try:
        r = await governed_run(
            ctx, "send_email", lambda a: side_effect(ctx, "sent"), input={"to": "a@b.com"}, tool_call_id="call_1"
        )
        return {"result": _out(r)}
    except TerminalError as e:
        return describe(e)


@agent.handler()
@openbox_handler(runtime=rt_fast_outage, agent_name="mail-agent")
async def approve_outage(ctx: restate.Context, _: Any) -> dict[str, Any]:
    try:
        await governed_run(ctx, "send_email", lambda a: side_effect(ctx, "sent"), input={}, tool_call_id="call_1")
        return {"ok": True}
    except TerminalError as e:
        return describe(e)


@agent.handler()
@openbox_handler(runtime=rt_no_hitl, agent_name="mail-agent")
async def no_hitl(ctx: restate.Context, _: Any) -> dict[str, Any]:
    r = await governed_run(ctx, "send_email", lambda a: side_effect(ctx, "sent"), input={}, tool_call_id="call_1")
    return {"result": _out(r)}


@agent.handler()
@openbox_handler(runtime=rt_open, agent_name="gated-agent")
async def start_gate(ctx: restate.Context, _: Any) -> dict[str, Any]:
    await side_effect(ctx, None)
    return {"ran": True}


@agent.handler()
@openbox_handler(runtime=rt_open, agent_name="weather-agent")
async def duplicate(ctx: restate.Context, _: Any) -> dict[str, Any]:
    await governed_run(ctx, "get_weather", lambda c: weather(ctx, c), input="a", tool_call_id="same")
    try:
        await governed_run(ctx, "get_weather", lambda c: weather(ctx, c), input="b", tool_call_id="same")
        return {"ok": True}
    except TerminalError as e:
        return describe(e)


# ── Span capture (openbox_restate.instrumentation) ──────────────────────────
# Process-wide patches, but only tools run by rt_spans bind an activity, so the
# other services above never produce span events.

from openbox_restate.instrumentation import enable_openbox_spans  # noqa: E402

rt_spans = _runtime(on_api_error="fail_open")
spans_handle = enable_openbox_spans(rt_spans)

API_PORT = 9095
api_hits = {"n": 0}


async def downstream_api(scope: Any, receive: Any, send: Any) -> None:
    """The tool's downstream HTTP API (counts real hits)."""
    if scope["type"] != "http":
        return
    api_hits["n"] += 1
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": b'{"ok": true}'})


async def call_api(ctx: restate.Context, tool: str) -> dict[str, Any]:
    async def call() -> dict[str, Any]:
        async with httpx.AsyncClient() as http:
            r = await http.post(f"http://127.0.0.1:{API_PORT}/v1/{tool}", json={"q": 1})
            return r.json()  # type: ignore[no-any-return]

    return await ctx.run_typed(f"call {tool}", call)


spans = restate.Service("spans")


@spans.handler()
@openbox_handler(runtime=rt_spans, agent_name="span-agent")
async def tool(ctx: restate.Context, name: str) -> dict[str, Any]:
    r = await governed_run(ctx, name, lambda _: call_api(ctx, name), input={"q": 1}, tool_call_id="call_1")
    return {"blocked": is_blocked(r), "result": _out(r)}


from openbox_restate.llm import governed_llm_call, llm_output  # noqa: E402

from . import p2_app  # noqa: E402
from .p2_app import SERVICES as P2_SERVICES  # noqa: E402

p2_app.PROVIDER_PORT.append(API_PORT)


@spans.handler()
@openbox_handler(runtime=rt_spans, agent_name="span-agent")
async def llm(ctx: restate.Context, prompt: str) -> dict[str, Any]:
    return await governed_llm_call(
        ctx,
        lambda: call_api(ctx, "llm"),
        lambda r: llm_output(model="fake-llm", input_tokens=3, output_tokens=2, completion="hi"),
        prompt=prompt,
    )


oai_spans = restate.Service("oaiSpans")


@oai_spans.handler()
@openbox_handler(runtime=rt_spans, agent_name="span-oai-agent")
async def oai_run(_ctx: restate.Context, script: str) -> str:
    from restate.ext.openai import DurableRunner

    result = await DurableRunner.run(p2_app.governed_mail_agent, script)
    return str(result.final_output)


app = restate.app(services=[agent, spans, oai_spans, *P2_SERVICES])
