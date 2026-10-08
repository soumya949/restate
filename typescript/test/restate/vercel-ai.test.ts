/**
 * `governTools` end-to-end: Restate's vercel-ai template shape (generateText +
 * durableCalls) with a mock model, against a real Restate server with
 * alwaysReplay=true (architecture §22.4 task 4).
 */

import * as restate from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { durableCalls } from "@restatedev/vercel-ai-middleware";
import { generateText, stepCountIs, tool, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { OpenBoxRestate, openboxHandler } from "../../src/index.js";
import { governTools, openboxLlmTelemetry } from "../../src/vercel-ai.js";
import { FakeCore } from "../helpers/fake-core.js";

const core = new FakeCore();
const warnings: string[] = [];
const rt = new OpenBoxRestate({
  apiUrl: "http://localhost:8787",
  apiKey: "obx_test_restatesdk",
  environ: {},
  fetchImpl: (...a) => core.fetchImpl(...a),
  logger: { info: () => {}, warn: (m: string) => warnings.push(m), error: () => {} },
  governanceMaxRetries: 2,
  approvalPollIntervalMs: 100
});

const ran: string[] = [];
/** Every user prompt text the model actually received (what the provider would see). */
const seenPrompts: string[] = [];
type Call = { id: string; name: string; input: Record<string, unknown> };

/** A model that asks for `calls` on its first step and answers with text once it has tool results. */
function mockModel(calls: Call[]) {
  const usage = {
    inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 }
  };
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      for (const m of options.prompt)
        if (m.role === "user") for (const c of m.content) if (c.type === "text") seenPrompts.push(c.text);
      const toolResults = options.prompt.filter((m) => m.role === "tool").flatMap((m) => m.content);
      if (toolResults.length === 0) {
        return {
          content: calls.map((c) => ({ type: "tool-call" as const, toolCallId: c.id, toolName: c.name, input: JSON.stringify(c.input) })),
          finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
          usage,
          warnings: []
        };
      }
      return {
        content: [{ type: "text" as const, text: `done: ${JSON.stringify(toolResults.map((r) => (r as { output?: unknown }).output))}` }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: []
      };
    }
  });
}

const scripts: Record<string, Call[]> = {
  weather: [{ id: "call_w1", name: "getWeather", input: { city: "Paris" } }],
  delete: [{ id: "call_d1", name: "deleteRecords", input: { table: "users" } }],
  wire: [{ id: "call_x1", name: "deleteRecords", input: { table: "ledger" } }],
  both: [
    { id: "call_p1", name: "getWeather", input: { city: "Rome" } },
    { id: "call_p2", name: "getWeather", input: { city: "Oslo" } }
  ]
};

const agent = restate.service({
  name: "aiAgent",
  handlers: {
    run: openboxHandler(
      async (ctx: restate.Context, { script }: { script: string }) => {
        const model = wrapLanguageModel({
          model: mockModel(scripts[script]!),
          middleware: [openboxLlmTelemetry(ctx), durableCalls(ctx, { maxRetryAttempts: 3 })]
        });
        const { text } = await generateText({
          model,
          prompt: `run ${script}`,
          tools: governTools(ctx, {
            getWeather: tool({
              description: "weather",
              inputSchema: z.object({ city: z.string() }),
              execute: async ({ city }) =>
                ctx.run(`get weather ${city}`, () => {
                  ran.push(`weather:${city}`);
                  return { city, temperature: 23 };
                })
            }),
            // Client-side tool (no execute): passed through ungoverned, with a warning.
            askUser: tool({ description: "ask the user", inputSchema: z.object({ q: z.string() }) }),
            deleteRecords: tool({
              description: "delete",
              inputSchema: z.object({ table: z.string() }),
              execute: async ({ table }) =>
                ctx.run("delete", () => {
                  ran.push(`delete:${table}`);
                  return { deleted: 1 };
                })
            })
          }),
          stopWhen: [stepCountIs(5)]
        });
        return text;
      },
      { runtime: rt, agentName: "vercel-agent", promptFrom: (i) => `run ${i.script}` }
    )
  }
});

let env: RestateTestEnvironment;
let run: (script: string) => Promise<string>;

beforeAll(async () => {
  env = await RestateTestEnvironment.start({ services: [agent], alwaysReplay: true });
  const c = clients.connect({ url: env.baseUrl() }).serviceClient(agent);
  run = (script) => (c as unknown as { run: (i: { script: string }) => Promise<string> }).run({ script });
}, 180_000);
afterAll(async () => env?.stop());
beforeEach(() => {
  core.reset();
  ran.length = 0;
  seenPrompts.length = 0;
  warnings.length = 0;
});

describe("governTools (Vercel AI SDK)", () => {
  it("governs a tool call keyed by the AI SDK toolCallId, exactly once across replays", async () => {
    const text = await run("weather");
    expect(text).toContain("Paris");
    expect(ran).toEqual(["weather:Paris"]);

    const started = core.evaluations("ActivityStarted", "getWeather");
    expect(started).toHaveLength(1);
    expect(started[0]!.activityId).toMatch(/:call_w1$/);
    expect(started[0]!.body["activity_input"]).toEqual([{ city: "Paris" }]);
    expect(core.evaluations("ActivityCompleted", "getWeather")).toHaveLength(1);
    expect(core.evaluations("WorkflowStarted")).toHaveLength(1);
    expect(core.evaluations("WorkflowCompleted")).toHaveLength(1);
    expect(warnings.some((w) => w.includes('"askUser" has no execute'))).toBe(true);
  });

  it("reports each model call once as an llm_call activity with model and tokens (despite replays)", async () => {
    await run("weather");
    const started = core.evaluations("ActivityStarted", "llm_call");
    const completed = core.evaluations("ActivityCompleted", "llm_call");
    // Two model calls: one asking for the tool, one answering with its result.
    expect(started).toHaveLength(2);
    expect(completed).toHaveLength(2);
    expect(started[0]!.body["activity_input"]).toEqual([{ prompt: "run weather" }]);
    expect(completed[0]!.body["activity_output"]).toMatchObject({
      llm_model: "mock-model-id",
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
      has_tool_calls: true
    });
    expect(completed[1]!.body["activity_output"]).toMatchObject({ has_tool_calls: false, completion: expect.stringContaining("Paris") });
  });

  it("an input guardrail's redaction reaches the model, not the original prompt", async () => {
    // Shape OpenBox returned live for a PII guardrail with "Block on violation" off.
    core.rule((b) =>
      b["activity_type"] === "llm_call" && b["event_type"] === "ActivityStarted"
        ? {
            verdict: "allow",
            guardrails_result: {
              validation_passed: true,
              input_type: "activity_input",
              redacted_input: [{ prompt: "run weather for <EMAIL_ADDRESS>" }],
              reasons: [{ reason: "The following text contains PII" }]
            }
          }
        : undefined
    );
    await run("weather");
    expect(seenPrompts.length).toBeGreaterThan(0);
    expect(seenPrompts.every((t) => t === "run weather for <EMAIL_ADDRESS>")).toBe(true);
    expect(seenPrompts.some((t) => t === "run weather")).toBe(false);
  });

  it("a failed LLM guardrail refuses the model call (terminal)", async () => {
    core.rule((b) =>
      b["activity_type"] === "llm_call" && b["event_type"] === "ActivityStarted"
        ? { verdict: "allow", guardrails_result: { validation_passed: false, reasons: [{ reason: "toxic" }] } }
        : undefined
    );
    await expect(run("weather")).rejects.toThrow(/guardrails failed: toxic/);
    expect(seenPrompts).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("HALT on an LLM call ends the run before the model is called", async () => {
    core.onActivity("llm_call", "ActivityStarted", { verdict: "halt", reason: "model use suspended" });
    await expect(run("weather")).rejects.toThrow(/OpenBox HALT: model use suspended/);
    expect(seenPrompts).toEqual([]);
  });

  it("BLOCK goes back to the model as the tool result; the tool never runs", async () => {
    core.onActivity("deleteRecords", "ActivityStarted", { verdict: "block", reason: "no deletes" });
    const text = await run("delete");
    expect(ran).toEqual([]);
    expect(text).toContain("no deletes");
    expect(text).toContain('"blocked":true');
    expect(core.evaluations("WorkflowCompleted")).toHaveLength(1);
  });

  it("HALT swallowed by the AI SDK (tool error) still ends the invocation, with the policy's reason", async () => {
    core.onActivity("deleteRecords", "ActivityStarted", { verdict: "halt", reason: "fraud pattern" });
    await expect(run("wire")).rejects.toThrow(/OpenBox HALT: fraud pattern/);
    expect(ran).toEqual([]);
    // Core already closed the session on HALT: nothing is sent after it, and the model is not called again.
    expect(core.evaluations("WorkflowFailed")).toHaveLength(0);
    expect(core.evaluations("ActivityStarted", "llm_call")).toHaveLength(1);
    expect(core.evaluations("WorkflowCompleted")).toHaveLength(0);
  });

  it("two tool calls in one step (run concurrently by the AI SDK): governed one at a time, in tool-call order", async () => {
    const text = await run("both");
    expect(text).toContain("Rome");
    expect(text).toContain("Oslo");
    expect([...ran].sort()).toEqual(["weather:Oslo", "weather:Rome"]);
    const ids = core.evaluations("ActivityStarted", "getWeather").map((e) => e.activityId!.split(":").pop());
    expect(ids).toEqual(["call_p1", "call_p2"]);
  });

  it("refuses to run outside an openboxHandler", () => {
    const fakeCtx = {} as restate.Context;
    expect(() => governTools(fakeCtx, {})).toThrow(/openboxHandler/);
  });
});
