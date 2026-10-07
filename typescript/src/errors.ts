/**
 * Public error hierarchy (architecture §14).
 *
 * Every class extends `restate.TerminalError`, so throwing one from a handler
 * ends the invocation instead of triggering a Restate retry.
 *
 * IMPORTANT (architecture §9.1): these classes are only ever constructed and
 * thrown OUTSIDE a `ctx.run` closure. Anything thrown inside a closure comes
 * back from Restate as a plain `TerminalError`, so subclass identity would be
 * lost. Inside closures we throw `taggedStepError(...)` instead, and
 * `classifyStepFailure` (steps.ts) rebuilds the public class after the await.
 */

import * as restate from "@restatedev/restate-sdk";

export interface OpenBoxErrorDetails {
  verdict?: string | null;
  policyId?: string | null;
  governanceEventId?: string | null;
  cause?: unknown;
}

function metadataOf(kind: string, d: OpenBoxErrorDetails): Record<string, string> {
  const md: Record<string, string> = { openbox_error: kind };
  if (d.verdict) md["openbox_verdict"] = d.verdict;
  if (d.policyId) md["openbox_policy_id"] = d.policyId;
  if (d.governanceEventId) md["openbox_event_id"] = d.governanceEventId;
  return md;
}

/** Abstract base for every error this SDK throws. */
export abstract class OpenBoxRestateError extends restate.TerminalError {
  readonly verdict: string | null;
  readonly policyId: string | null;
  readonly governanceEventId: string | null;

  protected constructor(kind: string, message: string, errorCode: number, details: OpenBoxErrorDetails = {}) {
    super(message, { errorCode, metadata: metadataOf(kind, details) });
    this.name = new.target.name;
    this.verdict = details.verdict ?? null;
    this.policyId = details.policyId ?? null;
    this.governanceEventId = details.governanceEventId ?? null;
    if (details.cause !== undefined) {
      (this as { cause?: unknown }).cause = details.cause;
    }
  }
}

/** Verdict HALT: the whole agent session must stop. */
export class GovernanceHaltError extends OpenBoxRestateError {
  constructor(reason: string, details: OpenBoxErrorDetails = {}) {
    super("halt", `OpenBox HALT: ${reason}`, 403, { verdict: "halt", ...details });
  }
}

/** Verdict BLOCK, only thrown when the caller opted into `onBlock: "throw"`. */
export class GovernanceBlockedError extends OpenBoxRestateError {
  constructor(reason: string, details: OpenBoxErrorDetails = {}) {
    super("block", `OpenBox BLOCK: ${reason}`, 403, { verdict: "block", ...details });
  }
}

/** Guardrails reported `validation_passed: false`. */
export class GuardrailsValidationError extends OpenBoxRestateError {
  readonly reasons: string[];
  constructor(reasons: string[], details: OpenBoxErrorDetails = {}) {
    super("guardrails", `OpenBox guardrails failed: ${reasons.join("; ") || "validation failed"}`, 422, details);
    this.reasons = reasons;
  }
}

/** A human reviewer rejected the approval request. */
export class ApprovalRejectedError extends OpenBoxRestateError {
  constructor(reason: string, details: OpenBoxErrorDetails = {}) {
    super("approval_rejected", `OpenBox approval rejected: ${reason}`, 403, details);
  }
}

/** The approval expired (Core expiry or the local wait cap). */
export class ApprovalExpiredError extends OpenBoxRestateError {
  constructor(reason: string, details: OpenBoxErrorDetails = {}) {
    super("approval_expired", `OpenBox approval expired: ${reason}`, 408, details);
  }
}

/** Verdict CONSTRAIN is not enforced by any OpenBox SDK yet (PRD §0 item 14). */
export class ConstrainUnsupportedError extends OpenBoxRestateError {
  constructor(reason: string, details: OpenBoxErrorDetails = {}) {
    super(
      "constrain_unsupported",
      `OpenBox CONSTRAIN is not supported by this SDK yet (reason: ${reason})`,
      501,
      { verdict: "constrain", ...details }
    );
  }
}

/** OpenBox Core unreachable under a fail-closed policy. */
export class OpenBoxUnavailableError extends OpenBoxRestateError {
  constructor(message: string, details: OpenBoxErrorDetails = {}) {
    super("unavailable", `OpenBox unavailable: ${message}`, 503, details);
  }
}

/** 401/403 from Core: bad API key or signature. Never retried, never fail-open. */
export class OpenBoxAuthTerminalError extends OpenBoxRestateError {
  constructor(message: string, details: OpenBoxErrorDetails = {}) {
    super("auth", `OpenBox authentication failed: ${message}`, 401, details);
  }
}

/** Malformed envelope or SDK misuse. A bug: never fail-open on it. */
export class OpenBoxContractError extends OpenBoxRestateError {
  constructor(message: string, details: OpenBoxErrorDetails = {}) {
    super("contract", `OpenBox contract violation: ${message}`, 500, details);
  }
}

/**
 * The only error kinds that are allowed to be thrown INSIDE a ctx.run closure.
 * `hook_block` / `hook_halt` come from span preflight verdicts inside the tool's own closure (instrumentation.ts).
 */
export type StepErrorKind = "auth" | "contract";
export type HookErrorKind = "hook_block" | "hook_halt";

/** Build the plain, tagged TerminalError a span preflight BLOCK/HALT throws inside the tool's closure. */
export function taggedHookError(kind: HookErrorKind, reason: string, policyId: string | null): restate.TerminalError {
  const metadata: Record<string, string> = { openbox_error: kind };
  if (policyId) metadata["openbox_policy_id"] = policyId;
  return new restate.TerminalError(reason, { errorCode: 403, metadata });
}

/** If `err` is a span preflight verdict that crossed a ctx.run boundary, return its kind, reason and policy. */
export function hookVerdictOf(err: unknown): { kind: HookErrorKind; reason: string; policyId: string | null } | null {
  if (!(err instanceof restate.TerminalError)) return null;
  const md = err.metadata;
  const kind = md?.["openbox_error"];
  if (kind !== "hook_block" && kind !== "hook_halt") return null;
  return { kind, reason: err.message, policyId: md?.["openbox_policy_id"] ?? null };
}

/** Build the plain, tagged TerminalError thrown inside a closure (architecture §9.1). */
export function taggedStepError(kind: StepErrorKind, cause: unknown): restate.TerminalError {
  const code = kind === "auth" ? 401 : 500;
  return new restate.TerminalError(`${kind}: ${messageOf(cause)}`, {
    errorCode: code,
    metadata: { openbox_error: kind }
  });
}

export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
