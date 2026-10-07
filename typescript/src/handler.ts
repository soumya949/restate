/**
 * `openboxHandler` — the invocation lifecycle (architecture §6).
 *
 *   openbox:start  → WorkflowStarted (+ SignalReceived user_prompt)   [journaled]
 *   user code      → governedRun / governedCall steps
 *   openbox:end    → WorkflowCompleted (output guardrails may redact) [journaled]
 *   on TerminalError → openbox:end-failed → WorkflowFailed (best effort)
 *   on any other error → rethrow; Restate retries the attempt, nothing is reported
 */

import * as restate from "@restatedev/restate-sdk";

import { waitForApproval } from "./approvals.js";
import { createGovernanceContext, type GovernanceContext } from "./context.js";
import { decide, detailsOf, redacted } from "./enforce.js";
import { GovernanceBlockedError, GovernanceHaltError } from "./errors.js";
import {
  activityStartedEvent,
  errorInfoOf,
  userPromptEvent,
  workflowCompletedEvent,
  workflowFailedEvent,
  workflowStartedEvent
} from "./events.js";
import { END_ACTIVITY_SUFFIX, START_ACTIVITY_SUFFIX, stepNames } from "./ids.js";
import { getDefaultRuntime, type OpenBoxRestate } from "./runtime.js";
import { bestEffort, evaluateStep } from "./steps.js";
import type { VerdictRecord } from "./verdict-record.js";

export interface OpenBoxHandlerOptions<I> {
  /** Runtime to use. Default: a process-wide runtime built from environment variables. */
  runtime?: OpenBoxRestate;
  /** Sets `workflow_type` / `agent_name`. Default: config `agentName`, else `<Service>.<handler>`. */
  agentName?: string;
  /** Session id for plain services (Virtual Objects / Workflows use their key). */
  sessionId?: (input: I) => string | null | undefined;
  /** Extract the human prompt to send as `SignalReceived(user_prompt)`. */
  promptFrom?: (input: I) => string | null | undefined;
  /** Send the handler input with WorkflowStarted. Default true. */
  captureInput?: boolean;
  /** Send the handler output with WorkflowCompleted. Default true. */
  captureOutput?: boolean;
}

type Handler<C, I, O> = (ctx: C, input: I) => Promise<O>;

/**
 * Wrap a Restate handler so that its run is governed by OpenBox.
 *
 * ```ts
 * restate.service({ name: "Agent", handlers: { run: openboxHandler(async (ctx, input) => {...}, { agentName: "agent" }) } })
 * ```
 */
export function openboxHandler<C extends restate.Context, I, O>(
  fn: Handler<C, I, O>,
  options: OpenBoxHandlerOptions<I> = {}
): Handler<C, I, O> {
  return async (ctx: C, input: I): Promise<O> => {
    const rt = options.runtime ?? getDefaultRuntime();
    const g = createGovernanceContext(ctx, rt, { agentName: options.agentName, sessionId: options.sessionId }, input);
    const captureInput = options.captureInput ?? true;
    const captureOutput = options.captureOutput ?? true;

    // 1. Start: WorkflowStarted (+ user prompt) in one journaled step.
    const prompt = options.promptFrom?.(input);
    const start = await evaluateStep(ctx, g, stepNames.start, () => [
      workflowStartedEvent(g, stepNames.start, input, captureInput),
      ...(prompt ? [userPromptEvent(g, stepNames.start, prompt)] : [])
    ]);
    await enforceLifecycle(ctx, g, start, input, "start");

    // 2. User code.
    let output: O;
    try {
      output = await fn(ctx, input);
    } catch (err) {
      if (err instanceof restate.TerminalError && !restate.internal.isSuspendedError(err)) {
        await bestEffort(g, "WorkflowFailed", () =>
          evaluateStep(ctx, g, stepNames.endFailed, () => [workflowFailedEvent(g, stepNames.endFailed, errorInfoOf(err))])
        );
      }
      throw err;
    }

    // A HALT that user code caught and swallowed still ends the session.
    if (g.halted) throw new GovernanceHaltError("session was halted earlier in this invocation");

    // 3. End: output guardrails may redact or block the returned value.
    const end = await evaluateStep(ctx, g, stepNames.end, () => [
      workflowCompletedEvent(g, stepNames.end, output, captureOutput)
    ]);
    await enforceLifecycle(ctx, g, end, output, "end");
    return redacted(end, output, "output");
  };
}

async function enforceLifecycle(
  ctx: restate.Context,
  g: GovernanceContext,
  record: VerdictRecord,
  input: unknown,
  phase: "start" | "end"
): Promise<void> {
  const d = decide(record, g.rt.config.restate.hitlEnabled);
  switch (d.kind) {
    case "proceed":
      return;
    case "halt":
      g.halted = true;
      throw new GovernanceHaltError(d.reason, detailsOf(record));
    case "blocked":
      throw new GovernanceBlockedError(d.reason, detailsOf(record));
    case "approval":
      // Workflow-level REQUIRE_APPROVAL: start = gate before user code; end = output review.
      return phase === "start"
        ? approvalGate(ctx, g, START_ACTIVITY_SUFFIX, "agent_start", input)
        : approvalGate(ctx, g, END_ACTIVITY_SUFFIX, "agent_output", input);
  }
}

/**
 * Workflow-level REQUIRE_APPROVAL (architecture §6.2). The base SDK can only
 * poll approvals that have an activity_id, so the gate is re-sent as a
 * pollable `ActivityStarted` (`agent_start` before user code, `agent_output`
 * for end-of-run output review).
 */
async function approvalGate(
  ctx: restate.Context,
  g: GovernanceContext,
  suffix: string,
  activityType: string,
  payload: unknown
): Promise<void> {
  const id = `${g.workflowId}:${suffix}`;
  const step = stepNames.pre(id);
  const gate = await evaluateStep(ctx, g, step, () => [
    activityStartedEvent(g, step, { activityId: id, activityType, input: payload })
  ]);
  const d = decide(gate, g.rt.config.restate.hitlEnabled);
  switch (d.kind) {
    case "proceed":
      return;
    case "halt":
      g.halted = true;
      throw new GovernanceHaltError(d.reason, detailsOf(gate));
    case "blocked":
      throw new GovernanceBlockedError(d.reason, detailsOf(gate));
    case "approval":
      return waitForApproval(ctx, g, id, gate);
  }
}
