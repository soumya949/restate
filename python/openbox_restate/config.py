"""Configuration resolution (architecture §13).

Order: explicit option > ``<env_prefix>_*`` (default ``OPENBOX_RESTATE_*``) > ``OPENBOX_*`` > default.
Base fields are resolved by ``openbox_core.config.OpenBoxConfig.resolve``; this
module adds the ``OPENBOX_URL`` alias and the Restate-specific options.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from openbox_core.config import OpenBoxConfig

from ._version import SDK_ENGINE, SDK_LANGUAGE, __version__

DEFAULT_ENV_PREFIX = "OPENBOX_RESTATE"
OutagePolicy = Literal["fail_open", "fail_closed"]

_log = logging.getLogger("openbox_restate")


@dataclass
class RestateGovernanceConfig:
    agent_name: str | None = None
    approval_mode: str = "poll"
    approval_poll_interval_ms: int = 15_000
    approval_poll_backoff: float = 1.0
    approval_poll_max_interval_ms: int = 60_000
    approval_wait_cap_ms: int = 3_600_000
    max_consecutive_poll_failures: int = 20
    approval_outage_policy: OutagePolicy = "fail_closed"
    governance_max_retries: int = 3
    hitl_enabled: bool = True
    validate: bool = True
    tool_type_map: dict[str, str] = field(default_factory=dict)


@dataclass
class ResolvedConfig:
    base: OpenBoxConfig
    restate: RestateGovernanceConfig


def _env(environ: Mapping[str, str], name: str) -> str | None:
    v = environ.get(name)
    return v.strip() if v is not None and v.strip() else None


def _num(name: str, raw: str | None, default: float, minimum: float) -> float:
    if raw is None:
        return default
    try:
        n = float(raw)
    except ValueError as e:
        raise ValueError(f"OpenBox Restate config: {name} must be a number, got {raw!r}") from e
    if n < minimum:
        raise ValueError(f"OpenBox Restate config: {name} must be >= {minimum}, got {raw!r}")
    return n


def _bool(name: str, raw: str | None, default: bool) -> bool:
    if raw is None:
        return default
    v = raw.lower()
    if v in ("1", "true", "yes", "on"):
        return True
    if v in ("0", "false", "no", "off"):
        return False
    raise ValueError(f"OpenBox Restate config: {name} must be a boolean, got {raw!r}")


def resolve_restate_config(
    *,
    env_prefix: str | None = None,
    environ: Mapping[str, str] | None = None,
    api_url: str | None = None,
    api_key: str | None = None,
    agent_name: str | None = None,
    approval_poll_interval_ms: int | None = None,
    approval_poll_backoff: float | None = None,
    approval_wait_cap_ms: int | None = None,
    max_consecutive_poll_failures: int | None = None,
    approval_outage_policy: OutagePolicy | None = None,
    governance_max_retries: int | None = None,
    hitl_enabled: bool | None = None,
    validate: bool | None = None,
    tool_type_map: Mapping[str, str] | None = None,
    **base_explicit: Any,
) -> ResolvedConfig:
    env: Mapping[str, str] = environ if environ is not None else os.environ
    prefix = env_prefix or DEFAULT_ENV_PREFIX

    if api_url is None:
        canonical = _env(env, f"{prefix}_API_URL") or _env(env, "OPENBOX_API_URL")
        alias = _env(env, f"{prefix}_URL") or _env(env, "OPENBOX_URL")
        if canonical and alias and canonical != alias:
            _log.warning("OPENBOX_API_URL (%s) and OPENBOX_URL (%s) differ; using OPENBOX_API_URL", canonical, alias)
        api_url = canonical or alias

    explicit: dict[str, Any] = {k: v for k, v in base_explicit.items() if v is not None}
    if api_url is not None:
        explicit["api_url"] = api_url
    if api_key is not None:
        explicit["api_key"] = api_key
    if agent_name is not None:
        explicit["agent_name"] = agent_name
    base = OpenBoxConfig.resolve(
        env_prefix=prefix,
        environ=env,
        sdk_engine=SDK_ENGINE,
        sdk_language=SDK_LANGUAGE,
        sdk_version=__version__,
        **explicit,
    )

    def r(suffix: str) -> str | None:
        return _env(env, f"{prefix}_{suffix}") or _env(env, f"OPENBOX_{suffix}")

    outage = approval_outage_policy or r("APPROVAL_OUTAGE_POLICY") or "fail_closed"
    if outage not in ("fail_open", "fail_closed"):
        raise ValueError(
            f"OpenBox Restate config: APPROVAL_OUTAGE_POLICY must be fail_open|fail_closed, got {outage!r}"
        )

    restate_cfg = RestateGovernanceConfig(
        agent_name=agent_name or base.agent_name,
        approval_poll_interval_ms=int(
            approval_poll_interval_ms or _num("APPROVAL_POLL_INTERVAL_MS", r("APPROVAL_POLL_INTERVAL_MS"), 15_000, 100)
        ),
        approval_poll_backoff=float(
            approval_poll_backoff or _num("APPROVAL_POLL_BACKOFF", r("APPROVAL_POLL_BACKOFF"), 1.0, 1)
        ),
        approval_wait_cap_ms=int(
            approval_wait_cap_ms or _num("APPROVAL_WAIT_CAP_MS", r("APPROVAL_WAIT_CAP_MS"), 3_600_000, 1)
        ),
        max_consecutive_poll_failures=int(
            max_consecutive_poll_failures
            or _num("MAX_CONSECUTIVE_POLL_FAILURES", r("MAX_CONSECUTIVE_POLL_FAILURES"), 20, 1)
        ),
        approval_outage_policy=outage,  # type: ignore[arg-type]
        governance_max_retries=int(
            governance_max_retries or _num("GOVERNANCE_MAX_RETRIES", r("GOVERNANCE_MAX_RETRIES"), 3, 1)
        ),
        hitl_enabled=hitl_enabled if hitl_enabled is not None else _bool("HITL_ENABLED", r("HITL_ENABLED"), True),
        validate=validate if validate is not None else _bool("VALIDATE", r("VALIDATE"), True),
        tool_type_map=dict(tool_type_map or {}),
    )
    return ResolvedConfig(base=base, restate=restate_cfg)
