"""LLM call telemetry: what feeds OpenBox's Model Usage, Cost and "LLM Calls".

Each model call is reported as an ``llm_call`` activity in the same wire shape as
the OpenBox LangChain SDK: ActivityStarted with ``[{"prompt": ...}]``, then
ActivityCompleted whose output is ``{llm_model, input_tokens, output_tokens,
total_tokens, completion, has_tool_calls}``.

``governed_llm_call`` / the framework integrations ENFORCE the verdict like a tool's (redaction,
BLOCK, HALT, approval). ``report_llm_call`` is telemetry only (after the fact, one step).

Two ways to report:

* ``governed_llm_call(ctx, call, ...)`` (preferred): ActivityStarted is sent BEFORE the call and the
  call runs inside the activity's span scope, so with ``enable_openbox_spans()`` the model provider's
  HTTP request appears as a span of the ``llm_call`` (OpenBox counts LLM calls from it).
  ``govern_agent`` (OpenAI Agents SDK) does the same through agent hooks.
* ``report_llm_call(ctx, ...)``: after the fact, one step, no spans.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from contextlib import nullcontext
from dataclasses import dataclass
from typing import Any, TypeVar

import restate

from .approvals import wait_for_approval
from .context import GovernanceContext, require_governance_context
from .enforce import decide, details_of, redacted
from .errors import GovernanceBlockedError
from .events import activity_completed_event, activity_started_event, error_info_of
from .governed_run import _halt, halted_error
from .ids import StepNames, activity_id_for
from .runtime import SpanScopeInfo
from .steps import best_effort, evaluate_step

T = TypeVar("T")

__all__ = ["LLM_ACTIVITY_TYPE", "LlmPre", "governed_llm_call", "llm_pre", "report_llm_call"]

LLM_ACTIVITY_TYPE = "llm_call"


def _num(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


async def report_llm_call(
    ctx: restate.Context,
    *,
    model: str | None = None,
    prompt: str | None = None,
    completion: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    has_tool_calls: bool = False,
    error: BaseException | None = None,
) -> None:
    """Report one LLM call to OpenBox (telemetry only). Call it inside an ``@openbox_handler``."""
    g = require_governance_context()
    aid = activity_id_for(g, LLM_ACTIVITY_TYPE)
    step = StepNames.llm(aid)
    inp, out = _num(input_tokens), _num(output_tokens)
    output = {
        "llm_model": model,
        "input_tokens": inp,
        "output_tokens": out,
        "total_tokens": (inp or 0) + (out or 0) if inp is not None or out is not None else None,
        "completion": completion,
        "has_tool_calls": has_tool_calls,
    }
    err_info = error_info_of(error) if error is not None else None
    await best_effort(
        f"LLM call {aid}",
        evaluate_step(
            ctx,
            g,
            step,
            lambda _now: [
                activity_started_event(
                    g,
                    step,
                    activity_id=aid,
                    activity_type=LLM_ACTIVITY_TYPE,
                    input={"prompt": prompt},
                    semantic_type="LLM_CALL",
                ),
                activity_completed_event(
                    g,
                    step,
                    activity_id=aid,
                    activity_type=LLM_ACTIVITY_TYPE,
                    status="failed" if err_info else "completed",
                    result=output,
                    error=err_info,
                ),
            ],
        ),
    )


def llm_output(
    model: str | None = None,
    completion: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    has_tool_calls: bool = False,
) -> dict[str, Any]:
    """The ActivityCompleted output OpenBox reads for Model Usage (LangChain SDK shape)."""
    inp, out = _num(input_tokens), _num(output_tokens)
    return {
        "llm_model": model,
        "input_tokens": inp,
        "output_tokens": out,
        "total_tokens": (inp or 0) + (out or 0) if inp is not None or out is not None else None,
        "completion": completion,
        "has_tool_calls": has_tool_calls,
    }


def llm_scope_info(g: GovernanceContext, aid: str) -> SpanScopeInfo:
    return SpanScopeInfo(
        workflow_id=g.workflow_id,
        run_id=g.run_id,
        workflow_type=g.workflow_type,
        activity_id=aid,
        activity_type=LLM_ACTIVITY_TYPE,
        agent_name=g.agent_name,
        session_id=g.session_id,
        multi_agent_session_id=g.multi_agent_session_id,
    )


@dataclass(frozen=True)
class LlmPre:
    """The approved state of one llm_call."""

    aid: str
    started_at: int | None
    #: The prompt after input guardrails (redacted when a guardrail transformed it).
    prompt: str | None
    redacted: bool


async def llm_pre(ctx: restate.Context, g: GovernanceContext, prompt: str | None) -> LlmPre:
    """PRE for an LLM call (journaled), enforced like a tool's: HALT ends the session, BLOCK or a failed
    guardrail refuses the call (terminal), REQUIRE_APPROVAL waits durably, and an input guardrail's
    redaction replaces the prompt the model will receive."""
    if g.halted:
        raise halted_error(g)
    aid = activity_id_for(g, LLM_ACTIVITY_TYPE)
    step = StepNames.llm_pre(aid)
    rec = await evaluate_step(
        ctx,
        g,
        step,
        lambda _now: [
            activity_started_event(
                g, step, activity_id=aid, activity_type=LLM_ACTIVITY_TYPE, input={"prompt": prompt},
                semantic_type="LLM_CALL",
            )
        ],
    )
    d = decide(rec, g.rt.config.restate.hitl_enabled)
    approval_at: int | None = None
    if d.kind == "halt":
        raise _halt(g, rec, d.reason)
    if d.kind == "blocked":
        raise GovernanceBlockedError(d.reason, **details_of(rec))
    if d.kind == "approval":
        approval = await wait_for_approval(ctx, g, aid, rec)
        approval_at = approval.get("at") if approval is not None else None
    after = redacted(rec, {"prompt": prompt}, "input")
    effective = after.get("prompt") if isinstance(after, dict) and isinstance(after.get("prompt"), str) else prompt
    return LlmPre(aid, approval_at or rec.get("at"), effective, effective != prompt)


async def llm_finished(
    ctx: restate.Context,
    g: GovernanceContext,
    aid: str,
    started_at: int | None,
    output: dict[str, Any],
    error: BaseException | None = None,
) -> None:
    """Journaled ActivityCompleted for an llm_call (with tokens and duration)."""
    if g.halted:  # Core closed the session on HALT
        return
    step = StepNames.llm_post(aid)
    err_info = error_info_of(error) if error is not None else None
    await best_effort(
        f"LLM call {aid}",
        evaluate_step(
            ctx,
            g,
            step,
            lambda now: [
                activity_completed_event(
                    g,
                    step,
                    activity_id=aid,
                    activity_type=LLM_ACTIVITY_TYPE,
                    status="failed" if err_info else "completed",
                    result=output,
                    error=err_info,
                    duration_ms=now - started_at if started_at is not None else None,
                )
            ],
        ),
    )


async def governed_llm_call(
    ctx: restate.Context,
    call: Callable[[str | None], Awaitable[T]],
    describe: Callable[[T], dict[str, Any]],
    *,
    prompt: str | None = None,
    model: str | None = None,
) -> T:
    """Govern an LLM call as an ``llm_call`` activity around the call itself::

        llm = await governed_llm_call(
            ctx, lambda approved: ctx.run_typed("LLM call", lambda: call_llm(approved)),
            lambda r: llm_output(model=r.model, input_tokens=r.input_tokens, output_tokens=r.output_tokens),
            prompt=prompt.message,
        )

    ``call`` receives the prompt OpenBox approved: build the model request from it, so input guardrails
    (e.g. PII redaction) apply before the provider sees the data. HALT / BLOCK / a failed guardrail
    refuse the call; REQUIRE_APPROVAL waits durably.

    ``call`` must journal the model call itself (``ctx.run_typed``): on replay its result comes from
    the journal, no HTTP request is made, and neither event is re-sent.
    """
    g = require_governance_context()
    pre = await llm_pre(ctx, g, prompt)
    binder = g.rt.span_binder
    try:
        with binder.scope(llm_scope_info(g, pre.aid)) if binder else nullcontext():
            result = await call(pre.prompt)
    except Exception as err:
        await llm_finished(ctx, g, pre.aid, pre.started_at, llm_output(model=model), error=err)
        raise
    try:
        described = describe(result)
    except Exception:  # noqa: BLE001 — a bad describe must not fail the agent
        described = {}
    await llm_finished(ctx, g, pre.aid, pre.started_at, {**llm_output(model=model), **described})
    return result
