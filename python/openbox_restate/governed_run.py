"""``governed_run`` — the core algorithm (architecture §7.2).

PRE     ctx.run_typed("openbox:pre:<id>")   → ActivityStarted  → VerdictRecord  [journaled]
ENFORCE halt → raise | block → return Blocked | approval → durable wait
EXECUTE the real tool, exactly-once recorded by its own ctx.run_typed
POST    ctx.run_typed("openbox:post:<id>")  → ActivityCompleted → VerdictRecord [journaled]
ENFORCE output guardrails / halt / block / output-review approval
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
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
    return record_halt(g, GovernanceHaltError(reason, **details_of(r)))


def record_halt(g: GovernanceContext, e: GovernanceHaltError) -> GovernanceHaltError:
    """Mark the session halted and remember why. Returns the error for ``raise``."""
    g.halted = True
    if g.halt_error is None:
        g.halt_error = e
    return e


def halted_error(g: GovernanceContext) -> GovernanceHaltError:
    """The error to raise when the session was halted earlier (e.g. a framework swallowed the original)."""
    return g.halt_error or GovernanceHaltError("session was halted earlier in this invocation")


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
    p = await pre_phase(ctx, g, name, input=input, tool_call_id=tool_call_id, type=type, agent_id=agent_id)
    if p.blocked is not None:
        return _resolve_blocked(p, on_block)
    outcome = await run_tool(ctx, g, p, fn, wrap_in_run=wrap_in_run)
    return await finish_phase(ctx, g, p, outcome, on_block=on_block)  # type: ignore[no-any-return]


@dataclass
class Prepared:
    """An approved step, ready to run (or a PRE block still to resolve). Internal."""

    name: str
    aid: str
    input: Any
    pre: VerdictRecord
    blocked: tuple[VerdictRecord, str] | None = None
    #: A human approved this activity (durably, before it ran).
    approved: bool = False


@dataclass
class Outcome:
    """What running the tool produced. Internal."""

    result: Any = None
    error: Exception | None = None


def _resolve_blocked(p: Prepared, on_block: str) -> Blocked:
    assert p.blocked is not None
    r, reason = p.blocked
    return _blocked_or_raise(r, reason, on_block)


async def pre_phase(
    ctx: restate.Context,
    g: GovernanceContext,
    name: str,
    *,
    input: Any,
    tool_call_id: str | None,
    type: str | None = None,
    agent_id: str | None = None,
    extra: dict[str, Any] | None = None,
) -> Prepared:
    """PRE — journaled decision on the input, then halt / block / durable approval wait."""
    if g.halted:
        raise halted_error(g)
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
                extra=extra,
            )
        ],
    )
    d = decide(pre, cfg.hitl_enabled)
    if d.kind == "halt":
        raise _halt(g, pre, d.reason)
    if d.kind == "blocked":
        return Prepared(name, aid, input, pre, blocked=(pre, d.reason))
    if d.kind == "approval":
        await wait_for_approval(ctx, g, aid, pre)
    return Prepared(name, aid, redacted(pre, input, "input"), pre, approved=d.kind == "approval")


async def run_tool(
    ctx: restate.Context,
    g: GovernanceContext,
    p: Prepared,
    fn: Callable[[Any], Awaitable[Any]],
    *,
    wrap_in_run: bool = False,
) -> Outcome:
    """EXECUTE — the real side effect. Exceptions are captured, not raised, so parallel
    executions can be reported in a fixed order by ``finish_phase``. With span capture on,
    the tool runs inside an activity scope so its HTTP/DB/file calls are reported as spans
    of this activity (never on replay)."""
    binder = g.rt.span_binder
    scope = (
        binder.scope(
            SpanScopeInfo(
                workflow_id=g.workflow_id,
                run_id=g.run_id,
                workflow_type=g.workflow_type,
                activity_id=p.aid,
                activity_type=p.name,
                agent_name=g.agent_name,
                session_id=g.session_id,
                multi_agent_session_id=g.multi_agent_session_id,
                approved=p.approved,
            )
        )
        if binder
        else nullcontext()
    )
    try:
        with scope:
            if wrap_in_run:

                async def action() -> Any:
                    return await fn(p.input)

                return Outcome(result=await ctx.run_typed(p.name, action))
            return Outcome(result=await fn(p.input))
    except Exception as err:  # BaseException (cancellation / suspension) passes through untouched
        return Outcome(error=err)


async def finish_phase(
    ctx: restate.Context,
    g: GovernanceContext,
    p: Prepared,
    outcome: Outcome,
    *,
    on_block: str = "return",
) -> Any:
    """Report a failed execution, or POST — journaled decision on the output."""
    name, aid, pre = p.name, p.aid, p.pre
    err = outcome.error
    if err is not None:
        if not isinstance(err, TerminalError):
            raise err  # non-terminal: Restate's retry policy handles it, nothing is reported yet
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
        raise err
    result = outcome.result
    # A completed-span HALT (the call already went out) stops the session from here on.
    # Only seen on the attempt that really executed the tool; a crash right here loses it.
    binder = g.rt.span_binder
    if binder is not None and binder.is_halt_requested(g.workflow_id, g.run_id):
        raise _halt(g, pre, "a span of this step was halted by policy")

    cfg = g.rt.config.restate
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
    return redacted(post, result, "output")


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


@dataclass(frozen=True)
class ParallelCall:
    """One call for :func:`governed_parallel`."""

    tool_name: str
    run: Callable[[Any], Awaitable[Any]]
    arguments: Any = None
    tool_call_id: str | None = None
    type: str | None = None
    agent_id: str | None = None


async def governed_parallel(
    ctx: restate.Context,
    calls: Sequence[ParallelCall],
    *,
    on_block: Literal["return", "raise"] = "return",
) -> list[Any]:
    """Govern several tool calls whose executions may run concurrently (architecture §11.3).

    1. pre-checks one at a time, in call order (approvals are waited for here);
    2. the approved tools all run concurrently;
    3. post-checks one at a time, in call order.

    Phases 1 and 3 are sequential because a journal entry created in completion order would not
    replay deterministically. Results come back in call order; a blocked call yields ``Blocked``.
    """
    g = require_governance_context()
    prepared = [
        await pre_phase(
            ctx, g, c.tool_name, input=c.arguments, tool_call_id=c.tool_call_id, type=c.type, agent_id=c.agent_id
        )
        for c in calls
    ]

    async def skipped() -> Outcome:
        return Outcome()

    # Every tool starts here, in call order, so its own journal entries are created in that order.
    outcomes = await asyncio.gather(
        *(skipped() if p.blocked else run_tool(ctx, g, p, c.run) for p, c in zip(prepared, calls, strict=True))
    )
    results: list[Any] = []
    for p, outcome in zip(prepared, outcomes, strict=True):
        if p.blocked:
            results.append(_resolve_blocked(p, on_block))
        else:
            results.append(await finish_phase(ctx, g, p, outcome, on_block=on_block))
    return results
