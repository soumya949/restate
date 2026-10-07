"""Journaled governance steps (architecture §9.1). The ONLY module doing Core I/O.

The ctx.run error boundary (verified in source, binding): anything raised inside
a ``ctx.run_typed`` action comes back to the awaiting code as a plain
``TerminalError(message, status_code, metadata)`` (``server_context.py:680``) —
on first execution AND on replay. So inside actions we return records and raise
only tagged TerminalErrors (no retry) or plain exceptions (Restate retries);
:func:`classify_step_failure` rebuilds the public class after the await.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from datetime import timedelta
from typing import TYPE_CHECKING, Any, NoReturn, cast

from openbox_core.errors import ContractError, OpenBoxAuthError, OpenBoxConfigError, OpenBoxNetworkError
from restate import RunOptions
from restate.exceptions import TerminalError

from .errors import OpenBoxAuthTerminalError, OpenBoxContractError, OpenBoxUnavailableError, tagged_step_error
from .verdict_record import ApprovalRecord, VerdictRecord, highest_priority, to_approval_record, to_record

if TYPE_CHECKING:
    import restate
    from openbox_core.contracts.events import EventEnvelope

    from .context import GovernanceContext

_log = logging.getLogger("openbox_restate")


def _tag_or_raise(e: BaseException) -> NoReturn:
    if isinstance(e, OpenBoxAuthError):
        raise tagged_step_error("auth", e) from None
    if isinstance(e, ContractError):
        raise tagged_step_error("contract", e) from None
    # A non-network config error (closed client, insecure URL, bad identity) never heals.
    if isinstance(e, OpenBoxConfigError) and not isinstance(e, OpenBoxNetworkError):
        raise tagged_step_error("contract", e) from None
    # GovernanceAPIError (fail_closed outage), network errors, anything else: Restate retries.
    raise e


async def evaluate_step(
    ctx: restate.Context,
    g: GovernanceContext,
    step_name: str,
    build: Callable[[int], list[EventEnvelope]],
) -> VerdictRecord:
    """Send one or more events in ONE journaled step; return the highest-priority VerdictRecord."""
    rt = g.rt

    async def action() -> dict[str, Any]:
        try:
            await rt.ensure_validated()
        except Exception as e:  # noqa: BLE001
            _tag_or_raise(e)
        # Wall clock is safe here: it runs once, inside the journaled action, and is replayed from the journal.
        now = int(time.time() * 1000)  # noqa: TID251
        try:
            events = build(now)
        except Exception as e:  # noqa: BLE001
            raise tagged_step_error("contract", e) from None
        records: list[VerdictRecord] = []
        for ev in events:
            try:
                result = await rt.gate.aevaluate(ev)  # strict gate: ContractError before any send
            except Exception as e:  # noqa: BLE001
                _tag_or_raise(e)
            if result.fallback_used:
                _log.warning(
                    "OpenBox unreachable for %s; fail_open fallback ALLOW (degraded): %s", step_name, result.reason
                )
            records.append(to_record(result))
        return {**highest_priority(records), "at": now}

    options: RunOptions[dict[str, Any]] = RunOptions(
        max_attempts=rt.config.restate.governance_max_retries,
        initial_retry_interval=timedelta(milliseconds=200),
        max_retry_interval=timedelta(seconds=5),
    )
    try:
        run = cast(Any, ctx).run_typed  # restate's ParamSpec overloads defeat mypy for zero-arg actions
        return cast(VerdictRecord, await run(step_name, action, options))
    except TerminalError as e:
        raise classify_step_failure(e) from e


async def poll_step(ctx: restate.Context, g: GovernanceContext, step_name: str, activity_id: str) -> ApprovalRecord:
    """One durable approval poll. A network failure is DATA (``poll_failed``), never an exception."""
    rt = g.rt

    async def action() -> dict[str, Any]:
        try:
            res = await rt.client.apoll_approval(g.workflow_id, g.run_id, activity_id)
        except Exception as e:  # noqa: BLE001
            if isinstance(e, OpenBoxAuthError | ContractError) or (
                isinstance(e, OpenBoxConfigError) and not isinstance(e, OpenBoxNetworkError)
            ):
                _tag_or_raise(e)
            _log.warning("OpenBox approval poll failed: %s", e)
            return {"v": 1, "status": "poll_failed", "reason": str(e), "at": int(time.time() * 1000)}  # noqa: TID251
        at = int(time.time() * 1000)  # noqa: TID251  (inside the journaled action, see evaluate_step)
        if res is None:
            return {"v": 1, "status": "poll_failed", "reason": None, "at": at}
        return {**to_approval_record(res), "at": at}

    try:
        run = cast(Any, ctx).run_typed
        return cast(ApprovalRecord, await run(step_name, action, RunOptions(max_attempts=1)))
    except TerminalError as e:
        raise classify_step_failure(e) from e


def classify_step_failure(e: TerminalError) -> TerminalError:
    """Rebuild the public error class from the plain TerminalError Restate hands back."""
    if e.status_code == 409:  # cancellation: never wrap
        return e
    kind = (e.metadata or {}).get("openbox_error")
    if kind == "auth":
        return OpenBoxAuthTerminalError(_strip(e.message, "auth"))
    if kind == "contract":
        return OpenBoxContractError(_strip(e.message, "contract"))
    # RunOptions exhaustion of a fail_closed outage carries no openbox_error tag.
    return OpenBoxUnavailableError(e.message)


def _strip(message: str, tag: str) -> str:
    prefix = f"{tag}: "
    return message[len(prefix) :] if message.startswith(prefix) else message


async def best_effort(what: str, coro: Any) -> None:
    """Never let a reporting failure shadow the real error. BaseException (suspension) is not caught."""
    try:
        await coro
    except Exception as e:  # noqa: BLE001
        _log.warning("OpenBox: failed to report %s: %s", what, e)
