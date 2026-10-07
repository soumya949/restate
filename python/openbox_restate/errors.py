"""Public error hierarchy (architecture §14).

Every class subclasses ``restate.TerminalError`` so raising one from a handler
ends the invocation instead of triggering a Restate retry.

IMPORTANT (architecture §9.1): these classes are only raised OUTSIDE a
``ctx.run_typed`` action. Anything raised inside an action comes back from
Restate as a plain ``TerminalError(message, status_code, metadata)`` — subclass
identity is lost. Inside actions we raise :func:`tagged_step_error` instead and
``classify_step_failure`` (steps.py) rebuilds the public class after the await.
"""

from __future__ import annotations

from typing import Literal

from restate.exceptions import TerminalError


def _metadata(kind: str, verdict: str | None, policy_id: str | None, event_id: str | None) -> dict[str, str]:
    md = {"openbox_error": kind}
    if verdict:
        md["openbox_verdict"] = verdict
    if policy_id:
        md["openbox_policy_id"] = policy_id
    if event_id:
        md["openbox_event_id"] = event_id
    return md


class OpenBoxRestateError(TerminalError):
    """Abstract base for every error this SDK raises."""

    kind = "openbox"
    status = 500

    def __init__(
        self,
        message: str,
        *,
        verdict: str | None = None,
        policy_id: str | None = None,
        governance_event_id: str | None = None,
    ) -> None:
        super().__init__(message, self.status, _metadata(self.kind, verdict, policy_id, governance_event_id))
        self.verdict = verdict
        self.policy_id = policy_id
        self.governance_event_id = governance_event_id


class GovernanceHaltError(OpenBoxRestateError):
    kind, status = "halt", 403

    def __init__(self, reason: str, **kw: str | None) -> None:
        kw.setdefault("verdict", "halt")
        super().__init__(f"OpenBox HALT: {reason}", **kw)


class GovernanceBlockedError(OpenBoxRestateError):
    """Verdict BLOCK, only raised when the caller opted into ``on_block="raise"``."""

    kind, status = "block", 403

    def __init__(self, reason: str, **kw: str | None) -> None:
        kw.setdefault("verdict", "block")
        super().__init__(f"OpenBox BLOCK: {reason}", **kw)


class GuardrailsValidationError(OpenBoxRestateError):
    kind, status = "guardrails", 422

    def __init__(self, reasons: list[str], **kw: str | None) -> None:
        super().__init__(f"OpenBox guardrails failed: {'; '.join(reasons) or 'validation failed'}", **kw)
        self.reasons = reasons


class ApprovalRejectedError(OpenBoxRestateError):
    kind, status = "approval_rejected", 403

    def __init__(self, reason: str, **kw: str | None) -> None:
        super().__init__(f"OpenBox approval rejected: {reason}", **kw)


class ApprovalExpiredError(OpenBoxRestateError):
    kind, status = "approval_expired", 408

    def __init__(self, reason: str, **kw: str | None) -> None:
        super().__init__(f"OpenBox approval expired: {reason}", **kw)


class ConstrainUnsupportedError(OpenBoxRestateError):
    kind, status = "constrain_unsupported", 501

    def __init__(self, reason: str, **kw: str | None) -> None:
        kw.setdefault("verdict", "constrain")
        super().__init__(f"OpenBox CONSTRAIN is not supported by this SDK yet (reason: {reason})", **kw)


class OpenBoxUnavailableError(OpenBoxRestateError):
    kind, status = "unavailable", 503

    def __init__(self, message: str, **kw: str | None) -> None:
        super().__init__(f"OpenBox unavailable: {message}", **kw)


class OpenBoxAuthTerminalError(OpenBoxRestateError):
    kind, status = "auth", 401

    def __init__(self, message: str, **kw: str | None) -> None:
        super().__init__(f"OpenBox authentication failed: {message}", **kw)


class OpenBoxContractError(OpenBoxRestateError):
    kind, status = "contract", 500

    def __init__(self, message: str, **kw: str | None) -> None:
        super().__init__(f"OpenBox contract violation: {message}", **kw)


StepErrorKind = Literal["auth", "contract"]


def tagged_step_error(kind: StepErrorKind, cause: BaseException) -> TerminalError:
    """The plain, tagged TerminalError raised inside an action (architecture §9.1)."""
    return TerminalError(f"{kind}: {cause}", 401 if kind == "auth" else 500, {"openbox_error": kind})


# Span preflight verdicts raised inside the tool's own action (instrumentation.py).
HookErrorKind = Literal["hook_block", "hook_halt"]


def tagged_hook_error(kind: HookErrorKind, reason: str, policy_id: str | None) -> TerminalError:
    """The plain, tagged TerminalError a span BLOCK/HALT raises inside the tool's action."""
    metadata: dict[str, str] = {"openbox_error": kind}
    if policy_id:
        metadata["openbox_policy_id"] = policy_id
    return TerminalError(reason, 403, metadata)


def hook_verdict_of(err: BaseException) -> tuple[HookErrorKind, str, str | None] | None:
    """If ``err`` is a span verdict that crossed a ctx.run boundary: (kind, reason, policy_id)."""
    if not isinstance(err, TerminalError):
        return None
    md = err.metadata or {}
    kind = md.get("openbox_error")
    if kind == "hook_block":
        return "hook_block", err.message, md.get("openbox_policy_id")
    if kind == "hook_halt":
        return "hook_halt", err.message, md.get("openbox_policy_id")
    return None
