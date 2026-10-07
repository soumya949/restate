/**
 * @openbox-ai/openbox-restate-sdk — OpenBox governance for durable AI agents on Restate.
 *
 * Import-light root: no LLM framework, OpenTelemetry or DB drivers are loaded,
 * and nothing is patched at import (checked by scripts/check-root-import-light.mjs).
 */

export { SDK_VERSION } from "./version.js";

export {
  createOpenBoxRestate,
  getDefaultRuntime,
  setDefaultRuntime,
  OpenBoxRestate
} from "./runtime.js";
export type {
  ApprovalMode,
  Logger,
  OpenBoxRestateOptions,
  OutagePolicy,
  ResolvedConfig,
  RestateGovernanceConfig
} from "./config.js";
export { resolveRestateConfig, DEFAULT_ENV_PREFIX } from "./config.js";

export { openboxHandler, type OpenBoxHandlerOptions } from "./handler.js";
export {
  governedRun,
  governedCall,
  governedParallel,
  isBlocked,
  type BlockedResult,
  type GovernedOperation,
  type GovernedRunOptions,
  type ParallelCall,
  type ToolCall
} from "./governed-run.js";
export { childHeaders, governedSubAgent, type SubAgentCall } from "./multi-agent.js";
export { openboxAuditHook, type OpenBoxAuditHookOptions } from "./hooks.js";

export {
  HEADER_MULTI_AGENT_SESSION_ID,
  HEADER_PARENT_ACTIVITY_ID,
  HEADER_PARENT_AGENT_DID,
  HEADER_PARENT_WORKFLOW_ID
} from "./context.js";

export type { ApprovalRecord, ApprovalStatus, VerdictRecord, VerdictValue } from "./verdict-record.js";

export {
  OpenBoxRestateError,
  GovernanceHaltError,
  GovernanceBlockedError,
  GuardrailsValidationError,
  ApprovalRejectedError,
  ApprovalExpiredError,
  ConstrainUnsupportedError,
  OpenBoxUnavailableError,
  OpenBoxAuthTerminalError,
  OpenBoxContractError,
  type OpenBoxErrorDetails
} from "./errors.js";
