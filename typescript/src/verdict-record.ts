/**
 * The journaled data model (architecture §5.2, §5.3). These plain-JSON records
 * are the ONLY values returned from governance `ctx.run` steps. The base SDK's
 * `EvaluationResult` / `ApprovalResult` classes lose their getters through JSON
 * and `fromDict` drops `fallbackUsed`, so they are never journaled directly.
 */

import type { ApprovalResult, EvaluationResult } from "@openbox-ai/openbox-sdk-ts";

export type VerdictValue = "allow" | "constrain" | "require_approval" | "block" | "halt";

export interface GuardrailsRecord {
  validationPassed: boolean;
  inputType: string | null;
  redacted: unknown;
  reasons: string[];
}

export interface VerdictRecord {
  v: 1;
  verdict: VerdictValue;
  reason: string | null;
  policyId: string | null;
  governanceEventId: string | null;
  approvalId: string | null;
  approvalExpirationTime: string | null;
  guardrails: GuardrailsRecord | null;
  fallbackUsed: boolean;
  /** Epoch ms when the step ran, captured inside the journaled closure (absent in pre-0.1 journals). */
  at?: number;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "poll_failed";

export interface ApprovalRecord {
  v: 1;
  status: ApprovalStatus;
  reason: string | null;
  /** Epoch ms of the poll, captured inside the journaled closure. */
  at?: number;
}

const VERDICTS: readonly VerdictValue[] = ["allow", "constrain", "require_approval", "block", "halt"];

export function toRecord(r: EvaluationResult): VerdictRecord {
  const verdict = (VERDICTS as readonly string[]).includes(r.verdict) ? (r.verdict as VerdictValue) : "allow";
  const g = r.guardrails;
  return {
    v: 1,
    verdict,
    reason: r.reason ?? null,
    policyId: r.policyId ?? null,
    governanceEventId: r.governanceEventId ?? null,
    approvalId: r.approvalId ?? null,
    approvalExpirationTime: r.approvalExpirationTime ?? null,
    guardrails: g
      ? {
          validationPassed: g.validationPassed,
          inputType: g.inputType || null,
          redacted: g.redactedInput ?? null,
          reasons: g.getReasonStrings()
        }
      : null,
    fallbackUsed: r.fallbackUsed
  };
}

/** Enforcement rank: halt > block > guardrail-fail > require_approval > constrain > allow (architecture §7.4). */
export function rank(r: VerdictRecord): number {
  switch (r.verdict) {
    case "halt":
      return 6;
    case "block":
      return 5;
    default:
      if (r.guardrails && !r.guardrails.validationPassed) return 4;
      return r.verdict === "require_approval" ? 3 : r.verdict === "constrain" ? 2 : 1;
  }
}

/** Combine the verdicts of several events sent in one journaled step. */
export function highestPriority(records: readonly VerdictRecord[]): VerdictRecord {
  if (records.length === 0) throw new Error("highestPriority: no records");
  let best = records[0]!;
  for (const r of records.slice(1)) if (rank(r) > rank(best)) best = r;
  // A degraded (fail-open) answer anywhere in the step marks the whole step degraded.
  return records.some((r) => r.fallbackUsed) ? { ...best, fallbackUsed: true } : best;
}

/** Map a parsed base ApprovalResult (strict parser, Core expiry already checked) to a record. */
export function toApprovalRecord(r: ApprovalResult): ApprovalRecord {
  if (r.allowShaped) return { v: 1, status: "approved", reason: r.reason };
  if (r.expired) return { v: 1, status: "expired", reason: r.reason };
  if (r.isBlocking()) return { v: 1, status: "rejected", reason: r.reason };
  return { v: 1, status: "pending", reason: r.reason };
}
