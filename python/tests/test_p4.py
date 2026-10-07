"""P4 (architecture §22.6): Google ADK, Pydantic AI and LangChain through the OpenBox drop-ins, against a
real Restate server that replays after every suspension. Same four scenarios for every framework."""

from __future__ import annotations

from typing import Any

import pytest

from .conftest import requires_restate
from .p4_app import CORES, ran

pytestmark = requires_restate

FRAMEWORKS = [("adk", "adk/adk_run"), ("pyd", "pyd/pyd_run"), ("lc", "lc/lc_run")]


async def ok(call: Any, handler: str, body: Any) -> Any:
    r = await call(handler, body)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.parametrize(("fw", "handler"), FRAMEWORKS)
async def test_allow_governs_the_tool_once_and_reports_llm_calls(call: Any, fw: str, handler: str) -> None:
    core = CORES[fw]
    out = await ok(call, handler, "weather")
    assert "Paris" in out
    assert ran == ["weather:Paris"]
    started = core.evaluations("ActivityStarted", "get_weather")
    assert len(started) == 1
    assert started[0].activity_id and started[0].activity_id.endswith(":call_w1")
    assert started[0].body["activity_input"] == [{"city": "Paris"}]
    assert len(core.evaluations("ActivityCompleted", "get_weather")) == 1
    # Two model calls (tool request, then the answer), each once despite replays, with tokens.
    llm_done = core.evaluations("ActivityCompleted", "llm_call")
    assert len(core.evaluations("ActivityStarted", "llm_call")) == 2 and len(llm_done) == 2
    assert llm_done[0].body["activity_output"]["total_tokens"] == 17
    assert llm_done[0].body["activity_output"]["has_tool_calls"] is True
    assert isinstance(llm_done[0].body["duration_ms"], int)
    assert len(core.evaluations("WorkflowCompleted")) == 1


@pytest.mark.parametrize(("fw", "handler"), FRAMEWORKS)
async def test_block_answers_the_model_and_the_tool_never_runs(call: Any, fw: str, handler: str) -> None:
    core = CORES[fw]
    core.on_activity("delete_records", "ActivityStarted", {"verdict": "block", "reason": "no deletes"})
    out = await ok(call, handler, "delete")
    assert "no deletes" in out
    assert ran == []
    started = core.evaluations("ActivityStarted", "delete_records")
    assert len(started) == 1 and started[0].body.get("type") == "DATABASE_WRITE"
    assert len(core.evaluations("WorkflowCompleted")) == 1


@pytest.mark.parametrize(("fw", "handler"), FRAMEWORKS)
async def test_halt_ends_the_invocation_and_is_never_retried(call: Any, fw: str, handler: str) -> None:
    core = CORES[fw]
    core.on_activity("wire_money", "ActivityStarted", {"verdict": "halt", "reason": "fraud"})
    r = await call(handler, "wire")
    assert r.status_code == 403, r.text
    assert "OpenBox HALT: fraud" in r.text
    assert ran == []
    # Terminal on the first attempt: one pre-check, nothing sent after the HALT.
    assert len(core.evaluations("ActivityStarted", "wire_money")) == 1
    assert core.evaluations("WorkflowFailed") == [] and core.evaluations("WorkflowCompleted") == []


@pytest.mark.parametrize(("fw", "handler"), FRAMEWORKS)
async def test_approval_waits_durably_then_the_tool_runs(call: Any, fw: str, handler: str) -> None:
    core = CORES[fw]
    core.on_activity("send_email", "ActivityStarted", {"verdict": "require_approval", "reason": "review"})
    core.script_approval("call_e1", {"verdict": "require_approval"}, {"verdict": "allow"})
    out = await ok(call, handler, "email")
    assert "sent" in out
    assert ran == ["email:bob@example.com"]
    assert len(core.evaluations("ActivityStarted", "send_email")) == 1
    assert len(core.polls()) == 2


@pytest.mark.parametrize(("fw", "handler"), FRAMEWORKS)
async def test_rejected_approval_is_terminal_not_retried(call: Any, fw: str, handler: str) -> None:
    core = CORES[fw]
    core.on_activity("send_email", "ActivityStarted", {"verdict": "require_approval", "reason": "review"})
    core.script_approval("call_e1", {"verdict": "block", "reason": "no"})
    r = await call(handler, "email")
    if r.status_code == 200:
        # A framework may hand the rejection to the model as a tool error; the email must still not go out.
        assert "rejected" in r.text.lower()
    else:
        assert r.status_code == 403, r.text
        assert "approval rejected" in r.text
    assert ran == []
    assert len(core.evaluations("ActivityStarted", "send_email")) == 1
