"""Event builders (architecture §5.4) — thin wrappers over ``openbox_core`` factories.

Called INSIDE governance actions, so the timestamp the gate stamps is part of
the journaled side effect.

Note: ``openbox_core.contracts.events.activity_completed(result=...)`` emits the
wire field ``result``, while the TypeScript base SDK and the Temporal SDK (in
production) send ``activity_output``. We send ``activity_output`` so both
languages of this SDK produce identical events.
"""

from __future__ import annotations

import json
import traceback
from typing import Any

from openbox_core.contracts.events import (
    EventEnvelope,
    activity_completed,
    activity_started,
    handoff,
    signal_received,
    workflow_completed,
    workflow_failed,
    workflow_started,
)
from restate.exceptions import TerminalError

from .context import GovernanceContext


def to_json(value: Any) -> Any:
    """JSON-safe copy (pydantic models / dataclasses / sets become plain JSON)."""
    if value is None:
        return None
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        try:
            return dump(mode="json")
        except Exception:  # noqa: BLE001
            pass
    try:
        return json.loads(json.dumps(value, default=_default))
    except Exception:  # noqa: BLE001
        return str(value)


def _default(o: Any) -> Any:
    dump = getattr(o, "model_dump", None)
    if callable(dump):
        return dump(mode="json")
    if hasattr(o, "__dataclass_fields__"):
        return {k: getattr(o, k) for k in o.__dataclass_fields__}
    if isinstance(o, set | frozenset):
        return sorted(o, key=str)
    return str(o)


def _extra(g: GovernanceContext, step_name: str, more: dict[str, Any] | None = None) -> dict[str, Any]:
    restate_info: dict[str, Any] = {"invocation_id": g.workflow_id}
    if g.key is not None:
        restate_info["key"] = g.key
    if g.scope:
        restate_info["scope"] = g.scope
    if g.limit_key:
        restate_info["limit_key"] = g.limit_key
    extra: dict[str, Any] = {
        "session_id": g.session_id,
        "restate": restate_info,
        "openbox_restate_event_key": f"{g.workflow_id}/{step_name}",
    }
    if g.agent_name:
        extra["agent_name"] = g.agent_name
    if g.parent_workflow_id:
        extra["parent_workflow_id"] = g.parent_workflow_id
    if g.parent_activity_id:
        extra["parent_activity_id"] = g.parent_activity_id
    if more:
        extra.update(more)
    return extra


def _base(g: GovernanceContext, step_name: str, more: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "workflow_id": g.workflow_id,
        "run_id": g.run_id,
        "workflow_type": g.workflow_type,
        "multi_agent_session_id": g.multi_agent_session_id,
        "extra": _extra(g, step_name, more),
    }


def workflow_started_event(g: GovernanceContext, step: str, input: Any, capture_input: bool) -> EventEnvelope:
    return workflow_started(**_base(g, step, {"activity_input": [to_json(input)]} if capture_input else None))


def handoff_event(g: GovernanceContext) -> EventEnvelope | None:
    """Multi-agent Handoff, sent by the CHILD (architecture §12.2): Core takes the receiving agent
    from the signed identity of the sender, so the child's own client sends from_agent_did = parent DID."""
    if not g.parent_agent_did or not g.parent_workflow_id:
        return None
    return handoff(from_agent_did=g.parent_agent_did, multi_agent_session_id=g.multi_agent_session_id)


def user_prompt_event(g: GovernanceContext, step: str, prompt: str) -> EventEnvelope:
    return signal_received(signal_name="user_prompt", **_base(g, step, {"signal_args": [prompt]}))


def activity_started_event(
    g: GovernanceContext,
    step: str,
    *,
    activity_id: str,
    activity_type: str,
    input: Any,
    semantic_type: str | None = None,
    agent_id: str | None = None,
    extra: dict[str, Any] | None = None,
) -> EventEnvelope:
    more: dict[str, Any] = dict(extra or {})
    if semantic_type:
        more["type"] = semantic_type
    if agent_id:
        more["agent_id"] = agent_id
    return activity_started(
        activity_id=activity_id,
        activity_type=activity_type,
        activity_input=[to_json(input)],
        **_base(g, step, more),
    )


def activity_completed_event(
    g: GovernanceContext,
    step: str,
    *,
    activity_id: str,
    activity_type: str,
    status: str,
    result: Any = None,
    error: dict[str, Any] | None = None,
    duration_ms: int | None = None,
    extra: dict[str, Any] | None = None,
) -> EventEnvelope:
    more: dict[str, Any] = {**(extra or {}), "status": status}
    if status == "completed":
        more["activity_output"] = to_json(result)
    if duration_ms is not None:
        more["duration_ms"] = max(0, duration_ms)  # Core shows it as latency
    return activity_completed(
        activity_id=activity_id,
        activity_type=activity_type,
        error=error,
        **_base(g, step, more),
    )


def workflow_completed_event(g: GovernanceContext, step: str, output: Any, capture_output: bool) -> EventEnvelope:
    return workflow_completed(**_base(g, step, {"workflow_output": to_json(output)} if capture_output else None))


def workflow_failed_event(g: GovernanceContext, step: str, error: dict[str, Any]) -> EventEnvelope:
    return workflow_failed(error=error, **_base(g, step))


def error_info_of(e: BaseException) -> dict[str, Any]:
    """Structured error object Core requires (a bare string is rejected with HTTP 400)."""
    if isinstance(e, TerminalError) and e.status_code == 409:
        return {"type": "Cancelled", "message": e.message}
    info: dict[str, Any] = {"type": type(e).__name__, "message": str(e)}
    tb = "".join(traceback.format_exception(e))
    if tb:
        info["stack_trace"] = tb
    if isinstance(e, TerminalError):
        info["non_retryable"] = True
    return info
