/**
 * Decision precedence (architecture §7.4), applied OUTSIDE any ctx.run:
 *   1. halt                         → halt
 *   2. block                        → blocked
 *   3. guardrails validation failed → throw GuardrailsValidationError
 *   4. require_approval             → approval (or blocked when HITL is disabled)
 *   5. constrain                    → throw ConstrainUnsupportedError (v1)
 *   6. allow                        → proceed
 */

import { ConstrainUnsupportedError, GuardrailsValidationError, type OpenBoxErrorDetails } from "./errors.js";
import type { VerdictRecord } from "./verdict-record.js";

export type Decision =
  | { kind: "proceed" }
  | { kind: "halt"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "approval" };

export function detailsOf(r: VerdictRecord): OpenBoxErrorDetails {
  return { verdict: r.verdict, policyId: r.policyId, governanceEventId: r.governanceEventId };
}

export function decide(r: VerdictRecord, hitlEnabled: boolean): Decision {
  if (r.verdict === "halt") return { kind: "halt", reason: r.reason ?? "halted by policy" };
  if (r.verdict === "block") return { kind: "blocked", reason: r.reason ?? "blocked by policy" };
  if (r.guardrails && !r.guardrails.validationPassed) {
    throw new GuardrailsValidationError(r.guardrails.reasons, detailsOf(r));
  }
  if (r.verdict === "require_approval") {
    return hitlEnabled
      ? { kind: "approval" }
      : { kind: "blocked", reason: `approval required but HITL is disabled${r.reason ? `: ${r.reason}` : ""}` };
  }
  if (r.verdict === "constrain") throw new ConstrainUnsupportedError(r.reason ?? "n/a", detailsOf(r));
  return { kind: "proceed" };
}

/**
 * Apply a guardrail replacement value. The base SDK parses `redacted_input`
 * but never applies it; every adapter applies it itself.
 *
 * `activity_input` is sent as a one-element list, so a one-element list
 * redaction is unwrapped back to the single input.
 */
export function redacted<T>(r: VerdictRecord, value: T, phase: "input" | "output"): T {
  const gr = r.guardrails;
  if (!gr || gr.redacted === null || gr.redacted === undefined) return value;
  const type = gr.inputType;
  const applies =
    phase === "input" ? type === "activity_input" : type === "activity_output" || type === "workflow_output";
  if (!applies) return value;
  const rep = gr.redacted;
  if (phase === "input" && Array.isArray(rep) && rep.length === 1 && !Array.isArray(value)) return rep[0] as T;
  return rep as T;
}
