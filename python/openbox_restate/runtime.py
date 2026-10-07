"""Process-scoped runtime (architecture §3.4): one resolved config, one client, one gate."""

from __future__ import annotations

import asyncio
import logging
from contextlib import AbstractContextManager
from dataclasses import dataclass
from typing import Any, Protocol

from openbox_core.client import EvaluationClient
from openbox_core.errors import OpenBoxAuthError
from openbox_core.gate import GovernanceGate

from .config import ResolvedConfig, resolve_restate_config

_log = logging.getLogger("openbox_restate")


@dataclass(frozen=True)
class SpanScopeInfo:
    """Identity of one governed tool call, used to bind its HTTP/DB/file spans (instrumentation.py)."""

    workflow_id: str
    run_id: str
    workflow_type: str
    activity_id: str
    activity_type: str
    agent_name: str | None
    session_id: str
    multi_agent_session_id: str
    #: A human already approved this activity; its own spans must not ask again.
    approved: bool = False


class SpanBinder(Protocol):
    """Installed by ``enable_openbox_spans()``. This module never imports the base instrumentation."""

    def scope(self, info: SpanScopeInfo) -> AbstractContextManager[None]: ...

    def is_halt_requested(self, workflow_id: str, run_id: str) -> bool:
        """A completed-span verdict asked to HALT this run."""
        ...


class OpenBoxRestate:
    """Holds the process-wide OpenBox client. Never holds per-invocation state."""

    #: None unless span capture was enabled for this runtime.
    span_binder: SpanBinder | None = None

    def __init__(self, *, async_transport: Any = None, **options: Any) -> None:
        self.config: ResolvedConfig = resolve_restate_config(**options)
        base = self.config.base
        self.client = EvaluationClient(
            base.api_url,
            base.api_key,
            timeout_seconds=base.timeout_seconds,
            on_api_error=base.on_api_error,
            identity=base.load_okta_identity() or base.load_identity(),
            okta_bootstrap_private_key=base.okta_bootstrap_private_key(),
            workload_private_key=base.keycloak_workload_private_key(),
            sdk_version=base.sdk_version,
            sdk_engine=base.sdk_engine,
            sdk_language=base.sdk_language,
            async_transport=async_transport,
        )
        # The gate gives us strict envelope validation + privacy redaction for free.
        self.gate = GovernanceGate(self.client, base)
        self._validated = False
        self._lock: asyncio.Lock | None = None

    async def ensure_validated(self) -> None:
        """Validate the API key once per process, lazily, from inside the first governance step.

        Auth failures raise; a network failure is logged and retried on a later step.
        """
        if self._validated or not self.config.restate.validate:
            return
        self._lock = self._lock or asyncio.Lock()
        async with self._lock:
            if self._validated:
                return
            try:
                await self.client.avalidate_api_key()
                self._validated = True
            except OpenBoxAuthError:
                raise
            except Exception as e:  # noqa: BLE001 — network trouble must not block governance
                _log.warning("OpenBox API key validation skipped (Core unreachable): %s", e)

    async def aclose(self) -> None:
        await self.client.aclose()


_default: OpenBoxRestate | None = None


def get_default_runtime() -> OpenBoxRestate:
    """Lazily-built runtime from environment variables."""
    global _default
    if _default is None:
        _default = OpenBoxRestate()
    return _default


def set_default_runtime(rt: OpenBoxRestate | None) -> None:
    global _default
    _default = rt
