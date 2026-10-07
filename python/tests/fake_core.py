"""Routing fake OpenBox Core for httpx (architecture §18.2) — mirrors typescript/test/helpers/fake-core.ts.

Answers come from rules keyed on the request body (order-independent, so
Restate retries/replays cannot desynchronise it) and every request is recorded
in a LEDGER for "exactly once" assertions.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

Answer = dict[str, Any]
Rule = Callable[[dict[str, Any]], Answer | None]


@dataclass
class LedgerEntry:
    path: str
    event_type: str | None
    activity_id: str | None
    activity_type: str | None
    workflow_id: str | None
    body: dict[str, Any]


@dataclass
class FakeCore:
    ledger: list[LedgerEntry] = field(default_factory=list)
    rules: list[Rule] = field(default_factory=list)
    approvals: dict[str, list[Answer]] = field(default_factory=dict)
    mode: str = "ok"  # ok | down | auth401 | http500
    approval_mode: str | None = None

    def reset(self) -> None:
        self.ledger.clear()
        self.rules.clear()
        self.approvals.clear()
        self.mode = "ok"
        self.approval_mode = None

    def rule(self, r: Rule) -> FakeCore:
        """Add a rule; first matching rule wins. Unmatched → allow."""
        self.rules.append(r)
        return self

    def on_activity(self, activity_type: str, event_type: str, answer: Answer) -> FakeCore:
        self.rules.append(
            lambda b: answer if b.get("activity_type") == activity_type and b.get("event_type") == event_type else None
        )
        return self

    def on_event(self, event_type: str, answer: Answer) -> FakeCore:
        self.rules.append(
            lambda b: answer if b.get("event_type") == event_type and not b.get("activity_type") else None
        )
        return self

    def script_approval(self, activity_id_suffix: str, *answers: Answer) -> FakeCore:
        self.approvals[activity_id_suffix] = list(answers)
        return self

    def evaluations(self, event_type: str | None = None, activity_type: str | None = None) -> list[LedgerEntry]:
        return [
            e
            for e in self.ledger
            if e.path.endswith("/governance/evaluate")
            and (event_type is None or e.event_type == event_type)
            and (activity_type is None or e.activity_type == activity_type)
        ]

    def polls(self) -> list[LedgerEntry]:
        return [e for e in self.ledger if e.path.endswith("/governance/approval")]

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        body: dict[str, Any] = json.loads(request.content) if request.content else {}
        self.ledger.append(
            LedgerEntry(
                path=path,
                event_type=body.get("event_type"),
                activity_id=body.get("activity_id"),
                activity_type=body.get("activity_type"),
                workflow_id=body.get("workflow_id"),
                body=body,
            )
        )
        if path.endswith("/auth/validate"):
            return httpx.Response(401 if self.mode == "auth401" else 200, json={"valid": self.mode != "auth401"})
        mode = (self.approval_mode or self.mode) if path.endswith("/governance/approval") else self.mode
        if mode == "down":
            raise httpx.ConnectError("fake Core down", request=request)
        if mode == "auth401":
            return httpx.Response(401, json={"error": "invalid api key"})
        if mode == "http500":
            return httpx.Response(500, json={"error": "boom"})
        if path.endswith("/governance/evaluate"):
            for rule in self.rules:
                answer = rule(body)
                if answer is not None:
                    return httpx.Response(200, json=answer)
            return httpx.Response(200, json={"verdict": "allow"})
        if path.endswith("/governance/approval"):
            aid = str(body.get("activity_id", ""))
            for suffix, answers in self.approvals.items():
                if aid.endswith(suffix):
                    answer = answers.pop(0) if len(answers) > 1 else answers[0]
                    return httpx.Response(200, json=answer)
            return httpx.Response(200, json={"verdict": "require_approval"})
        return httpx.Response(404, json={"error": f"unknown path {path}"})
