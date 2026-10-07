/**
 * LLM call telemetry: what feeds OpenBox's Model Usage, Cost and "LLM Calls".
 *
 * Each model call is reported as an `llm_call` activity, in the same wire shape
 * as the OpenBox LangChain SDK: ActivityStarted with `[{ prompt }]`, then
 * ActivityCompleted whose output is `{ llm_model, input_tokens, output_tokens,
 * total_tokens, completion, has_tool_calls }`.
 *
 * Telemetry only: the verdict is not enforced and a reporting failure never
 * fails the agent. Both events go in ONE journaled step, so a replay never
 * reports the same call twice.
 *
 * Two ways to report:
 *  - `governedLlmCall(ctx, info, call, describe)` (preferred): ActivityStarted is sent BEFORE the
 *    call and the call runs inside the activity's span scope, so with `enableOpenBoxSpans()` the
 *    model provider's HTTP request appears as a span of the `llm_call` (OpenBox counts LLM calls
 *    from it). The Vercel AI SDK middleware `openboxLlmTelemetry` uses this.
 *  - `reportLlmCall(ctx, ...)`: after the fact, one step, no spans.
 */

import * as restate from "@restatedev/restate-sdk";

import { requireGovernanceContext, type GovernanceContext } from "./context.js";
import { activityCompletedEvent, activityStartedEvent, errorInfoOf, toJson } from "./events.js";
import { activityIdFor, stepNames } from "./ids.js";
import { bestEffort, evaluateStep } from "./steps.js";

export const LLM_ACTIVITY_TYPE = "llm_call";

const restateInternal = restate.internal;

export interface LlmCallReport {
  /** Model id, e.g. "gpt-5.4". */
  model?: string | null;
  /** The human/user prompt of this call (latest user turn). */
  prompt?: string | null;
  /** Text the model produced, if any. */
  completion?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** The model asked for tool calls. */
  hasToolCalls?: boolean;
  /** The call failed with this error. */
  error?: unknown;
  /** Wall time of the call, when the caller measured it deterministically (e.g. journaled timestamps). */
  durationMs?: number | null;
}

const num = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Report one LLM call to OpenBox (telemetry only). Call it inside an `openboxHandler`. */
export async function reportLlmCall(ctx: restate.Context, report: LlmCallReport): Promise<void> {
  const g = requireGovernanceContext(ctx);
  const id = activityIdFor(g, LLM_ACTIVITY_TYPE);
  const step = stepNames.llm(id);
  const input = num(report.inputTokens);
  const output = num(report.outputTokens);
  await bestEffort(g, `LLM call ${id}`, () =>
    evaluateStep(ctx, g, step, () => [
      activityStartedEvent(g, step, {
        activityId: id,
        activityType: LLM_ACTIVITY_TYPE,
        input: { prompt: report.prompt ?? null },
        semanticType: "LLM_CALL"
      }),
      activityCompletedEvent(g, step, {
        activityId: id,
        activityType: LLM_ACTIVITY_TYPE,
        status: report.error === undefined ? "completed" : "failed",
        ...(report.error !== undefined ? { error: errorInfoOf(report.error) } : {}),
        result: toJson({
          llm_model: report.model ?? null,
          input_tokens: input,
          output_tokens: output,
          total_tokens: input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null,
          completion: report.completion ?? null,
          has_tool_calls: report.hasToolCalls ?? false
        }),
        ...(num(report.durationMs) !== null ? { durationMs: report.durationMs as number } : {})
      })
    ])
  );
}

/** What `describe` extracts from the model's response. */
export type LlmCallResult = Omit<LlmCallReport, "prompt" | "error" | "durationMs">;

function outputOf(r: LlmCallResult): Record<string, unknown> {
  const input = num(r.inputTokens);
  const output = num(r.outputTokens);
  return {
    llm_model: r.model ?? null,
    input_tokens: input,
    output_tokens: output,
    total_tokens: input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null,
    completion: r.completion ?? null,
    has_tool_calls: r.hasToolCalls ?? false
  };
}

/** Run `fn` inside the llm_call activity's span scope (when spans are enabled for this runtime). */
function inLlmScope<T>(g: GovernanceContext, id: string, fn: () => Promise<T>): Promise<T> {
  const binder = g.rt.spanBinder;
  if (!binder) return fn();
  return binder.run(
    {
      workflowId: g.workflowId,
      runId: g.runId,
      workflowType: g.workflowType,
      activityId: id,
      activityType: LLM_ACTIVITY_TYPE,
      agentName: g.agentName,
      sessionId: g.sessionId,
      multiAgentSessionId: g.multiAgentSessionId,
      approved: false
    },
    fn
  );
}

/**
 * Report an LLM call as an `llm_call` activity around the call itself (telemetry only: verdicts
 * are not enforced, reporting failures never fail the agent):
 *
 * ```ts
 * const res = await governedLlmCall(ctx, { prompt: message },
 *   () => ctx.run("LLM call", () => callLLM(messages)),
 *   (r) => ({ model: r.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, completion: r.text }));
 * ```
 *
 * `call` must journal the model call itself (`ctx.run`, or `durableCalls`): on replay its result
 * comes from the journal, no HTTP request is made, and neither event is re-sent.
 */
export async function governedLlmCall<T>(
  ctx: restate.Context,
  info: { prompt?: string | null; model?: string | null },
  call: () => Promise<T>,
  describe: (result: T) => LlmCallResult
): Promise<T> {
  const g = requireGovernanceContext(ctx);
  const id = activityIdFor(g, LLM_ACTIVITY_TYPE);
  const pre = stepNames.llmPre(id);
  const post = stepNames.llmPost(id);
  let startedAt: number | null = null;
  await bestEffort(g, `LLM call ${id}`, async () => {
    const rec = await evaluateStep(ctx, g, pre, () => [
      activityStartedEvent(g, pre, {
        activityId: id,
        activityType: LLM_ACTIVITY_TYPE,
        input: { prompt: info.prompt ?? null },
        semanticType: "LLM_CALL"
      })
    ]);
    startedAt = rec.at ?? null;
  });
  const duration = (now: number) => (startedAt !== null ? now - startedAt : undefined);

  // Counted as a governed execution so the audit hook does not report the same call again.
  g.activeTools++;
  let result: T;
  try {
    result = await inLlmScope(g, id, call);
  } catch (err) {
    g.activeTools--;
    if (!(err instanceof Error && restateInternal.isSuspendedError(err)) && !g.halted) {
      await bestEffort(g, `LLM call ${id}`, () =>
        evaluateStep(ctx, g, post, (now) => [
          activityCompletedEvent(g, post, {
            activityId: id,
            activityType: LLM_ACTIVITY_TYPE,
            status: "failed",
            error: errorInfoOf(err),
            durationMs: duration(now),
            result: toJson(outputOf({ model: info.model ?? null }))
          })
        ])
      );
    }
    throw err;
  }
  g.activeTools--;

  let described: LlmCallResult;
  try {
    described = describe(result);
  } catch {
    described = {};
  }
  await bestEffort(g, `LLM call ${id}`, () =>
    evaluateStep(ctx, g, post, (now) => [
      activityCompletedEvent(g, post, {
        activityId: id,
        activityType: LLM_ACTIVITY_TYPE,
        status: "completed",
        result: toJson(outputOf({ model: info.model ?? null, ...described })),
        durationMs: duration(now)
      })
    ])
  );
  return result;
}
