/**
 * `governedRun` — the core algorithm (architecture §7.2).
 *
 *   PRE     ctx.run("openbox:pre:<id>")   → ActivityStarted  → VerdictRecord  [journaled]
 *   ENFORCE halt → throw | block → return BlockedResult | approval → durable wait
 *   EXECUTE the real tool, exactly-once recorded by its own ctx.run
 *   POST    ctx.run("openbox:post:<id>")  → ActivityCompleted → VerdictRecord [journaled]
 *   ENFORCE output guardrails / halt / block / output-review approval
 */

import * as restate from "@restatedev/restate-sdk";

import { waitForApproval } from "./approvals.js";
import { requireGovernanceContext, type GovernanceContext } from "./context.js";
import { decide, detailsOf, redacted } from "./enforce.js";
import { GovernanceBlockedError, GovernanceHaltError, hookVerdictOf } from "./errors.js";
import { activityCompletedEvent, activityStartedEvent, errorInfoOf } from "./events.js";
import { activityIdFor, stepNames } from "./ids.js";
import { bestEffort, evaluateStep } from "./steps.js";
import type { VerdictRecord } from "./verdict-record.js";

/** Returned (never thrown, by default) when OpenBox blocks a step. Feed it back to the LLM as the tool result. */
export interface BlockedResult {
  blocked: true;
  reason: string;
  policyId: string | null;
  governanceEventId: string | null;
}

export function isBlocked(value: unknown): value is BlockedResult {
  return typeof value === "object" && value !== null && (value as { blocked?: unknown }).blocked === true;
}

export interface GovernedOperation<I> {
  input: I;
  /** The LLM's tool-call id. Strongly recommended: it makes the activity id replay-stable and meaningful. */
  toolCallId?: string | null;
  /** Semantic event type (`EMAIL_SEND`, `DATABASE_WRITE`, …). Defaults to `toolTypeMap[name]`. */
  type?: string | null;
  /** Logical agent within the invocation (in-process sub-agents). */
  agentId?: string | null;
}

export interface GovernedRunOptions {
  /**
   * Wrap `fn` in its own `ctx.run(name, …)`. Use ONLY when `fn` does not use
   * `ctx` itself (Restate forbids ctx calls inside a ctx.run closure).
   * Default false: the tool is expected to journal its own side effect.
   */
  wrapInRun?: boolean;
  /** `"return"` (default) gives a BlockedResult back; `"throw"` throws GovernanceBlockedError. */
  onBlock?: "return" | "throw";
}

function blockedOrThrow(r: VerdictRecord, reason: string, opts: GovernedRunOptions): BlockedResult {
  if (opts.onBlock === "throw") throw new GovernanceBlockedError(reason, detailsOf(r));
  return { blocked: true, reason, policyId: r.policyId, governanceEventId: r.governanceEventId };
}

function halt(g: GovernanceContext, r: VerdictRecord, reason: string): never {
  g.halted = true;
  throw new GovernanceHaltError(reason, detailsOf(r));
}

/**
 * Govern one side-effecting step.
 *
 * ```ts
 * const res = await governedRun(ctx, "send_email", { input: args, toolCallId }, (a) =>
 *   ctx.run("send email", () => sendEmail(a)));
 * if (isBlocked(res)) return `Blocked by policy: ${res.reason}`;
 * ```
 */
export async function governedRun<I, O>(
  ctx: restate.Context,
  name: string,
  op: GovernedOperation<I>,
  fn: (input: I) => Promise<O>,
  opts: GovernedRunOptions = {}
): Promise<O | BlockedResult> {
  const g = requireGovernanceContext(ctx);
  if (g.halted) throw new GovernanceHaltError("session was halted earlier in this invocation");
  const cfg = g.rt.config.restate;
  const id = activityIdFor(g, name, op.toolCallId);
  const semanticType = op.type ?? cfg.toolTypeMap[name] ?? null;

  // PRE — journaled decision on the input.
  const preStep = stepNames.pre(id);
  const pre = await evaluateStep(ctx, g, preStep, () => [
    activityStartedEvent(g, preStep, {
      activityId: id,
      activityType: name,
      input: op.input,
      semanticType,
      agentId: op.agentId
    })
  ]);
  const d = decide(pre, cfg.hitlEnabled);
  switch (d.kind) {
    case "halt":
      halt(g, pre, d.reason);
    case "blocked":
      return blockedOrThrow(pre, d.reason, opts);
    case "approval":
      await waitForApproval(ctx, g, id, pre);
      break;
    case "proceed":
      break;
  }
  const input = redacted(pre, op.input, "input");

  // EXECUTE — the real side effect. With span capture on, the tool runs inside
  // an activity scope so its HTTP/DB/file calls are reported as spans of this
  // activity. Spans fire only when the closure really executes, never on replay.
  const exec = (): Promise<O> => (opts.wrapInRun ? ctx.run(name, () => fn(input)) : fn(input));
  const binder = g.rt.spanBinder;
  let result: O;
  try {
    result = binder
      ? await binder.run(
          {
            workflowId: g.workflowId,
            runId: g.runId,
            workflowType: g.workflowType,
            activityId: id,
            activityType: name,
            agentName: g.agentName,
            sessionId: g.sessionId,
            multiAgentSessionId: g.multiAgentSessionId
          },
          exec
        )
      : await exec();
  } catch (err) {
    const hook = hookVerdictOf(err);
    if (hook) {
      // A span preflight stopped the tool before its HTTP/DB/file call went out.
      const failedStep = stepNames.postFailed(id);
      await bestEffort(g, `ActivityCompleted(failed) for ${name}`, () =>
        evaluateStep(ctx, g, failedStep, () => [
          activityCompletedEvent(g, failedStep, { activityId: id, activityType: name, status: "failed", error: errorInfoOf(err) })
        ])
      );
      const r: VerdictRecord = {
        ...pre,
        verdict: hook.kind === "hook_halt" ? "halt" : "block",
        reason: hook.reason,
        policyId: hook.policyId,
        governanceEventId: null
      };
      if (hook.kind === "hook_halt") halt(g, r, hook.reason);
      return blockedOrThrow(r, hook.reason, opts);
    }
    if (err instanceof restate.TerminalError && !restate.internal.isSuspendedError(err)) {
      const failedStep = stepNames.postFailed(id);
      await bestEffort(g, `ActivityCompleted(failed) for ${name}`, () =>
        evaluateStep(ctx, g, failedStep, () => [
          activityCompletedEvent(g, failedStep, { activityId: id, activityType: name, status: "failed", error: errorInfoOf(err) })
        ])
      );
    }
    throw err; // non-terminal: Restate's retry policy handles it, nothing is reported yet
  }
  // A completed-span HALT (the call already went out) stops the session from here on.
  // Only seen on the attempt that really executed the tool; a crash right here loses it.
  if (binder?.isHaltRequested(g.workflowId, g.runId)) halt(g, pre, "a span of this step was halted by policy");

  // POST — journaled decision on the output.
  const postStep = stepNames.post(id);
  const post = await evaluateStep(ctx, g, postStep, () => [
    activityCompletedEvent(g, postStep, { activityId: id, activityType: name, status: "completed", result })
  ]);
  const pd = decide(post, cfg.hitlEnabled);
  switch (pd.kind) {
    case "halt":
      halt(g, post, pd.reason);
    case "blocked":
      return blockedOrThrow(post, pd.reason, opts);
    case "approval":
      // Output review: the side effect already happened; the result is released only after approval.
      await waitForApproval(ctx, g, id, post, `${id}:post`);
      break;
    case "proceed":
      break;
  }
  return redacted(post, result, "output");
}

export interface ToolCall<I> {
  toolName: string;
  toolCallId?: string | null;
  input: I;
  type?: string | null;
  agentId?: string | null;
}

/** `governedRun` shaped for the raw `for (const toolCall of result.toolCalls)` loop (architecture §11.3). */
export function governedCall<I, O>(
  ctx: restate.Context,
  call: ToolCall<I>,
  fn: (input: I) => Promise<O>,
  opts: GovernedRunOptions = {}
): Promise<O | BlockedResult> {
  return governedRun(
    ctx,
    call.toolName,
    { input: call.input, toolCallId: call.toolCallId ?? null, type: call.type ?? null, agentId: call.agentId ?? null },
    fn,
    opts
  );
}
