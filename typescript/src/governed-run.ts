/**
 * `governedRun` — the core algorithm (architecture §7.2).
 *
 *   PRE     ctx.run("openbox:pre:<id>")   → ActivityStarted  → VerdictRecord  [journaled]
 *   ENFORCE halt → throw | block → return BlockedResult | approval → durable wait
 *   EXECUTE the real tool, exactly-once recorded by its own ctx.run
 *   POST    ctx.run("openbox:post:<id>")  → ActivityCompleted → VerdictRecord [journaled]
 *   ENFORCE output guardrails / halt / block / output-review approval
 */

import type { JsonValue } from "@openbox-ai/openbox-sdk-ts";
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
  /** Extra fields for the ActivityStarted event (e.g. `__openbox` sub-agent metadata). */
  extra?: Record<string, JsonValue> | null;
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
  throw recordHalt(g, new GovernanceHaltError(reason, detailsOf(r)));
}

/** Mark the session halted and remember why. Returns the error for `throw`. */
export function recordHalt(g: GovernanceContext, e: GovernanceHaltError): GovernanceHaltError {
  g.halted = true;
  g.haltError ??= e;
  return e;
}

/** The error to throw when the session was halted earlier (e.g. a framework swallowed the original). */
export function haltedError(g: GovernanceContext): GovernanceHaltError {
  return g.haltError ?? new GovernanceHaltError("session was halted earlier in this invocation");
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
  const p = await prePhase(ctx, g, name, op, opts);
  if (p.kind === "done") return p.value;
  return finishPhase(ctx, g, p, await runTool(g, p, ctx, fn, opts), opts);
}

/** An approved step, ready to run. @internal */
export interface Prepared<I> {
  kind: "run";
  name: string;
  id: string;
  input: I;
  pre: VerdictRecord;
  /** A human approved this activity (durably, before it ran). */
  approved: boolean;
}
/** @internal */
export type PreResult<I> = Prepared<I> | { kind: "done"; value: BlockedResult };
/** @internal */
export type Outcome<O> = { ok: true; result: O } | { ok: false; err: unknown };

/** PRE — journaled decision on the input, then halt / block / durable approval wait. */
/** @internal */
export async function prePhase<I>(
  ctx: restate.Context,
  g: GovernanceContext,
  name: string,
  op: GovernedOperation<I>,
  opts: GovernedRunOptions
): Promise<PreResult<I>> {
  if (g.halted) throw haltedError(g);
  const cfg = g.rt.config.restate;
  const id = activityIdFor(g, name, op.toolCallId);
  const semanticType = op.type ?? cfg.toolTypeMap[name] ?? null;

  const preStep = stepNames.pre(id);
  const pre = await evaluateStep(ctx, g, preStep, () => [
    activityStartedEvent(g, preStep, {
      activityId: id,
      activityType: name,
      input: op.input,
      semanticType,
      agentId: op.agentId,
      extra: op.extra ?? undefined
    })
  ]);
  const d = decide(pre, cfg.hitlEnabled);
  switch (d.kind) {
    case "halt":
      halt(g, pre, d.reason);
    case "blocked":
      return { kind: "done", value: blockedOrThrow(pre, d.reason, opts) };
    case "approval":
      await waitForApproval(ctx, g, id, pre);
      break;
    case "proceed":
      break;
  }
  return { kind: "run", name, id, input: redacted(pre, op.input, "input"), pre, approved: d.kind === "approval" };
}

/**
 * EXECUTE — the real side effect. Never throws: the outcome is handled by
 * finishPhase, so parallel executions can be reported in a fixed order.
 * With span capture on, the tool runs inside an activity scope so its
 * HTTP/DB/file calls are reported as spans of this activity (never on replay).
 */
/** @internal */
export async function runTool<I, O>(
  g: GovernanceContext,
  p: Prepared<I>,
  ctx: restate.Context,
  fn: (input: I) => Promise<O>,
  opts: GovernedRunOptions
): Promise<Outcome<O>> {
  const exec = (): Promise<O> => (opts.wrapInRun ? ctx.run(p.name, () => fn(p.input)) : fn(p.input));
  const binder = g.rt.spanBinder;
  g.activeTools++;
  try {
    const result = binder
      ? await binder.run(
          {
            workflowId: g.workflowId,
            runId: g.runId,
            workflowType: g.workflowType,
            activityId: p.id,
            activityType: p.name,
            agentName: g.agentName,
            sessionId: g.sessionId,
            multiAgentSessionId: g.multiAgentSessionId,
            approved: p.approved
          },
          exec
        )
      : await exec();
    return { ok: true, result };
  } catch (err) {
    return { ok: false, err };
  } finally {
    g.activeTools--;
  }
}

/** Report a failed execution, or POST — journaled decision on the output. */
/** @internal */
export async function finishPhase<I, O>(
  ctx: restate.Context,
  g: GovernanceContext,
  p: Prepared<I>,
  outcome: Outcome<O>,
  opts: GovernedRunOptions
): Promise<O | BlockedResult> {
  const { name, id, pre } = p;
  if (!outcome.ok) {
    const err = outcome.err;
    const hook = hookVerdictOf(err);
    const terminal = err instanceof restate.TerminalError && !restate.internal.isSuspendedError(err);
    if (hook || terminal) {
      const failedStep = stepNames.postFailed(id);
      await bestEffort(g, `ActivityCompleted(failed) for ${name}`, () =>
        evaluateStep(ctx, g, failedStep, () => [
          activityCompletedEvent(g, failedStep, { activityId: id, activityType: name, status: "failed", error: errorInfoOf(err) })
        ])
      );
    }
    if (hook) {
      // A span preflight stopped the tool before its HTTP/DB/file call went out.
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
    throw err; // non-terminal: Restate's retry policy handles it, nothing is reported yet
  }
  const result = outcome.result;
  // A completed-span HALT (the call already went out) stops the session from here on.
  // Only seen on the attempt that really executed the tool; a crash right here loses it.
  if (g.rt.spanBinder?.isHaltRequested(g.workflowId, g.runId)) halt(g, pre, "a span of this step was halted by policy");

  const cfg = g.rt.config.restate;
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

export interface ParallelCall<I, O> extends ToolCall<I> {
  run: (input: I) => Promise<O>;
}

/**
 * Govern several tool calls whose executions may run concurrently (architecture §11.3):
 *
 *  1. pre-checks one at a time, in call order (approvals are waited for here);
 *  2. the approved tools all run concurrently;
 *  3. post-checks one at a time, in call order.
 *
 * Phases 1 and 3 are sequential because a journal entry created in completion
 * order would not replay deterministically. Results come back in call order;
 * a blocked call yields a BlockedResult in its slot.
 */
export async function governedParallel<O>(
  ctx: restate.Context,
  calls: ReadonlyArray<ParallelCall<any, O>>,
  opts: GovernedRunOptions = {}
): Promise<Array<O | BlockedResult>> {
  const g = requireGovernanceContext(ctx);
  const prepared: Array<PreResult<unknown>> = [];
  for (const c of calls) {
    prepared.push(
      await prePhase(
        ctx,
        g,
        c.toolName,
        { input: c.input, toolCallId: c.toolCallId ?? null, type: c.type ?? null, agentId: c.agentId ?? null },
        opts
      )
    );
  }
  // Every tool starts here, synchronously in call order, so its own ctx.run entries are created in that order.
  const outcomes = await Promise.all(
    prepared.map((p, i) => (p.kind === "run" ? runTool(g, p, ctx, calls[i]!.run, opts) : Promise.resolve(null)))
  );
  const results: Array<O | BlockedResult> = [];
  for (const [i, p] of prepared.entries()) {
    results.push(p.kind === "done" ? p.value : await finishPhase(ctx, g, p, outcomes[i] as Outcome<O>, opts));
  }
  return results;
}
