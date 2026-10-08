/**
 * `@openbox-ai/openbox-restate-sdk/vercel-ai` — govern Vercel AI SDK tools (architecture §11.1).
 *
 * One diff on top of Restate's `vercel-ai` template:
 *
 * ```ts
 * const { text } = await generateText({
 *   model,                                    // wrapLanguageModel({ model, middleware: durableCalls(ctx) })
 *   tools: governTools(ctx, { getWeather: tool({ ..., execute }) }),
 *   providerOptions: { openai: { parallelToolCalls: false } },
 * });
 * ```
 *
 * Each tool's `execute` is wrapped in `governedRun`, keyed by the AI SDK's
 * `toolCallId`, so the activity id is stable across replays. A BLOCK comes
 * back to the model as the tool result (a `BlockedResult`), never as a thrown
 * error, so the agent can explain it or try something else.
 *
 * The only module that imports `ai` (types only); kept off the package root.
 * Also exports `openboxLlmTelemetry(ctx)`, a model middleware that reports LLM calls.
 */

import type * as restate from "@restatedev/restate-sdk";
import type { LanguageModelMiddleware, ToolExecutionOptions, ToolSet } from "ai";

import { getGovernanceContext } from "./context.js";
import { OpenBoxContractError } from "./errors.js";
import { governedRun, haltedError, type GovernedRunOptions } from "./governed-run.js";
import { llmPrePhase, llmRun, type LlmPre } from "./llm.js";


export interface GovernToolsOptions {
  /** Semantic event type per tool name (`EMAIL_SEND`, `DATABASE_WRITE`, …). */
  toolTypeMap?: Record<string, string>;
  /** Logical agent within the invocation (in-process sub-agents). */
  agentId?: string;
  /** Wrap each tool body in its own `ctx.run`. Only for bodies that never use `ctx`. Default false. */
  wrapInRun?: boolean;
  /** `"return"` (default): a BlockedResult goes back to the model. `"throw"`: the tool call fails. */
  onBlock?: GovernedRunOptions["onBlock"];
}

// One warning per invocation per key.
const warned = new WeakMap<object, Set<string>>();

function warnOnce(ctx: object, key: string, log: (m: string) => void, message: string): void {
  const seen = warned.get(ctx) ?? new Set<string>();
  warned.set(ctx, seen);
  if (seen.has(key)) return;
  seen.add(key);
  log(message);
}

/** Drain a streaming tool result; the AI SDK uses the last yielded value as the output. */
async function settle(out: unknown): Promise<unknown> {
  if (out !== null && typeof out === "object" && Symbol.asyncIterator in out) {
    let last: unknown = undefined;
    for await (const v of out as AsyncIterable<unknown>) last = v;
    return last;
  }
  return out;
}

/**
 * Return a copy of `tools` where every tool with an `execute` runs through
 * OpenBox governance. Tools without `execute` (client-side tools) pass through.
 * Call it inside an `openboxHandler`-wrapped handler.
 */
export function governTools<T extends ToolSet>(ctx: restate.Context, tools: T, opts: GovernToolsOptions = {}): T {
  const g = getGovernanceContext(ctx);
  if (!g) {
    throw new OpenBoxContractError("governTools used outside an openboxHandler-wrapped handler. Wrap the handler with openboxHandler(...).");
  }
  const log = (m: string) => g.rt.logger.warn(m);
  // The AI SDK runs a step's tool calls concurrently, in tool-call order. Governed calls are
  // chained so each one's checks (and the tool itself) run in that order, never interleaved:
  // the governance timeline is deterministic even without parallelToolCalls: false.
  let tail: Promise<unknown> = Promise.resolve();

  const out: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(tools)) {
    const original = t.execute;
    if (!original) {
      warnOnce(ctx, `client:${name}`, log, `OpenBox: tool "${name}" has no execute (client-side tool); it is not governed.`);
      out[name] = t;
      continue;
    }
    if (t.needsApproval) {
      warnOnce(
        ctx,
        `needsApproval:${name}`,
        log,
        `OpenBox: tool "${name}" sets needsApproval. Use OpenBox REQUIRE_APPROVAL policies instead; combining both asks twice.`
      );
    }
    out[name] = {
      ...t,
      execute: (input: unknown, exec: ToolExecutionOptions<unknown>) => {
        const run = tail.then(() =>
          governedRun(
            ctx,
            name,
            { input, toolCallId: exec.toolCallId, type: opts.toolTypeMap?.[name] ?? null, agentId: opts.agentId ?? null },
            async (i) => settle(await original(i as never, exec as never)),
            { wrapInRun: opts.wrapInRun ?? false, onBlock: opts.onBlock ?? "return" }
          )
        );
        tail = run.catch(() => undefined);
        return run;
      }
    };
  }
  return out as T;
}

/** Text of the latest user turn in an AI SDK prompt. */
function latestUserText(prompt: ReadonlyArray<{ role: string; content: unknown }>): string | null {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((p: { type?: string; text?: string }) => (p.type === "text" ? p.text : undefined))
        .filter((t): t is string => typeof t === "string")
        .join(" ");
      return text || null;
    }
  }
  return null;
}

/** Replace the text of the latest user turn with `text` (other parts, e.g. files, are kept). */
function withLatestUserText<P extends ReadonlyArray<{ role: string; content: unknown }>>(prompt: P, text: string): P {
  const i = [...prompt].map((m) => m.role).lastIndexOf("user");
  if (i < 0) return prompt;
  const m = prompt[i]!;
  const others = Array.isArray(m.content) ? m.content.filter((c: { type?: string }) => c.type !== "text") : [];
  const copy = [...prompt];
  copy[i] = { ...m, content: [{ type: "text", text }, ...others] };
  return copy as unknown as P;
}

/**
 * Govern every model call as an `llm_call` activity (model, tokens, completion; with spans the
 * provider request is its span). Enforced like a tool call:
 *  - input guardrails (e.g. PII redaction) rewrite the user prompt BEFORE the provider sees it;
 *  - HALT / BLOCK / a failed guardrail refuse the call; REQUIRE_APPROVAL waits durably.
 *
 * Put it BEFORE `durableCalls`: its `transformParams` runs first, so the redacted request is the
 * one journaled and sent, and on replay neither the request nor any event is repeated.
 *
 * ```ts
 * wrapLanguageModel({ model, middleware: [openboxLlmTelemetry(ctx), durableCalls(ctx)] })
 * ```
 */
export function openboxLlmTelemetry(ctx: restate.Context): LanguageModelMiddleware {
  // transformParams (PRE) and wrapGenerate (EXECUTE + POST) of the same call, in order.
  const pending: LlmPre[] = [];
  return {
    transformParams: async ({ params, model }) => {
      // After a HALT the AI SDK would still call the model again (it turns the tool's error into a
      // tool result). The session is over: stop before spending an ungoverned LLM call.
      const g = getGovernanceContext(ctx);
      if (g?.halted) throw haltedError(g);
      const prompt = latestUserText(params.prompt as ReadonlyArray<{ role: string; content: unknown }>);
      const pre = await llmPrePhase(ctx, { prompt, model: model.modelId });
      pending.push(pre);
      if (!pre.redacted || pre.prompt === null) return params;
      return { ...params, prompt: withLatestUserText(params.prompt, pre.prompt) };
    },
    wrapGenerate: async ({ doGenerate, model }) => {
      const pre = pending.shift();
      if (!pre) return doGenerate(); // not called through transformParams (should not happen)
      return llmRun(ctx, pre, model.modelId, async () => await doGenerate(), (result) => {
        const content = result.content as ReadonlyArray<{ type: string; text?: string }>;
        const completion = content
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("");
        return {
          model: model.modelId,
          completion: completion || null,
          inputTokens: result.usage.inputTokens.total ?? null,
          outputTokens: result.usage.outputTokens.total ?? null,
          hasToolCalls: content.some((c) => c.type === "tool-call")
        };
      });
    }
  };
}
