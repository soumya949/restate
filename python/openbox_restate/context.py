"""Per-invocation governance context (architecture §3.4, §4).

Rebuilt on every attempt from invocation-constant inputs only. Stored in a
ContextVar so framework wrappers (which only see ``restate_context()``) can
find it.
"""

from __future__ import annotations

import contextvars
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .errors import GovernanceHaltError, OpenBoxContractError

if TYPE_CHECKING:
    import restate

    from .runtime import OpenBoxRestate

HEADER_MULTI_AGENT_SESSION_ID = "x-openbox-multi-agent-session-id"
HEADER_PARENT_WORKFLOW_ID = "x-openbox-parent-workflow-id"
HEADER_PARENT_ACTIVITY_ID = "x-openbox-parent-activity-id"
HEADER_PARENT_AGENT_DID = "x-openbox-parent-agent-did"


@dataclass
class GovernanceContext:
    rt: OpenBoxRestate
    workflow_id: str
    run_id: str
    workflow_type: str
    session_id: str
    multi_agent_session_id: str
    parent_workflow_id: str | None
    parent_activity_id: str | None
    #: Parent agent's DID (informational; the child sends Handoff with it, never trusted for auth).
    parent_agent_did: str | None
    agent_name: str | None
    key: str | None
    scope: str | None
    limit_key: str | None
    halted: bool = False
    #: The HALT that was raised, re-raised by later short-circuits so the real reason and policy survive.
    halt_error: GovernanceHaltError | None = None
    name_counters: dict[str, int] = field(default_factory=dict)
    used_activity_ids: set[str] = field(default_factory=set)
    vobj_warning_logged: bool = False


_current: contextvars.ContextVar[GovernanceContext | None] = contextvars.ContextVar(
    "openbox_restate_governance_context", default=None
)


def _header(headers: dict[str, str], name: str) -> str | None:
    for k, v in headers.items():
        if k.lower() == name:
            return v
    return None


def _key_of(ctx: restate.Context) -> str | None:
    """Python's ``ctx.key()`` is safe on every handler kind (empty for plain services)."""
    key_fn = getattr(ctx, "key", None)
    if key_fn is None:
        return None
    try:
        k = key_fn()
    except Exception:  # noqa: BLE001
        return None
    return k or None


def create_governance_context(
    ctx: restate.Context,
    rt: OpenBoxRestate,
    *,
    workflow_type: str,
    agent_name: str | None,
    session_id_from: Callable[[Any], str | None] | None,
    input: Any,
) -> tuple[GovernanceContext, contextvars.Token[GovernanceContext | None]]:
    req = ctx.request()
    workflow_id = str(req.id)
    headers = dict(req.headers or {})
    key = _key_of(ctx)
    if key is not None:
        session_id = f"{workflow_type}/{key}"
    else:
        session_id = (session_id_from(input) if session_id_from else None) or workflow_id
    g = GovernanceContext(
        rt=rt,
        workflow_id=workflow_id,
        run_id=workflow_id,
        workflow_type=workflow_type,
        session_id=session_id,
        multi_agent_session_id=_header(headers, HEADER_MULTI_AGENT_SESSION_ID) or f"mas:{workflow_id}",
        parent_workflow_id=_header(headers, HEADER_PARENT_WORKFLOW_ID),
        parent_activity_id=_header(headers, HEADER_PARENT_ACTIVITY_ID),
        parent_agent_did=_header(headers, HEADER_PARENT_AGENT_DID),
        agent_name=agent_name,
        key=key,
        scope=getattr(req, "scope", None),
        limit_key=getattr(req, "limit_key", None),
    )
    token = _current.set(g)
    return g, token


def reset_governance_context(token: contextvars.Token[GovernanceContext | None]) -> None:
    try:
        _current.reset(token)
    except ValueError:
        _current.set(None)


def current_governance_context() -> GovernanceContext | None:
    return _current.get()


def require_governance_context() -> GovernanceContext:
    g = _current.get()
    if g is None:
        raise OpenBoxContractError(
            "governed_run/governed_call used outside an openbox_handler-wrapped handler. "
            "Decorate the handler with @openbox_handler(...)."
        )
    return g
