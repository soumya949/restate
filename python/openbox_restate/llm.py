"""LLM call telemetry: what feeds OpenBox's Model Usage, Cost and "LLM Calls".

Each model call is reported as an ``llm_call`` activity in the same wire shape as
the OpenBox LangChain SDK: ActivityStarted with ``[{"prompt": ...}]``, then
ActivityCompleted whose output is ``{llm_model, input_tokens, output_tokens,
total_tokens, completion, has_tool_calls}``.

Telemetry only: the verdict is not enforced and a reporting failure never fails the
agent. Both events go in ONE journaled step, so a replay never reports a call twice.

``govern_agent`` (OpenAI Agents SDK) reports for you. In a raw agent loop, call
``report_llm_call(ctx, ...)`` after the journaled LLM call.
"""

from __future__ import annotations

from typing import Any

import restate

from .context import require_governance_context
from .events import activity_completed_event, activity_started_event, error_info_of
from .ids import StepNames, activity_id_for
from .steps import best_effort, evaluate_step

__all__ = ["LLM_ACTIVITY_TYPE", "report_llm_call"]

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
