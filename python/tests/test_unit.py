"""Unit tests (no Restate server needed)."""

from __future__ import annotations

import subprocess
import sys
from types import SimpleNamespace
from typing import Any

import pytest
from openbox_core.contracts.results import ApprovalResult, EvaluationResult
from restate.exceptions import TerminalError

from openbox_restate import (
    ConstrainUnsupportedError,
    GuardrailsValidationError,
    OpenBoxAuthTerminalError,
    OpenBoxContractError,
    OpenBoxUnavailableError,
    resolve_restate_config,
)
from openbox_restate.approvals import next_interval_ms
from openbox_restate.enforce import decide, redacted
from openbox_restate.errors import tagged_step_error
from openbox_restate.ids import activity_id_for
from openbox_restate.steps import classify_step_failure
from openbox_restate.verdict_record import VerdictRecord, highest_priority, to_approval_record, to_record

ENV = {"OPENBOX_API_URL": "https://core.example.com", "OPENBOX_API_KEY": "obx_test_abc"}


def rec(**kw: Any) -> VerdictRecord:
    base: dict[str, Any] = {
        "v": 1,
        "verdict": "allow",
        "reason": None,
        "policyId": None,
        "governanceEventId": None,
        "approvalId": None,
        "approvalExpirationTime": None,
        "guardrails": None,
        "fallbackUsed": False,
    }
    base.update(kw)
    return base  # type: ignore[return-value]


def test_import_light() -> None:
    code = (
        "import sys; import openbox_restate; "
        "bad=[m for m in ('agents','opentelemetry.instrumentation') if m in sys.modules]; "
        "print(bad); sys.exit(1 if bad else 0)"
    )
    assert subprocess.run([sys.executable, "-c", code]).returncode == 0


def test_config_defaults_and_alias() -> None:
    c = resolve_restate_config(environ=ENV)
    assert c.base.on_api_error == "fail_open"
    assert c.base.sdk_engine == "restate"
    assert c.restate.approval_outage_policy == "fail_closed"
    assert c.restate.approval_poll_interval_ms == 15_000
    assert c.restate.approval_wait_cap_ms == 3_600_000
    alias = resolve_restate_config(
        environ={"OPENBOX_URL": "https://alias.example.com", "OPENBOX_API_KEY": "obx_test_abc"}
    )
    assert alias.base.api_url == "https://alias.example.com"
    pref = resolve_restate_config(
        environ={**ENV, "OPENBOX_HITL_ENABLED": "true", "OPENBOX_RESTATE_HITL_ENABLED": "false"}
    )
    assert pref.restate.hitl_enabled is False
    with pytest.raises(ValueError):
        resolve_restate_config(environ={**ENV, "OPENBOX_RESTATE_APPROVAL_OUTAGE_POLICY": "maybe"})


def test_ids_deterministic_and_unique() -> None:
    g: Any = SimpleNamespace(workflow_id="inv_1", name_counters={}, used_activity_ids=set())
    assert activity_id_for(g, "send", "call_9") == "inv_1:call_9"
    assert activity_id_for(g, "send") == "inv_1:send#0"
    assert activity_id_for(g, "send") == "inv_1:send#1"
    with pytest.raises(OpenBoxContractError):
        activity_id_for(g, "send", "call_9")


def test_records() -> None:
    assert to_record(EvaluationResult.fallback_allow("down"))["fallbackUsed"] is True
    gf = rec(guardrails={"validationPassed": False, "inputType": None, "redacted": None, "reasons": []})
    assert highest_priority([rec(), rec(verdict="require_approval"), gf]) is gf
    assert highest_priority([gf, rec(verdict="block")])["verdict"] == "block"
    assert highest_priority([rec(verdict="block"), rec(verdict="halt")])["verdict"] == "halt"
    assert to_approval_record(ApprovalResult.from_dict({"action": "allow"}))["status"] == "approved"
    assert to_approval_record(ApprovalResult.from_dict({"action": "block"}))["status"] == "rejected"
    assert to_approval_record(ApprovalResult.from_dict({"verdict": "yes-please"}))["status"] == "pending"


def test_decide_and_redact() -> None:
    assert decide(rec(verdict="halt", reason="x"), True).kind == "halt"
    assert decide(rec(verdict="block"), True).kind == "blocked"
    assert decide(rec(verdict="require_approval"), True).kind == "approval"
    assert decide(rec(verdict="require_approval"), False).kind == "blocked"
    with pytest.raises(ConstrainUnsupportedError):
        decide(rec(verdict="constrain"), True)
    with pytest.raises(GuardrailsValidationError):
        decide(
            rec(guardrails={"validationPassed": False, "inputType": None, "redacted": None, "reasons": ["PII"]}), True
        )
    r = rec(
        guardrails={"validationPassed": True, "inputType": "activity_input", "redacted": [{"q": "***"}], "reasons": []}
    )
    assert redacted(r, {"q": "secret"}, "input") == {"q": "***"}
    assert redacted(r, "out", "output") == "out"


def test_error_boundary_classification() -> None:
    assert isinstance(classify_step_failure(tagged_step_error("auth", Exception("bad"))), OpenBoxAuthTerminalError)
    assert isinstance(classify_step_failure(tagged_step_error("contract", Exception("bad"))), OpenBoxContractError)
    assert isinstance(classify_step_failure(TerminalError("exhausted")), OpenBoxUnavailableError)
    cancelled = TerminalError("cancelled", 409)
    assert classify_step_failure(cancelled) is cancelled


def test_poll_interval_backoff() -> None:
    cfg: Any = SimpleNamespace(
        approval_poll_interval_ms=15_000, approval_poll_backoff=2.0, approval_poll_max_interval_ms=60_000
    )
    assert [next_interval_ms(cfg, n) for n in range(4)] == [15_000, 30_000, 60_000, 60_000]
