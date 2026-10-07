"""Approval Mode A — durable polling (architecture §8.2).

The invocation suspends between polls (``ctx.sleep``). Every control-flow input
comes from the journal: poll results are ApprovalRecords and time comes from
``await ctx.time()``.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING

import restate

from .enforce import details_of
from .errors import ApprovalExpiredError, ApprovalRejectedError, OpenBoxUnavailableError
from .ids import StepNames
from .steps import poll_step
from .verdict_record import ApprovalRecord, VerdictRecord

if TYPE_CHECKING:
    from .config import RestateGovernanceConfig
    from .context import GovernanceContext

_log = restate.getLogger("openbox_restate")  # type: ignore[no-untyped-call]  # replay-aware logger


def next_interval_ms(cfg: RestateGovernanceConfig, n: int) -> int:
    raw = cfg.approval_poll_interval_ms * (cfg.approval_poll_backoff**n)
    return int(round(min(raw, max(cfg.approval_poll_max_interval_ms, cfg.approval_poll_interval_ms))))


async def wait_for_approval(
    ctx: restate.Context,
    g: GovernanceContext,
    activity_id: str,
    verdict: VerdictRecord,
    step_key: str | None = None,
) -> ApprovalRecord | None:
    """Return when approved; raise ApprovalRejectedError / ApprovalExpiredError / OpenBoxUnavailableError."""
    cfg = g.rt.config.restate
    details = details_of(verdict)
    key = step_key or activity_id

    if g.key is not None and not g.vobj_warning_logged:
        g.vobj_warning_logged = True
        _log.warning(
            "OpenBox: approval wait started in keyed handler %s/%s. If this is an exclusive Virtual Object "
            "handler, other calls to this key are queued until it resolves.",
            g.workflow_type,
            g.key,
        )

    started_at = await ctx.time()
    cap_at = started_at + cfg.approval_wait_cap_ms / 1000.0
    failures = 0
    n = 0
    while True:
        rec = await poll_step(ctx, g, StepNames.approval_poll(key, n), activity_id)
        status = rec["status"]
        if status == "approved":
            return rec
        if status == "rejected":
            raise ApprovalRejectedError(rec["reason"] or "rejected by reviewer", **details)
        if status == "expired":
            raise ApprovalExpiredError(rec["reason"] or "approval expired", **details)
        if status == "poll_failed":
            failures += 1
            if failures >= cfg.max_consecutive_poll_failures:
                if cfg.approval_outage_policy == "fail_open":
                    _log.warning(
                        "OpenBox: approval status unavailable after %d polls; approval_outage_policy=fail_open, "
                        "proceeding",
                        failures,
                    )
                    return None
                raise OpenBoxUnavailableError(
                    f"approval status unavailable after {failures} consecutive polls", **details
                )
        else:
            failures = 0
        if await ctx.time() >= cap_at:
            raise ApprovalExpiredError(f"local approval wait cap ({cfg.approval_wait_cap_ms} ms) reached", **details)
        await ctx.sleep(timedelta(milliseconds=next_interval_ms(cfg, n)), name=StepNames.approval_wait(key, n))
        n += 1
