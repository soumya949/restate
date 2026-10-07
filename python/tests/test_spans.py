"""Span capture (``openbox_restate.instrumentation``) against a real Restate server that replays after
every suspension. Mirrors typescript/test/restate/spans.test.ts."""

from __future__ import annotations

from typing import Any

from .app import api_hits, core, spans_handle
from .conftest import requires_restate
from .fake_core import LedgerEntry

pytestmark = requires_restate


def hook_evals(activity_type: str) -> list[LedgerEntry]:
    return [e for e in core.evaluations("ActivityStarted", activity_type) if e.body.get("hook_trigger") is True]


def stages(entries: list[LedgerEntry]) -> list[Any]:
    return [e.body["spans"][0].get("stage") for e in entries]


async def tool(call: Any, name: str) -> Any:
    r = await call("spans/tool", name)
    return r


def test_installs_httpx() -> None:
    assert "httpx" in spans_handle.installed_targets


async def test_http_call_reported_as_started_and_completed_spans_exactly_once(call: Any) -> None:
    r = await tool(call, "get_weather")
    assert r.status_code == 200, r.text
    assert r.json() == {"blocked": False, "result": {"ok": True}}
    assert api_hits["n"] == 1

    hooks = hook_evals("get_weather")
    assert stages(hooks) == ["started", "completed"]
    started = core.evaluations("ActivityStarted", "get_weather")
    activity = next(e for e in started if e.body.get("hook_trigger") is not True)
    for h in hooks:
        # Same correlation as the activity, so OpenBox nests the span under it.
        assert h.activity_id == activity.activity_id
        assert h.workflow_id == activity.workflow_id
        span = h.body["spans"][0]
        assert span["hook_type"] == "http_request"
        assert "/v1/get_weather" in str(span.get("http_url"))
    # OpenBox's own governance calls are never reported as spans.
    assert not [e for e in core.evaluations() if "8787" in str(e.body.get("spans", ""))]


async def test_span_block_stops_the_call_and_returns_blocked(call: Any) -> None:
    core.rule(
        lambda b: {"verdict": "block", "reason": "no deletes over HTTP"}
        if b.get("hook_trigger") is True and b.get("activity_type") == "delete_records"
        else None
    )
    r = await tool(call, "delete_records")
    assert r.status_code == 200, r.text
    blocked = {"blocked": True, "reason": "no deletes over HTTP", "policy_id": None}
    assert r.json() == {"blocked": True, "result": blocked}
    assert api_hits["n"] == 0
    assert stages(hook_evals("delete_records")) == ["started"]
    assert [e.body.get("status") for e in core.evaluations("ActivityCompleted", "delete_records")] == ["failed"]


async def test_span_halt_ends_the_invocation(call: Any) -> None:
    core.rule(
        lambda b: {"verdict": "halt", "reason": "fraud"}
        if b.get("hook_trigger") is True and b.get("activity_type") == "wire_money"
        else None
    )
    r = await tool(call, "wire_money")
    assert r.status_code == 403
    assert "OpenBox HALT: fraud" in r.text
    assert api_hits["n"] == 0
    assert stages(hook_evals("wire_money")) == ["started"]


async def test_approved_activity_spans_pass_the_same_approval_rule(call: Any) -> None:
    # Like a dashboard rule "activity_type = send_email AND event_type = ActivityStarted": it matches the spans too.
    core.on_activity("send_email", "ActivityStarted", {"verdict": "require_approval", "reason": "email needs review"})
    # Live Core reports the span's own approval as still pending after the activity was approved:
    # the first poll (the activity wait) says allow, every later poll says pending.
    core.script_approval("call_1", {"verdict": "allow", "reason": "approved"}, {"verdict": "require_approval"})
    r = await tool(call, "send_email")
    assert r.status_code == 200, r.text
    assert r.json() == {"blocked": False, "result": {"ok": True}}
    assert api_hits["n"] == 1
    assert stages(hook_evals("send_email")) == ["started", "completed"]
    assert len(core.polls()) == 1  # the span never asked again


async def test_span_only_approval_on_unapproved_activity_fails_safe_as_block(call: Any) -> None:
    core.rule(
        lambda b: {"verdict": "require_approval", "reason": "review uploads"}
        if b.get("hook_trigger") is True and b.get("activity_type") == "upload"
        else None
    )
    r = await tool(call, "upload")
    assert r.status_code == 200, r.text
    assert r.json()["blocked"] is True
    assert api_hits["n"] == 0
