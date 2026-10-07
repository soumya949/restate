"""``@openbox_handler`` — the invocation lifecycle (architecture §6).

Usage (decorator order matters: Restate's decorator is outermost)::

    @agent.handler()
    @openbox_handler(agent_name="billing-agent", prompt_from=lambda req: req.message)
    async def run(ctx: restate.Context, req: Prompt) -> str: ...
"""

from __future__ import annotations

import functools
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

import restate
from openbox_core.contracts.events import EventEnvelope
from restate.exceptions import TerminalError

from .approvals import wait_for_approval
from .context import GovernanceContext, create_governance_context, reset_governance_context
from .enforce import decide, details_of, redacted
from .errors import GovernanceBlockedError, GovernanceHaltError
from .events import (
    activity_started_event,
    error_info_of,
    handoff_event,
    user_prompt_event,
    workflow_completed_event,
    workflow_failed_event,
    workflow_started_event,
)
from .governed_run import halted_error, record_halt
from .ids import END_ACTIVITY_SUFFIX, START_ACTIVITY_SUFFIX, StepNames
from .runtime import OpenBoxRestate, get_default_runtime
from .steps import best_effort, evaluate_step
from .verdict_record import VerdictRecord

F = TypeVar("F", bound=Callable[..., Awaitable[Any]])

_NO_INPUT = object()


def openbox_handler(
    *,
    agent_name: str | None = None,
    prompt_from: Callable[[Any], str | None] | None = None,
    session_id_from: Callable[[Any], str | None] | None = None,
    runtime: OpenBoxRestate | None = None,
    capture_input: bool = True,
    capture_output: bool = True,
) -> Callable[[F], F]:
    """Wrap a Restate handler so its run is governed by OpenBox.

    Python's ``Request`` has no service/handler target, so ``workflow_type`` is
    ``agent_name`` (or config ``agent_name``), falling back to the function's
    qualified name.
    """

    def decorate(fn: F) -> F:
        @functools.wraps(fn)
        async def wrapper(ctx: restate.Context, *args: Any) -> Any:
            rt = runtime or get_default_runtime()
            input = args[0] if args else None
            workflow_type = agent_name or rt.config.restate.agent_name or f"{fn.__module__}.{fn.__qualname__}"
            g, token = create_governance_context(
                ctx,
                rt,
                workflow_type=workflow_type,
                agent_name=agent_name or rt.config.restate.agent_name,
                session_id_from=session_id_from,
                input=input,
            )
            try:
                # 1. Start: WorkflowStarted (+ Handoff when called by a governed parent, + user prompt),
                #    in one journaled step.
                prompt = prompt_from(input) if prompt_from else None

                def start_events(_now: int) -> list[EventEnvelope]:
                    hand = handoff_event(g)
                    return [
                        workflow_started_event(g, StepNames.start, input, capture_input),
                        *([hand] if hand else []),
                        *([user_prompt_event(g, StepNames.start, prompt)] if prompt else []),
                    ]

                start = await evaluate_step(ctx, g, StepNames.start, start_events)
                await _enforce_lifecycle(ctx, g, start, input, "start")

                # 2. User code. A HALT that user code (or a framework) caught, swallowed or wrapped
                #    still ends the invocation with the original HALT.
                try:
                    try:
                        output = await fn(ctx, *args)
                    except Exception as caught:
                        if g.halted:
                            raise halted_error(g) from caught
                        raise
                    if g.halted:
                        raise halted_error(g)
                except TerminalError as err:
                    if isinstance(err, GovernanceHaltError):
                        # Core closed the session on HALT ("Session is no longer active"): nothing more to report.
                        raise
                    err_info = error_info_of(err)
                    await best_effort(
                        "WorkflowFailed",
                        evaluate_step(
                            ctx,
                            g,
                            StepNames.end_failed,
                            lambda _now: [workflow_failed_event(g, StepNames.end_failed, err_info)],
                        ),
                    )
                    raise
                # Non-terminal exceptions propagate untouched: Restate retries, nothing is reported.

                # 3. End: output guardrails may redact or block the returned value.
                end = await evaluate_step(
                    ctx,
                    g,
                    StepNames.end,
                    lambda _now: [workflow_completed_event(g, StepNames.end, output, capture_output)],
                )
                await _enforce_lifecycle(ctx, g, end, output, "end")
                return redacted(end, output, "output")
            finally:
                reset_governance_context(token)

        return wrapper  # type: ignore[return-value]

    return decorate


async def _enforce_lifecycle(
    ctx: restate.Context, g: GovernanceContext, record: VerdictRecord, payload: Any, phase: str
) -> None:
    d = decide(record, g.rt.config.restate.hitl_enabled)
    if d.kind == "proceed":
        return
    if d.kind == "halt":
        raise record_halt(g, GovernanceHaltError(d.reason, **details_of(record)))
    if d.kind == "blocked":
        raise GovernanceBlockedError(d.reason, **details_of(record))
    # Workflow-level REQUIRE_APPROVAL: start = gate before user code; end = output review.
    if phase == "start":
        await _approval_gate(ctx, g, START_ACTIVITY_SUFFIX, "agent_start", payload)
    else:
        await _approval_gate(ctx, g, END_ACTIVITY_SUFFIX, "agent_output", payload)


async def _approval_gate(
    ctx: restate.Context, g: GovernanceContext, suffix: str, activity_type: str, payload: Any
) -> None:
    """The base SDK only polls approvals that have an activity_id: re-send as a pollable ActivityStarted."""
    aid = f"{g.workflow_id}:{suffix}"
    step = StepNames.pre(aid)
    gate = await evaluate_step(
        ctx,
        g,
        step,
        lambda _now: [activity_started_event(g, step, activity_id=aid, activity_type=activity_type, input=payload)],
    )
    d = decide(gate, g.rt.config.restate.hitl_enabled)
    if d.kind == "halt":
        raise record_halt(g, GovernanceHaltError(d.reason, **details_of(gate)))
    if d.kind == "blocked":
        raise GovernanceBlockedError(d.reason, **details_of(gate))
    if d.kind == "approval":
        await wait_for_approval(ctx, g, aid, gate)
