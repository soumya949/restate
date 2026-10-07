/**
 * Journaled governance steps (architecture §9.1). This is the ONLY module that
 * performs I/O against OpenBox Core, and every call it makes is inside ctx.run.
 *
 * The ctx.run error boundary (verified in source, binding):
 *   Anything thrown inside a ctx.run closure comes back to the awaiting code as
 *   a plain `TerminalError(message, {errorCode, metadata})` — on first execution
 *   AND on replay. Subclass identity never survives. Therefore:
 *     - inside a closure: return values (VerdictRecord / ApprovalRecord), throw
 *       only `taggedStepError(...)` (terminal, no retry) or a plain non-terminal
 *       error (Restate retries the step up to governanceMaxRetries);
 *     - outside, after the await: `classifyStepFailure` rebuilds the public class.
 */

import {
  ContractError,
  GovernanceAPIError,
  OpenBoxAuthError,
  OpenBoxConfigError,
  OpenBoxNetworkError,
  prepareLifecyclePayload,
  type EventEnvelope
} from "@openbox-ai/openbox-sdk-ts";
import * as restate from "@restatedev/restate-sdk";

import type { GovernanceContext } from "./context.js";
import {
  OpenBoxAuthTerminalError,
  OpenBoxContractError,
  OpenBoxUnavailableError,
  messageOf,
  taggedStepError
} from "./errors.js";
import { highestPriority, toApprovalRecord, toRecord, type ApprovalRecord, type VerdictRecord } from "./verdict-record.js";

/**
 * The base client (2.1.0) throws `GovernanceAPIError` — the same class it uses
 * for a fail_closed outage — when Core answers 401/403 without a reason code.
 * Its message is the only distinguishing mark ("…auth rejected (HTTP 401)…").
 * Pinned by test/unit/steps.test.ts so a base-SDK change cannot slip by.
 */
export function isAuthRejection(e: unknown): boolean {
  if (e instanceof OpenBoxAuthError) return true;
  return e instanceof GovernanceAPIError && /auth rejected \(HTTP 40[13]\)/.test(e.message);
}

/** Classify an error thrown by the base client inside a closure. */
function tagOrRethrow(e: unknown): never {
  if (isAuthRejection(e)) throw taggedStepError("auth", e);
  if (e instanceof ContractError) throw taggedStepError("contract", e);
  // A non-network config error (closed client, insecure URL, bad identity) will never heal.
  if (e instanceof OpenBoxConfigError && !(e instanceof OpenBoxNetworkError)) throw taggedStepError("contract", e);
  // GovernanceAPIError (fail_closed outage), network errors, anything else: non-terminal → Restate retries.
  throw e;
}

/**
 * Send one or more lifecycle events in ONE journaled step and return the
 * highest-priority verdict as a plain VerdictRecord.
 */
export async function evaluateStep(
  ctx: restate.Context,
  g: GovernanceContext,
  stepName: string,
  build: (now: number) => EventEnvelope[]
): Promise<VerdictRecord> {
  const { rt } = g;
  try {
    return await ctx.run(
      stepName,
      async (): Promise<VerdictRecord> => {
        try {
          await rt.ensureValidated();
        } catch (e) {
          tagOrRethrow(e);
        }
        // Wall clock is safe here: it runs once, inside the journaled closure, and is replayed from the journal.
        const now = Date.now();
        let events: EventEnvelope[];
        try {
          events = build(now);
        } catch (e) {
          throw taggedStepError("contract", e);
        }
        const records: VerdictRecord[] = [];
        for (const ev of events) {
          let payload;
          try {
            ({ payload } = prepareLifecyclePayload(ev, { privacy: rt.config.base.privacy }));
          } catch (e) {
            throw taggedStepError("contract", e);
          }
          let result;
          try {
            result = await rt.client.evaluate(payload);
          } catch (e) {
            tagOrRethrow(e);
          }
          if (result.fallbackUsed) {
            rt.logger.warn(`OpenBox unreachable for ${stepName}; fail_open fallback ALLOW (degraded): ${result.reason ?? ""}`);
          }
          records.push(toRecord(result));
        }
        return { ...highestPriority(records), at: now };
      },
      {
        maxRetryAttempts: rt.config.restate.governanceMaxRetries,
        initialRetryInterval: 200,
        maxRetryInterval: 5_000
      }
    );
  } catch (e) {
    throw classifyStepFailure(e);
  }
}

/**
 * One durable approval poll. A network failure is DATA (`poll_failed`), never
 * an exception; only auth / contract failures are thrown (tagged).
 */
export async function pollStep(
  ctx: restate.Context,
  g: GovernanceContext,
  stepName: string,
  activityId: string
): Promise<ApprovalRecord> {
  const { rt } = g;
  try {
    return await ctx.run(
      stepName,
      async (): Promise<ApprovalRecord> => {
        try {
          const res = await rt.client.pollApproval(g.workflowId, g.runId, activityId);
          const at = Date.now(); // inside the journaled closure (see evaluateStep)
          if (res === null) return { v: 1, status: "poll_failed", reason: null, at };
          return { ...toApprovalRecord(res), at };
        } catch (e) {
          if (isAuthRejection(e)) throw taggedStepError("auth", e);
          if (e instanceof ContractError) throw taggedStepError("contract", e);
          if (e instanceof OpenBoxConfigError && !(e instanceof OpenBoxNetworkError)) throw taggedStepError("contract", e);
          rt.logger.warn(`OpenBox approval poll failed: ${messageOf(e)}`);
          return { v: 1, status: "poll_failed", reason: messageOf(e), at: Date.now() };
        }
      },
      { maxRetryAttempts: 1 }
    );
  } catch (e) {
    throw classifyStepFailure(e);
  }
}

/** Best-effort reporting: never lets a reporting failure shadow the real error. */
export async function bestEffort(g: GovernanceContext, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (restate.internal.isSuspendedError(e)) throw e;
    g.rt.logger.warn(`OpenBox: failed to report ${what}: ${messageOf(e)}`);
  }
}

/** Rebuild the public error class from the plain TerminalError Restate hands back (architecture §9.1). */
export function classifyStepFailure(e: unknown): unknown {
  if (restate.internal.isSuspendedError(e)) return e;
  if (!(e instanceof restate.TerminalError)) return e;
  if (e instanceof restate.CancelledError || e.code === 409) return e; // cancellation: never wrap
  switch (e.metadata?.["openbox_error"]) {
    case "auth":
      return new OpenBoxAuthTerminalError(stripTag(e.message, "auth"), { cause: e });
    case "contract":
      return new OpenBoxContractError(stripTag(e.message, "contract"), { cause: e });
    default:
      // RunOptions exhaustion of a fail_closed outage carries no openbox_error tag.
      return new OpenBoxUnavailableError(e.message, { cause: e });
  }
}

function stripTag(message: string, tag: string): string {
  return message.startsWith(`${tag}: `) ? message.slice(tag.length + 2) : message;
}
