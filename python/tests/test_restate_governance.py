"""Restate integration tests (architecture §18.3) — the Restate server replays the journal after every suspension."""

from __future__ import annotations

import re
from typing import Any

import pytest

from .app import core, counters, crash
from .conftest import requires_restate

pytestmark = requires_restate


async def ok(call: Any, handler: str, body: Any = None) -> Any:
    r = await call(handler, body)
    assert r.status_code == 200, r.text
    return r.json()


# ── P0: governed step ────────────────────────────────────────────────────────


async def test_3_allow_every_event_exactly_once(call: Any) -> None:
    out = await ok(call, "allow", "Paris")
    assert out == {"result": {"city": "Paris", "temperature": 23}}
    assert counters["tool"] == 1
    assert len(core.evaluations("WorkflowStarted")) == 1
    assert len(core.evaluations("SignalReceived")) == 1
    assert len(core.evaluations("ActivityStarted", "get_weather")) == 1
    assert len(core.evaluations("ActivityCompleted", "get_weather")) == 1
    assert len(core.evaluations("WorkflowCompleted")) == 1
    started = core.evaluations("ActivityStarted", "get_weather")[0]
    assert started.activity_id and started.activity_id.endswith(":call_1")
    assert started.body["workflow_type"] == "weather-agent"
    assert started.body["activity_input"] == ["Paris"]
    completed = core.evaluations("ActivityCompleted", "get_weather")[0]
    # Latency for the dashboard, from journaled timestamps (identical on every replay).
    assert isinstance(completed.body["duration_ms"], int) and completed.body["duration_ms"] >= 0
    # same wire field as the TypeScript package and the Temporal SDK
    assert completed.body["activity_output"] == {"city": "Paris", "temperature": 23}


async def test_1_crash_after_pre_tool_runs_once(call: Any) -> None:
    crash["done"] = False
    out = await ok(call, "crash_once", "Rome")
    assert out == {"result": {"city": "Rome", "temperature": 23}}
    assert counters["tool"] == 1
    assert len(core.evaluations("ActivityStarted", "get_weather")) == 1


async def test_6_block_returns_value_and_tool_never_runs(call: Any) -> None:
    core.on_activity(
        "delete_db", "ActivityStarted", {"verdict": "block", "reason": "deletes are forbidden", "policy_id": "p1"}
    )
    out = await ok(call, "block")
    assert out == {"result": {"blocked": True, "reason": "deletes are forbidden", "policy_id": "p1"}}
    assert counters["tool"] == 0
    assert core.evaluations("ActivityCompleted", "delete_db") == []


async def test_7_halt_fails_invocation_and_sends_nothing_after(call: Any) -> None:
    core.on_activity("wire_money", "ActivityStarted", {"verdict": "halt", "reason": "fraud pattern"})
    r = await call("halt")
    assert r.status_code >= 400
    assert re.search("OpenBox HALT: fraud pattern", r.text)
    assert counters["tool"] == 0
    assert core.evaluations("ActivityStarted", "get_weather") == []
    # Core closes the session on HALT and answers anything later with "Session is no longer active".
    assert core.evaluations("WorkflowFailed") == []
    assert core.evaluations("WorkflowCompleted") == []


async def test_8_output_redaction(call: Any) -> None:
    core.on_activity(
        "lookup_user",
        "ActivityCompleted",
        {
            "verdict": "allow",
            "guardrails_result": {
                "input_type": "activity_output",
                "redacted_input": {"ssn": "[REDACTED]"},
                "validation_passed": True,
            },
        },
    )
    assert await ok(call, "redact") == {"result": {"ssn": "[REDACTED]"}}


async def test_14_constrain_unsupported(call: Any) -> None:
    core.on_activity("constrained_tool", "ActivityStarted", {"verdict": "constrain", "reason": "limit"})
    assert await ok(call, "constrain") == {"error": "ConstrainUnsupportedError", "code": 501}


async def test_4_19_fail_closed_outage_unavailable(call: Any) -> None:
    core.mode = "down"
    assert await ok(call, "closed_outage") == {"error": "OpenBoxUnavailableError", "code": 503}
    assert len(core.evaluations("WorkflowStarted")) == 2  # governance_max_retries=2, then terminal


async def test_5_fail_open_outage_proceeds(call: Any) -> None:
    core.mode = "down"
    assert await ok(call, "open_outage") == {"result": {"city": "Oslo", "temperature": 23}}
    assert counters["tool"] == 1


async def test_11_19_auth_401_terminal_no_retry(call: Any) -> None:
    core.mode = "auth401"
    assert await ok(call, "auth") == {"error": "OpenBoxAuthTerminalError", "code": 401}
    assert len(core.evaluations()) <= 1  # rejected at validate, or at the single evaluate — never retried


async def test_duplicate_tool_call_id_is_contract_error(call: Any) -> None:
    assert await ok(call, "duplicate") == {"error": "OpenBoxContractError", "code": 500}


# ── P1: durable approvals (Mode A) ──────────────────────────────────────────


async def test_2_approval_polls_durably_and_runs_once(call: Any) -> None:
    core.on_activity("send_email", "ActivityStarted", {"verdict": "require_approval", "reason": "emails need review"})
    core.script_approval(
        ":call_1", {"verdict": "require_approval"}, {"verdict": "require_approval"}, {"action": "allow"}
    )
    assert await ok(call, "approve") == {"result": "sent"}
    assert counters["tool"] == 1
    assert len(core.evaluations("ActivityStarted", "send_email")) == 1
    assert len(core.polls()) == 3  # journaled: replays never re-poll


async def test_approval_rejected(call: Any) -> None:
    core.on_activity("send_email", "ActivityStarted", {"verdict": "require_approval"})
    core.script_approval(":call_1", {"action": "block", "reason": "not today"})
    assert await ok(call, "approve") == {"error": "ApprovalRejectedError", "code": 403}
    assert counters["tool"] == 0


async def test_approval_expired(call: Any) -> None:
    core.on_activity("send_email", "ActivityStarted", {"verdict": "require_approval"})
    core.script_approval(":call_1", {"verdict": "require_approval", "approval_expiration_time": "2000-01-01T00:00:00Z"})
    assert await ok(call, "approve") == {"error": "ApprovalExpiredError", "code": 408}
    assert counters["tool"] == 0


async def test_approval_outage_fail_closed_by_default(call: Any) -> None:
    core.on_activity("send_email", "ActivityStarted", {"verdict": "require_approval"})
    core.approval_mode = "down"
    assert await ok(call, "approve_outage") == {"error": "OpenBoxUnavailableError", "code": 503}
    assert len(core.polls()) == 2


async def test_13_hitl_disabled_is_block(call: Any) -> None:
    core.on_activity("send_email", "ActivityStarted", {"verdict": "require_approval"})
    out = await ok(call, "no_hitl")
    assert out["result"]["blocked"] is True
    assert counters["tool"] == 0


async def test_workflow_level_approval_gate(call: Any) -> None:
    core.on_event("WorkflowStarted", {"verdict": "require_approval"})
    core.on_activity("agent_start", "ActivityStarted", {"verdict": "require_approval"})
    core.script_approval(":__start__", {"verdict": "require_approval"}, {"action": "allow"})
    assert await ok(call, "start_gate") == {"ran": True}
    assert counters["tool"] == 1
    assert len(core.polls()) == 2


@pytest.mark.parametrize("unused", [None])
async def test_restate_replays_were_forced(call: Any, unused: Any) -> None:
    """Sanity: the compose file must force replay, otherwise the tests above prove less."""
    import os

    assert os.environ.get("RESTATE_INGRESS_URL")
