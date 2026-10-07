/**
 * `openboxAuditHook()` — optional, audit-only Restate hook (architecture §16.2).
 *
 * Reports every `ctx.run` that executes OUTSIDE a governed tool as an audit
 * activity (`activity_type` = the run's name, `__openbox.audit_only = true`),
 * so side effects nobody wrapped in `governedRun` still show up in OpenBox.
 *
 * ```ts
 * restate.service({ name: "agent", handlers: { run: openboxHandler(...) },
 *   options: { hooks: [openboxAuditHook()] } });
 * ```
 *
 * - **Never enforces.** Verdicts are ignored; sends are fire-and-forget and
 *   failures are swallowed. Use `governedRun` for anything that must be gated.
 * - **No replay noise.** Restate only calls the run interceptor when the
 *   closure really executes; journaled runs are skipped.
 * - **No duplicates.** Runs made by a governed tool (already an activity) and
 *   OpenBox's own `openbox:*` steps are skipped.
 * - Sees only the run's name and outcome, never its arguments or result.
 * - Only active inside `openboxHandler`-wrapped handlers. Service-level
 *   `options.hooks` replace endpoint-default hooks (Restate semantics).
 */

import { prepareLifecyclePayload, type EventEnvelope } from "@openbox-ai/openbox-sdk-ts";
import * as restate from "@restatedev/restate-sdk";

import { governanceContextForInvocation, type GovernanceContext } from "./context.js";
import { activityCompletedEvent, activityStartedEvent, errorInfoOf } from "./events.js";

export interface OpenBoxAuditHookOptions {
  /** Audit only runs whose name passes this filter. Default: all. */
  include?: (runName: string) => boolean;
}

/** Fire-and-forget: an audit event must never delay, fail or retry the invocation. */
function send(g: GovernanceContext, build: () => EventEnvelope): void {
  try {
    const { payload } = prepareLifecyclePayload(build(), { privacy: g.rt.config.base.privacy });
    void g.rt.client.evaluate(payload).catch((e: unknown) => g.rt.logger.warn(`OpenBox audit event failed: ${String(e)}`));
  } catch (e) {
    g.rt.logger.warn(`OpenBox audit event skipped: ${String(e)}`);
  }
}

export function openboxAuditHook(options: OpenBoxAuditHookOptions = {}): restate.HooksProvider {
  return ({ request }) => ({
    interceptor: {
      run: async (name, next) => {
        const g = governanceContextForInvocation(String(request.id));
        if (!g || g.activeTools > 0 || name.startsWith("openbox:") || (options.include && !options.include(name))) {
          return next();
        }
        const n = (g.auditCounters.get(name) ?? 0) + 1;
        g.auditCounters.set(name, n);
        const activityId = `${g.workflowId}:audit:${name}#${n}`;
        const step = `openbox:audit:${name}#${n}`;
        send(g, () =>
          activityStartedEvent(g, step, { activityId, activityType: name, input: null, extra: { __openbox: { audit_only: true } } })
        );
        const completed = (status: "completed" | "failed", outcome: string, error?: unknown) =>
          send(g, () =>
            activityCompletedEvent(g, step, {
              activityId,
              activityType: name,
              status,
              ...(error !== undefined ? { error: errorInfoOf(error) } : {}),
              extra: { __openbox: { audit_only: true, outcome } }
            })
          );
        try {
          await next();
        } catch (err) {
          if (restate.internal.isSuspendedError(err)) {
            // The closure ran, but the attempt suspended before Restate acknowledged its result
            // (always on request/response deployments such as Lambda, and under forced replay).
            // The replay takes the result from the journal and never calls this interceptor again,
            // so the outcome is not observable here. A failure still surfaces as WorkflowFailed.
            completed("completed", "unconfirmed");
          } else {
            completed("failed", "failed", err);
          }
          throw err;
        }
        completed("completed", "succeeded");
      }
    }
  });
}
