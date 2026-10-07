/**
 * Approval Mode A — durable polling (architecture §8.2).
 *
 * The invocation SUSPENDS between polls (ctx.sleep), so a pending approval
 * costs no compute and survives crashes, redeploys and Lambda cold starts.
 * Every input to control flow comes from the journal: poll results are
 * ApprovalRecords, and time comes from ctx.date.now().
 */

import * as restate from "@restatedev/restate-sdk";

import type { GovernanceContext } from "./context.js";
import { ApprovalExpiredError, ApprovalRejectedError, OpenBoxUnavailableError } from "./errors.js";
import { detailsOf } from "./enforce.js";
import { stepNames } from "./ids.js";
import { pollStep } from "./steps.js";
import type { VerdictRecord } from "./verdict-record.js";

export function nextIntervalMs(cfg: GovernanceContext["rt"]["config"]["restate"], n: number): number {
  const raw = cfg.approvalPollIntervalMs * Math.pow(cfg.approvalPollBackoff, n);
  return Math.round(Math.min(raw, Math.max(cfg.approvalPollMaxIntervalMs, cfg.approvalPollIntervalMs)));
}

/**
 * Wait for a human decision on `activityId`. Returns when approved; throws
 * ApprovalRejectedError / ApprovalExpiredError / OpenBoxUnavailableError.
 *
 * `stepKey` distinguishes several waits on the same activity (e.g. a post-
 * execution approval) so journal step names stay unique.
 */
export async function waitForApproval(
  ctx: restate.Context,
  g: GovernanceContext,
  activityId: string,
  verdict: VerdictRecord,
  stepKey: string = activityId
): Promise<void> {
  const cfg = g.rt.config.restate;
  const details = detailsOf(verdict);

  if (g.key !== null && !g.vobjWarningLogged) {
    g.vobjWarningLogged = true;
    ctx.console.warn(
      `OpenBox: approval wait started in keyed handler ${g.service}/${g.key}. ` +
        `If this is an exclusive Virtual Object handler, other calls to this key are queued until it resolves.`
    );
  }

  const startedAt = await ctx.date.now();
  const capAt = startedAt + cfg.approvalWaitCapMs;
  let failures = 0;

  for (let n = 0; ; n++) {
    const rec = await pollStep(ctx, g, stepNames.approvalPoll(stepKey, n), activityId);
    switch (rec.status) {
      case "approved":
        return;
      case "rejected":
        throw new ApprovalRejectedError(rec.reason ?? "rejected by reviewer", details);
      case "expired":
        throw new ApprovalExpiredError(rec.reason ?? "approval expired", details);
      case "poll_failed":
        failures++;
        if (failures >= cfg.maxConsecutivePollFailures) {
          if (cfg.approvalOutagePolicy === "fail_open") {
            ctx.console.warn(
              `OpenBox: approval status unavailable after ${failures} polls; approvalOutagePolicy=fail_open, proceeding`
            );
            return;
          }
          throw new OpenBoxUnavailableError(`approval status unavailable after ${failures} consecutive polls`, details);
        }
        break;
      case "pending":
        failures = 0;
        break;
    }
    const now = await ctx.date.now();
    if (now >= capAt) {
      throw new ApprovalExpiredError(`local approval wait cap (${cfg.approvalWaitCapMs} ms) reached`, details);
    }
    await ctx.sleep(nextIntervalMs(cfg, n), stepNames.approvalWait(stepKey, n));
  }
}
