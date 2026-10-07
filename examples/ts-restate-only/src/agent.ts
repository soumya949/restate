/**
 * Restate durable agent (no framework) governed by OpenBox.
 *
 * Based on restatedev/ai-examples `typescript-restate-only/template`. The only
 * OpenBox changes are marked `// OPENBOX`:
 *   1. the handler is wrapped with `openboxHandler`
 *   2. each tool call goes through `governedCall` (policy check → maybe wait
 *      for human approval → run → report), and a blocked call is fed back to
 *      the LLM as the tool result instead of crashing the agent.
 *   3. `enableOpenBoxSpans()` reports the HTTP calls each tool makes as spans
 *   4. `reportLlmCall` reports each LLM call (model, tokens) for OpenBox's Model Usage
 *      of that tool's activity (each span also gets a verdict).
 */
import { existsSync } from "node:fs";

import { governedCall, isBlocked, openboxHandler, reportLlmCall } from "@openbox-ai/openbox-restate-sdk"; // OPENBOX
import { enableOpenBoxSpans } from "@openbox-ai/openbox-restate-sdk/instrumentation"; // OPENBOX
import * as restate from "@restatedev/restate-sdk";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";

import { callLLM, InputMessage, toolResult } from "./utils.js";

const envFile = new URL("../../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

enableOpenBoxSpans(); // OPENBOX: after the env is loaded, before serving

// TOOL DEFINITIONS — one per sandbox policy (architecture §22.1)
const tools = {
  get_weather: tool({
    description: "Get current weather for a city",
    inputSchema: z.object({ city: z.string() })
  }),
  send_email: tool({
    description: "Send an email",
    inputSchema: z.object({ to: z.string(), subject: z.string(), body: z.string() })
  }),
  delete_records: tool({
    description: "Delete records from a database table",
    inputSchema: z.object({ table: z.string() })
  }),
  wire_money: tool({
    description: "Wire money to an account",
    inputSchema: z.object({ account: z.string(), amount: z.number() })
  })
};

// TOOL IMPLEMENTATIONS — each journals its own side effect with ctx.run
async function runTool(ctx: restate.Context, name: string, input: any): Promise<unknown> {
  switch (name) {
    case "get_weather":
      return ctx.run(`get weather ${input.city}`, () => fetchWeather(input.city));
    case "send_email":
      // Stand-in for a real email API: the POST shows up as an http_request span.
      return ctx.run("send email", async () => {
        const res = await fetch("https://httpbin.org/post", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input)
        });
        return { sent: res.ok, to: input.to };
      });
    case "delete_records":
      return ctx.run("delete records", () => ({ deleted: 42, table: input.table }));
    case "wire_money":
      return ctx.run("wire money", () => ({ wired: input.amount, account: input.account }));
    default:
      return `Tool not found: ${name}`;
  }
}

async function fetchWeather(city: string) {
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`;
  const geo = (await (await fetch(geoUrl)).json()) as {
    results?: Array<{ latitude: number; longitude: number; name: string }>;
  };
  const place = geo.results?.[0];
  if (!place) return { error: `unknown city ${city}` };
  const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,wind_speed_10m`;
  const wx = (await (await fetch(wxUrl)).json()) as { current?: Record<string, number> };
  return { city: place.name, ...wx.current };
}

// <start_here>
// AGENT
const run = openboxHandler( // OPENBOX
  async (ctx: restate.Context, { message }: { message: string }) => {
    const messages: ModelMessage[] = [
      { role: "system", content: "You are a helpful assistant. Use the tools when asked." },
      { role: "user", content: message }
    ];

    while (true) {
      const result = await ctx.run("LLM call", async () => await callLLM(messages, tools), { maxRetryAttempts: 3 });
      await reportLlmCall(ctx, { // OPENBOX
        model: result.model,
        prompt: message,
        completion: result.text || null,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        hasToolCalls: result.toolCalls.length > 0
      });
      messages.push(...result.messages);
      if (result.finishReason !== "tool-calls") return result.text;

      // Tool calls are governed one at a time, in the order the model emitted them.
      for (const { toolName, toolCallId, input } of result.toolCalls) {
        const output = await governedCall(ctx, { toolName, toolCallId, input }, (i) => runTool(ctx, toolName, i)); // OPENBOX
        messages.push(
          toolResult(toolCallId, toolName, isBlocked(output) ? `Blocked by policy: ${output.reason}` : output)
        );
      }
    }
  },
  { agentName: "restate-only-agent", promptFrom: (input) => input.message } // OPENBOX
);

// <end_here>

const agentService = restate.service({
  name: "agent",
  handlers: {
    run: restate.createServiceHandler({ input: restate.serde.schema(InputMessage) }, run)
  },
  options: { onJournalMismatchErrors: "pause" } // OPENBOX: rollout rule (architecture §10 I7)
});

restate.serve({ services: [agentService], port: Number(process.env["PORT"] ?? 9080) });
