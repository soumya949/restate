"""Decision precedence (architecture §7.4), applied OUTSIDE any action."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from .errors import ConstrainUnsupportedError, GuardrailsValidationError
from .verdict_record import VerdictRecord


@dataclass(frozen=True)
class Decision:
    kind: Literal["proceed", "halt", "blocked", "approval"]
    reason: str = ""


def details_of(r: VerdictRecord) -> dict[str, str | None]:
    return {"verdict": r["verdict"], "policy_id": r["policyId"], "governance_event_id": r["governanceEventId"]}


def decide(r: VerdictRecord, hitl_enabled: bool) -> Decision:
    v = r["verdict"]
    if v == "halt":
        return Decision("halt", r["reason"] or "halted by policy")
    if v == "block":
        return Decision("blocked", r["reason"] or "blocked by policy")
    g = r["guardrails"]
    if g is not None and not g["validationPassed"]:
        raise GuardrailsValidationError(g["reasons"], **details_of(r))
    if v == "require_approval":
        if hitl_enabled:
            return Decision("approval")
        suffix = f": {r['reason']}" if r["reason"] else ""
        return Decision("blocked", f"approval required but HITL is disabled{suffix}")
    if v == "constrain":
        raise ConstrainUnsupportedError(r["reason"] or "n/a", **details_of(r))
    return Decision("proceed")


def redacted(r: VerdictRecord, value: Any, phase: Literal["input", "output"]) -> Any:
    """Apply a guardrail replacement (base SDKs parse ``redacted_input`` but never apply it)."""
    g = r["guardrails"]
    if g is None or g["redacted"] is None:
        return value
    t = g["inputType"]
    applies = t == "activity_input" if phase == "input" else t in ("activity_output", "workflow_output")
    if not applies:
        return value
    rep = g["redacted"]
    if phase == "input" and isinstance(rep, list) and len(rep) == 1 and not isinstance(value, list):
        return rep[0]
    return rep
