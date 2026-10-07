"""The journaled data model (architecture §5.2, §5.3).

Plain dicts — the ONLY values returned from governance ``ctx.run_typed`` actions.
Field names match the TypeScript package so journals look the same in both languages.
"""

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict

from openbox_core.contracts.results import ApprovalResult, EvaluationResult

VerdictValue = Literal["allow", "constrain", "require_approval", "block", "halt"]
ApprovalStatus = Literal["pending", "approved", "rejected", "expired", "poll_failed"]
_VERDICTS = ("allow", "constrain", "require_approval", "block", "halt")


class GuardrailsRecord(TypedDict):
    validationPassed: bool
    inputType: str | None
    redacted: Any
    reasons: list[str]


class VerdictRecord(TypedDict):
    v: int
    verdict: VerdictValue
    reason: str | None
    policyId: str | None
    governanceEventId: str | None
    approvalId: str | None
    approvalExpirationTime: str | None
    guardrails: GuardrailsRecord | None
    fallbackUsed: bool
    #: Epoch ms when the step ran, captured inside the journaled action (absent in older journals).
    at: NotRequired[int]


class ApprovalRecord(TypedDict):
    v: int
    status: ApprovalStatus
    reason: str | None
    #: Epoch ms of the poll, captured inside the journaled action.
    at: NotRequired[int]


def to_record(r: EvaluationResult) -> VerdictRecord:
    verdict = r.verdict.value if hasattr(r.verdict, "value") else str(r.verdict)
    g = r.guardrails
    return {
        "v": 1,
        "verdict": verdict if verdict in _VERDICTS else "allow",  # type: ignore[typeddict-item]
        "reason": r.reason,
        "policyId": r.policy_id,
        "governanceEventId": r.governance_event_id,
        "approvalId": r.approval_id,
        "approvalExpirationTime": r.approval_expiration_time,
        "guardrails": (
            {
                "validationPassed": bool(g.validation_passed),
                "inputType": g.input_type or None,
                "redacted": g.redacted_input,
                "reasons": g.get_reason_strings(),
            }
            if g is not None
            else None
        ),
        "fallbackUsed": bool(r.fallback_used),
    }


def rank(r: VerdictRecord) -> int:
    """halt > block > guardrail-fail > require_approval > constrain > allow (architecture §7.4)."""
    v = r["verdict"]
    if v == "halt":
        return 6
    if v == "block":
        return 5
    g = r["guardrails"]
    if g is not None and not g["validationPassed"]:
        return 4
    return {"require_approval": 3, "constrain": 2}.get(v, 1)


def highest_priority(records: list[VerdictRecord]) -> VerdictRecord:
    if not records:
        raise ValueError("highest_priority: no records")
    best = records[0]
    for r in records[1:]:
        if rank(r) > rank(best):
            best = r
    if any(r["fallbackUsed"] for r in records):
        best = {**best, "fallbackUsed": True}
    return best


def to_approval_record(r: ApprovalResult) -> ApprovalRecord:
    if r.allow_shaped:
        return {"v": 1, "status": "approved", "reason": r.reason}
    if r.expired:
        return {"v": 1, "status": "expired", "reason": r.reason}
    if r.is_blocking():
        return {"v": 1, "status": "rejected", "reason": r.reason}
    return {"v": 1, "status": "pending", "reason": r.reason}
