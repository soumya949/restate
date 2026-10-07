"""``openbox_restate.instrumentation`` — opt-in span capture.

Installs the base SDK's instrumentation (httpx, requests, urllib3, urllib;
DB drivers and file I/O per the base config) and binds every ``governed_run``
tool execution as an OpenBox activity, so the calls a tool makes show up as
``http_request`` / ``db_query`` / ``file_operation`` spans under that
activity, each with its own verdict. Needs ``openbox-sdk-python[http]``.

Never imported by ``openbox_restate/__init__``: this module patches libraries.

Restate semantics (same as the TypeScript package):
  * Spans are side effects of the tool's own ``ctx.run_typed`` action, so they
    fire exactly when the action really executes, never on replay.
  * A span preflight BLOCK/HALT is raised INSIDE that action, so it is raised as
    a tagged ``TerminalError`` (architecture §9.1): Restate does not retry it,
    and ``governed_run`` maps it back to ``Blocked`` / ``GovernanceHaltError``.
  * A span-level REQUIRE_APPROVAL cannot suspend durably inside an action. It
    passes when the activity itself was already approved (one poll), and
    otherwise fails safe as a block.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import TYPE_CHECKING, Any, NoReturn

from openbox_core.context import ContextStore
from openbox_core.contracts.context import ActivityContext
from openbox_core.contracts.results import EvaluationResult, Verdict
from openbox_core.runtime import OpenBoxRuntime

from .errors import HookErrorKind, tagged_hook_error
from .runtime import OpenBoxRestate, SpanScopeInfo, get_default_runtime

if TYPE_CHECKING:
    from openbox_core.client import EvaluationClient

__all__ = ["OpenBoxSpans", "enable_openbox_spans"]

_SPAN_APPROVAL_NOT_GRANTED = (
    "span requires approval, but its activity has not been approved; span-level approvals cannot wait inside "
    "ctx.run on Restate, so put the approval rule on the activity (event_type ActivityStarted, no hook_trigger)"
)


def _ids(context: ActivityContext | None) -> tuple[str, str, str] | None:
    if context and context.workflow_id and context.run_id and context.activity_id:
        return context.workflow_id, context.run_id, context.activity_id
    return None


class RestateSpanAdapter:
    """Turns span verdicts into errors that survive the ctx.run boundary."""

    name = "restate"

    def __init__(self, client: EvaluationClient) -> None:
        self._client = client
        self._lock = threading.Lock()
        # Per-run HALT requests from completed spans (the base store's halt flag is process-wide).
        self._halted_runs: set[tuple[str, str]] = set()

    # Span events carry event_type ActivityStarted + the activity's type, so an activity-level
    # approval rule also matches the tool's own spans. Approval is keyed on (workflow, run,
    # activity): the activity approval governed_run already waited for durably covers them.

    async def handle_approval(self, result: EvaluationResult, context: ActivityContext | None = None) -> None:
        ids = _ids(context)
        if ids is not None:
            try:
                approval = await self._client.apoll_approval(*ids)
            except Exception:  # noqa: BLE001 — any failure is "not approved": fail safe
                approval = None
            if approval is not None and approval.allow_shaped:
                return
        raise tagged_hook_error("hook_block", _SPAN_APPROVAL_NOT_GRANTED, None)

    def handle_approval_sync(self, result: EvaluationResult, context: ActivityContext | None = None) -> None:
        """Sync HTTP clients (requests, urllib): same single poll, no waiting."""
        ids = _ids(context)
        if ids is not None:
            try:
                approval = self._client.poll_approval(*ids)
            except Exception:  # noqa: BLE001
                approval = None
            if approval is not None and approval.allow_shaped:
                return
        raise tagged_hook_error("hook_block", _SPAN_APPROVAL_NOT_GRANTED, None)

    def raise_lifecycle_blocked(self, result: EvaluationResult) -> NoReturn:
        # Lifecycle events go through governed_run / openbox_handler, never through this runtime.
        self.raise_hook_blocked(result)

    def raise_hook_blocked(self, result: EvaluationResult) -> NoReturn:
        kind: HookErrorKind = "hook_halt" if result.verdict is Verdict.HALT else "hook_block"
        reason = result.reason or f"span {result.verdict.value} by policy"
        raise tagged_hook_error(kind, reason, result.policy_id)

    def on_completed_hook_result(self, result: EvaluationResult, context: ActivityContext | None = None) -> None:
        # The call already happened; only a HALT affects what follows (governed_run reads it).
        if result.verdict is Verdict.HALT and context and context.workflow_id and context.run_id:
            with self._lock:
                self._halted_runs.add((context.workflow_id, context.run_id))

    def is_halt_requested(self, workflow_id: str, run_id: str) -> bool:
        with self._lock:
            return (workflow_id, run_id) in self._halted_runs


class _Binder:
    def __init__(self, store: ContextStore, adapter: RestateSpanAdapter) -> None:
        self._store = store
        self._adapter = adapter

    @contextmanager
    def scope(self, info: SpanScopeInfo) -> Iterator[None]:
        token = self._store.bind(
            ActivityContext(
                workflow_id=info.workflow_id,
                run_id=info.run_id,
                workflow_type=info.workflow_type,
                activity_id=info.activity_id,
                activity_type=info.activity_type,
                agent_name=info.agent_name,
                session_id=info.session_id,
                multi_agent_session_id=info.multi_agent_session_id,
            )
        )
        try:
            yield
        finally:
            self._store.reset(token)

    def is_halt_requested(self, workflow_id: str, run_id: str) -> bool:
        return self._adapter.is_halt_requested(workflow_id, run_id)


class OpenBoxSpans:
    """Handle returned by :func:`enable_openbox_spans`."""

    def __init__(self, rt: OpenBoxRestate, base: OpenBoxRuntime, binder: _Binder, targets: list[str]) -> None:
        self._rt = rt
        self._base = base
        self._binder = binder
        self.installed_targets = targets

    def close(self) -> None:
        """Restore every patched library. The OpenBox client stays open (it belongs to the runtime)."""
        if self._rt.span_binder is self._binder:
            self._rt.span_binder = None
        self._base.uninstall_instrumentation()


def enable_openbox_spans(runtime: OpenBoxRestate | None = None) -> OpenBoxSpans:
    """Enable span capture for a runtime. Call once at startup, before serving::

        from openbox_restate.instrumentation import enable_openbox_spans
        enable_openbox_spans()

    Which targets are patched follows the base config (``instrumentation.http_enabled``,
    ``db_enabled``, ``file_enabled``, ...). Only one runtime per process should own the patches.
    """
    rt = runtime or get_default_runtime()
    if rt.span_binder is not None:
        raise RuntimeError("OpenBox spans are already enabled for this runtime")
    adapter = RestateSpanAdapter(rt.client)
    store = ContextStore()  # our own store: never shares bindings or flags with another runtime
    base = OpenBoxRuntime(rt.config.base, adapter, client=rt.client, context_store=store)
    base.install_instrumentation()
    manager: Any = getattr(base, "_instrumentation_manager", None)
    targets: list[str] = list(manager.installed_targets) if manager is not None else []
    binder = _Binder(store, adapter)
    rt.span_binder = binder
    return OpenBoxSpans(rt, base, binder, targets)
