"""Multi-agent (architecture §12): one OpenBox Multi-Agent Session across Restate RPC.

Parent::

    report = await governed_sub_agent(
        ctx, agent_name="research", input=task, tool_call_id=call_id,
        invoke=lambda t, headers: ctx.service_call(research_run, arg=t, headers=headers),
    )

Child: a normal ``@openbox_handler``. It reads the headers, joins the parent's
``multi_agent_session_id``, links ``parent_workflow_id`` / ``parent_activity_id``,
and (when the parent has a DID) sends the ``Handoff`` event with its own signed
client, so Core links the two agents.

Headers are never propagated automatically by Restate: pass them explicitly.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Literal

import restate

from .context import (
    HEADER_MULTI_AGENT_SESSION_ID,
    HEADER_PARENT_ACTIVITY_ID,
    HEADER_PARENT_AGENT_DID,
    HEADER_PARENT_WORKFLOW_ID,
    require_governance_context,
)
from .governed_run import Blocked, _resolve_blocked, finish_phase, pre_phase, run_tool

__all__ = ["child_headers", "governed_sub_agent"]


def child_headers(parent_activity_id: str | None = None) -> dict[str, str]:
    """The four ``x-openbox-*`` headers that make a child invocation part of this agent's
    Multi-Agent Session. ``parent_activity_id`` is the governing activity of the call
    (``governed_sub_agent`` passes it for you)."""
    g = require_governance_context()
    headers = {
        HEADER_MULTI_AGENT_SESSION_ID: g.multi_agent_session_id,
        HEADER_PARENT_WORKFLOW_ID: g.workflow_id,
    }
    if parent_activity_id:
        headers[HEADER_PARENT_ACTIVITY_ID] = parent_activity_id
    did = g.rt.config.base.agent_did
    if did:
        headers[HEADER_PARENT_AGENT_DID] = did
    return headers


async def governed_sub_agent(
    ctx: restate.Context,
    *,
    agent_name: str,
    invoke: Callable[[Any, dict[str, str]], Awaitable[Any]],
    input: Any = None,
    tool_call_id: str | None = None,
    type: str | None = "AGENT_ACTION",
    on_block: Literal["return", "raise"] = "return",
) -> Any | Blocked:
    """Govern a call to another governed agent.

    The delegation itself is an activity (``call:<agent_name>``, ``__openbox.tool_type = "a2a"``),
    so policies can block, halt or require approval for it; ``invoke(input, headers)`` receives
    the headers that put the child in this session.
    """
    g = require_governance_context()
    p = await pre_phase(
        ctx,
        g,
        f"call:{agent_name}",
        input=input,
        tool_call_id=tool_call_id,
        type=type,
        extra={"__openbox": {"tool_type": "a2a", "subagent_name": agent_name}},
    )
    if p.blocked is not None:
        return _resolve_blocked(p, on_block)
    outcome = await run_tool(ctx, g, p, lambda i: invoke(i, child_headers(p.aid)))
    return await finish_phase(ctx, g, p, outcome, on_block=on_block)
