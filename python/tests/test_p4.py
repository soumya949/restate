"""P4 (architecture §22.6): Google ADK, Pydantic AI and LangChain through the OpenBox drop-ins, against a
real Restate server that replays after every suspension. Same four scenarios for every framework."""

from __future__ import annotations

from typing import Any

import pytest

from .conftest import requires_restate
from .p4_app import CORES, ran, seen_prompts

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


GUARDRAIL_FAILED = {
    "verdict": "allow",
    "guardrails_result": {"validation_passed": False, "reasons": [{"reason": "toxic"}]},
}


# ── LLM input guardrails (enforced on llm_call like on a tool) ──

PII = "weather for bob@example.com"


def _redact_llm_prompt(core: Any) -> None:
    """The live PII guardrail's answer: allow, with the prompt redacted (activity_input)."""
    core.rule(
        lambda b: {
            "verdict": "allow",
            "guardrails_result": {
                "validation_passed": True,
                "input_type": "activity_input",
                "redacted_input": [{"prompt": "weather for <EMAIL_ADDRESS>"}],
                "reasons": [{"reason": "The following text contains PII"}],
            },
        }
        if b.get("activity_type") == "llm_call" and b.get("event_type") == "ActivityStarted"
        else None
    )


@pytest.mark.parametrize(("fw", "handler"), FRAMEWORKS)
async def test_llm_input_guardrail_redacts_the_prompt_the_model_receives(call: Any, fw: str, handler: str) -> None:
    core = CORES[fw]
    _redact_llm_prompt(core)
    out = await ok(call, handler, PII)
    assert "Paris" in out
    assert seen_prompts and all(p == "weather for <EMAIL_ADDRESS>" for p in seen_prompts)
    assert ran == ["weather:Paris"]


@pytest.mark.parametrize(("fw", "handler"), FRAMEWORKS)
async def test_failed_llm_guardrail_refuses_the_model_call(call: Any, fw: str, handler: str) -> None:
    core = CORES[fw]
    core.on_activity("llm_call", "ActivityStarted", GUARDRAIL_FAILED)
    r = await call(handler, "weather")
    assert r.status_code == 422, r.text
    assert "guardrails failed: toxic" in r.text
    assert seen_prompts == [] and ran == []


@pytest.mark.parametrize(("fw", "handler"), FRAMEWORKS)
async def test_halt_on_llm_call_stops_before_the_model(call: Any, fw: str, handler: str) -> None:
    core = CORES[fw]
    core.on_activity("llm_call", "ActivityStarted", {"verdict": "halt", "reason": "model use suspended"})
    r = await call(handler, "weather")
    assert r.status_code == 403, r.text
    assert "OpenBox HALT: model use suspended" in r.text
    assert seen_prompts == [] and ran == []
    assert len(core.evaluations("ActivityStarted", "llm_call")) == 1
    assert core.evaluations("WorkflowFailed") == []
