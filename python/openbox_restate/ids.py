"""Deterministic identifiers (architecture §4). Never use uuid4 / time.time here."""

from __future__ import annotations

from .context import GovernanceContext
from .errors import OpenBoxContractError

START_ACTIVITY_SUFFIX = "__start__"
END_ACTIVITY_SUFFIX = "__end__"


def activity_id_for(g: GovernanceContext, name: str, tool_call_id: str | None = None) -> str:
    """``{workflow_id}:{tool_call_id}`` when given, else ``{workflow_id}:{name}#{n}`` in program order."""
    if tool_call_id:
        aid = f"{g.workflow_id}:{tool_call_id}"
    else:
        n = g.name_counters.get(name, 0)
        g.name_counters[name] = n + 1
        aid = f"{g.workflow_id}:{name}#{n}"
    if aid in g.used_activity_ids:
        raise OpenBoxContractError(
            f'duplicate activity id "{aid}" in one invocation (the same tool_call_id was governed twice); '
            "approval polling would collide"
        )
    g.used_activity_ids.add(aid)
    return aid


class StepNames:
    start = "openbox:start"
    end = "openbox:end"
    end_failed = "openbox:end-failed"

    @staticmethod
    def pre(activity_id: str) -> str:
        return f"openbox:pre:{activity_id}"

    @staticmethod
    def post(activity_id: str) -> str:
        return f"openbox:post:{activity_id}"

    @staticmethod
    def post_failed(activity_id: str) -> str:
        return f"openbox:post-failed:{activity_id}"

    @staticmethod
    def approval_poll(key: str, n: int) -> str:
        return f"openbox:approval-poll:{key}:{n}"

    @staticmethod
    def approval_wait(key: str, n: int) -> str:
        return f"openbox:approval-wait:{key}:{n}"
