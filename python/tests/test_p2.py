"""P2 (architecture §22.4): OpenAI Agents SDK wrappers, multi-agent (scenario 10) and parallel tool
calls (scenario 9), against a real Restate server that replays after every suspension."""

from __future__ import annotations

from typing import Any

from .conftest import requires_restate
from .p2_app import PARENT_DID, agent_core, child_core, parent_core, ran

pytestmark = requires_restate


async def ok(call: Any, handler: str, body: Any = None) -> Any:
    r = await call(handler, body)
    assert r.status_code == 200, r.text
    return r.json()


# ── OpenAI Agents SDK ────────────────────────────────────────────────────────


async def test_govern_agent_governs_tool_keyed_by_call_id_exactly_once(call: Any) -> None:
    out = await ok(call, "oai/run", "weather")
    assert "Paris" in out
    assert ran == ["weather:Paris"]
    started = agent_core.evaluations("ActivityStarted", "get_weather")
    assert len(started) == 1
    assert started[0].activity_id and started[0].activity_id.endswith(":call_w1")
    assert started[0].body["activity_input"] == [{"city": "Paris"}]
    assert started[0].body.get("agent_id") == "MailAgent"
    assert len(agent_core.evaluations("ActivityCompleted", "get_weather")) == 1
    assert len(agent_core.evaluations("WorkflowCompleted")) == 1


async def test_block_goes_back_to_the_model_as_the_tool_output(call: Any) -> None:
    agent_core.on_activity("delete_records", "ActivityStarted", {"verdict": "block", "reason": "no deletes"})
    out = await ok(call, "oai/run", "delete")
    assert "Blocked by policy: no deletes" in out
    assert ran == []
    assert agent_core.evaluations("ActivityStarted", "delete_records")[0].body.get("type") == "DATABASE_WRITE"


async def test_halt_ends_the_invocation_not_retried_by_the_agents_sdk(call: Any) -> None:
    agent_core.on_activity("wire_money", "ActivityStarted", {"verdict": "halt", "reason": "fraud"})
    r = await call("oai/run", "wire")
    assert r.status_code == 403, r.text
    assert "OpenBox HALT: fraud" in r.text
    assert ran == []
    # One pre-check: the HALT was terminal, not wrapped into a retryable UserError.
    assert len(agent_core.evaluations("ActivityStarted", "wire_money")) == 1
    assert len(agent_core.evaluations("WorkflowFailed")) == 1


async def test_durable_approval_inside_an_agents_sdk_tool(call: Any) -> None:
    agent_core.on_activity("send_email", "ActivityStarted", {"verdict": "require_approval", "reason": "review"})
    agent_core.script_approval("call_e1", {"verdict": "require_approval"}, {"verdict": "allow"})
    out = await ok(call, "oai/run", "email")
    assert "sent" in out
    assert ran == ["email:bob@example.com"]
    started = agent_core.evaluations("ActivityStarted", "send_email")
    assert len(started) == 1
    assert started[0].body.get("type") == "EMAIL_SEND"  # governed_function_tool(type=...)
    assert len(agent_core.polls()) == 2


async def test_two_tool_calls_in_one_turn_governed_in_call_order(call: Any) -> None:
    out = await ok(call, "oai/run", "both")
    assert "Rome" in out and "Oslo" in out
    ids = [
        e.activity_id.split(":")[-1] for e in agent_core.evaluations("ActivityStarted", "get_weather") if e.activity_id
    ]
    assert ids == ["call_b1", "call_b2"]


# ── scenario 10: parent → child over Restate RPC ─────────────────────────────


async def test_child_joins_parent_session_and_sends_handoff(call: Any) -> None:
    out = await ok(call, "lead/delegate", "tides")
    assert out == {"result": "facts about tides"}
    assert ran == ["search:tides"]

    parent_start = parent_core.evaluations("WorkflowStarted")[0]
    delegation = parent_core.evaluations("ActivityStarted", "call:research")
    assert len(delegation) == 1
    assert delegation[0].body["__openbox"] == {"tool_type": "a2a", "subagent_name": "research"}

    child_start = child_core.evaluations("WorkflowStarted")
    assert len(child_start) == 1
    c = child_start[0].body
    assert c["multi_agent_session_id"] == parent_start.body["multi_agent_session_id"]
    assert c["parent_workflow_id"] == parent_start.workflow_id
    assert c["parent_activity_id"] == delegation[0].activity_id

    handoffs = child_core.evaluations("Handoff")
    assert len(handoffs) == 1
    assert handoffs[0].body["from_agent_did"] == PARENT_DID
    assert parent_core.evaluations("Handoff") == []


async def test_blocked_delegation_never_invokes_the_child(call: Any) -> None:
    parent_core.on_activity("call:research", "ActivityStarted", {"verdict": "block", "reason": "no delegation"})
    out = await ok(call, "lead/delegate", "tides")
    assert out == {"blocked": True, "reason": "no delegation"}
    assert child_core.ledger == []


# ── scenario 9: parallel tool calls ──────────────────────────────────────────


async def test_parallel_pre_checks_in_call_order_results_in_call_order(call: Any) -> None:
    parent_core.on_activity("delete_records", "ActivityStarted", {"verdict": "block", "reason": "no deletes"})
    out = await ok(call, "lead/parallel")
    assert out == [{"arg": "Rome"}, "blocked:no deletes", {"arg": "Oslo"}]
    assert sorted(ran) == ["weather:Oslo", "weather:Rome"]

    def order(event_type: str) -> list[str]:
        return [
            e.activity_id.split(":")[-1] for e in parent_core.ledger if e.event_type == event_type and e.activity_id
        ]

    assert order("ActivityStarted") == ["p1", "p2", "p3"]
    assert order("ActivityCompleted") == ["p1", "p3"]
