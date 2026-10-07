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
 * Frameworks: the Vercel AI SDK middleware (`openboxLlmTelemetry`, subpath
 * `./vercel-ai`) calls this for you. In a raw agent loop, call
 * `reportLlmCall(ctx, ...)` after the journaled LLM call.
 */

import type * as restate from "@restatedev/restate-sdk";

import { requireGovernanceContext } from "./context.js";
import { activityCompletedEvent, activityStartedEvent, errorInfoOf, toJson } from "./events.js";
import { activityIdFor, stepNames } from "./ids.js";
import { bestEffort, evaluateStep } from "./steps.js";

export const LLM_ACTIVITY_TYPE = "llm_call";

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
