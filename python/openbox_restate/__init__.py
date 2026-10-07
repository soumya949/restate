"""OpenBox governance for durable AI agents running on Restate.

Import-light: no LLM framework (``agents``) or OpenTelemetry instrumentation is
imported here, and nothing global is patched (tests/test_import_safety.py).
"""

from ._version import __version__
from .config import DEFAULT_ENV_PREFIX, ResolvedConfig, RestateGovernanceConfig, resolve_restate_config
from .context import (
    HEADER_MULTI_AGENT_SESSION_ID,
    HEADER_PARENT_ACTIVITY_ID,
    HEADER_PARENT_AGENT_DID,
    HEADER_PARENT_WORKFLOW_ID,
)
from .errors import (
    ApprovalExpiredError,
    ApprovalRejectedError,
    ConstrainUnsupportedError,
    GovernanceBlockedError,
    GovernanceHaltError,
    GuardrailsValidationError,
    OpenBoxAuthTerminalError,
    OpenBoxContractError,
    OpenBoxRestateError,
    OpenBoxUnavailableError,
)
from .governed_run import Blocked, governed_call, governed_run, is_blocked
from .handler import openbox_handler
from .runtime import OpenBoxRestate, get_default_runtime, set_default_runtime

__all__ = [
    "__version__",
    "DEFAULT_ENV_PREFIX",
    "ResolvedConfig",
    "RestateGovernanceConfig",
    "resolve_restate_config",
    "OpenBoxRestate",
    "get_default_runtime",
    "set_default_runtime",
    "openbox_handler",
    "governed_run",
    "governed_call",
    "Blocked",
    "is_blocked",
    "HEADER_MULTI_AGENT_SESSION_ID",
    "HEADER_PARENT_ACTIVITY_ID",
    "HEADER_PARENT_AGENT_DID",
    "HEADER_PARENT_WORKFLOW_ID",
    "OpenBoxRestateError",
    "GovernanceHaltError",
    "GovernanceBlockedError",
    "GuardrailsValidationError",
    "ApprovalRejectedError",
    "ApprovalExpiredError",
    "ConstrainUnsupportedError",
    "OpenBoxUnavailableError",
    "OpenBoxAuthTerminalError",
    "OpenBoxContractError",
]
