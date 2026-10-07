"""``governed_run`` — the core algorithm (architecture §7.2).

PRE     ctx.run_typed("openbox:pre:<id>")   → ActivityStarted  → VerdictRecord  [journaled]
ENFORCE halt → raise | block → return Blocked | approval → durable wait
EXECUTE the real tool, exactly-once recorded by its own ctx.run_typed
POST    ctx.run_typed("openbox:post:<id>")  → ActivityCompleted → VerdictRecord [journaled]
ENFORCE output guardrails / halt / block / output-review approval
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from contextlib import nullcontext
from dataclasses import dataclass
from typing import Any, Literal, TypeVar

import restate
from restate.exceptions import TerminalError

from .approvals import wait_for_approval
from .context import GovernanceContext, require_governance_context
from .enforce import decide, details_of, redacted
from .errors import GovernanceBlockedError, GovernanceHaltError, hook_verdict_of
from .events import activity_completed_event, activity_started_event, error_info_of
from .ids import StepNames, activity_id_for
from .runtime import SpanScopeInfo
from .steps import best_effort, evaluate_step
from .verdict_record import VerdictRecord

I = TypeVar("I")  # noqa: E741
O = TypeVar("O")  # noqa: E741


@dataclass(frozen=True)
class Blocked:
    """Returned (never raised, by default) when OpenBox blocks a step. Feed ``str(blocked)`` to the LLM."""

    reason: str
    policy_id: str | None = None
    governance_event_id: str | None = None
    blocked: bool = True

    def __str__(self) -> str:
        return f"Blocked by policy: {self.reason}"


def is_blocked(value: Any) -> bool:
    return isinstance(value, Blocked)


def _blocked_or_raise(r: VerdictRecord, reason: str, on_block: str) -> Blocked:
    if on_block == "raise":
        raise GovernanceBlockedError(reason, **details_of(r))
    return Blocked(reason, r["policyId"], r["governanceEventId"])


def _halt(g: GovernanceContext, r: VerdictRecord, reason: str) -> GovernanceHaltError:
    g.halted = True
    return GovernanceHaltError(reason, **details_of(r))


async def governed_run(
    ctx: restate.Context,
    name: str,
    fn: Callable[[Any], Awaitable[O]],
    *,
    input: Any = None,
    tool_call_id: str | None = None,
    type: str | None = None,
    agent_id: str | None = None,
    wrap_in_run: bool = False,
    on_block: Literal["return", "raise"] = "return",
) -> O | Blocked:
    """Govern one side-effecting step.

    ``fn(input)`` must journal its own side effect (``ctx.run_typed``) unless
    ``wrap_in_run=True`` — use that ONLY when ``fn`` does not use ``ctx`` itself.
    """
    g = require_governance_context()
    if g.halted:
        raise GovernanceHaltError("session was halted earlier in this invocation")
    cfg = g.rt.config.restate
    aid = activity_id_for(g, name, tool_call_id)
    semantic_type = type or cfg.tool_type_map.get(name)

    pre_step = StepNames.pre(aid)
    pre = await evaluate_step(
        ctx,
        g,
        pre_step,
        lambda: [
            activity_started_event(
                g,
                pre_step,
                activity_id=aid,
                activity_type=name,
                input=input,
                semantic_type=semantic_type,
                agent_id=agent_id,
            )
        ],
    )
    d = decide(pre, cfg.hitl_enabled)
    if d.kind == "halt":
        raise _halt(g, pre, d.reason)
    if d.kind == "blocked":
        return _blocked_or_raise(pre, d.reason, on_block)
    if d.kind == "approval":
        await wait_for_approval(ctx, g, aid, pre)
    effective_input = redacted(pre, input, "input")

    # EXECUTE — with span capture on, the tool runs inside an activity scope so its
    # HTTP/DB/file calls are reported as spans of this activity (never on replay).
    binder = g.rt.span_binder
    scope = (
        binder.scope(
            SpanScopeInfo(
                workflow_id=g.workflow_id,
                run_id=g.run_id,
                workflow_type=g.workflow_type,
                activity_id=aid,
                activity_type=name,
                agent_name=g.agent_name,
                session_id=g.session_id,
                multi_agent_session_id=g.multi_agent_session_id,
            )
        )
        if binder
        else nullcontext()
    )
    try:
        with scope:
            if wrap_in_run:

                async def action() -> Any:
                    return await fn(effective_input)

                result: Any = await ctx.run_typed(name, action)
            else:
                result = await fn(effective_input)
    except TerminalError as err:
        err_info = error_info_of(err)
        hook = hook_verdict_of(err)
        failed_step = StepNames.post_failed(aid)
        await best_effort(
            f"ActivityCompleted(failed) for {name}",
            evaluate_step(
                ctx,
                g,
                failed_step,
                lambda: [
                    activity_completed_event(
                        g, failed_step, activity_id=aid, activity_type=name, status="failed", error=err_info
                    )
                ],
            ),
        )
        if hook is not None:
            # A span preflight stopped the tool before its HTTP/DB/file call went out.
            kind, reason, policy_id = hook
            r: VerdictRecord = {
                **pre,
                "verdict": "halt" if kind == "hook_halt" else "block",
                "reason": reason,
                "policyId": policy_id,
                "governanceEventId": None,
            }
            if kind == "hook_halt":
                raise _halt(g, r, reason) from err
            return _blocked_or_raise(r, reason, on_block)
        raise
    # A completed-span HALT (the call already went out) stops the session from here on.
    # Only seen on the attempt that really executed the tool; a crash right here loses it.
    if binder is not None and binder.is_halt_requested(g.workflow_id, g.run_id):
        raise _halt(g, pre, "a span of this step was halted by policy")

    post_step = StepNames.post(aid)
    post = await evaluate_step(
        ctx,
        g,
        post_step,
        lambda: [
            activity_completed_event(
                g, post_step, activity_id=aid, activity_type=name, status="completed", result=result
            )
        ],
    )
    pd = decide(post, cfg.hitl_enabled)
    if pd.kind == "halt":
        raise _halt(g, post, pd.reason)
    if pd.kind == "blocked":
        return _blocked_or_raise(post, pd.reason, on_block)
    if pd.kind == "approval":
        await wait_for_approval(ctx, g, aid, post, step_key=f"{aid}:post")
    return redacted(post, result, "output")  # type: ignore[no-any-return]


async def governed_call(
    ctx: restate.Context,
    *,
    tool_name: str,
    run: Callable[[Any], Awaitable[O]],
    tool_call_id: str | None = None,
    arguments: Any = None,
    type: str | None = None,
    agent_id: str | None = None,
    wrap_in_run: bool = False,
    on_block: Literal["return", "raise"] = "return",
) -> O | Blocked:
    """``governed_run`` shaped for the raw ``for tool_call in response.tool_calls`` loop."""
    return await governed_run(
        ctx,
        tool_name,
        run,
        input=arguments,
        tool_call_id=tool_call_id,
        type=type,
        agent_id=agent_id,
        wrap_in_run=wrap_in_run,
        on_block=on_block,
    )
