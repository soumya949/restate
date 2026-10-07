/**
 * Restate + Vercel AI SDK agent governed by OpenBox.
 *
 * Based on restatedev/ai-examples `vercel-ai/template`. The OpenBox changes are marked `// OPENBOX`:
 *   1. the handler is wrapped with `openboxHandler`
 *   2. the tools passed to `generateText` go through `governTools(ctx, ...)`
 *   3. `enableOpenBoxSpans()` reports the HTTP calls each tool makes as spans
 */
import { existsSync } from "node:fs";

import { openai } from "@ai-sdk/openai";
import { openboxHandler } from "@openbox-ai/openbox-restate-sdk"; // OPENBOX
import { enableOpenBoxSpans } from "@openbox-ai/openbox-restate-sdk/instrumentation"; // OPENBOX
import { governTools } from "@openbox-ai/openbox-restate-sdk/vercel-ai"; // OPENBOX
import * as restate from "@restatedev/restate-sdk";
import { durableCalls } from "@restatedev/vercel-ai-middleware";
import { generateText, stepCountIs, tool, wrapLanguageModel } from "ai";
import { z } from "zod";

const envFile = new URL("../../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

enableOpenBoxSpans(); // OPENBOX: after the env is loaded, before serving

// TOOLS — one per sandbox policy; each journals its side effect with ctx.run
async function getWeather(ctx: restate.Context, city: string) {
  return ctx.run(`get weather ${city}`, async () => {
    const geo = (await (
      await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`)
    ).json()) as { results?: Array<{ latitude: number; longitude: number; name: string }> };
    const place = geo.results?.[0];
    if (!place) return { error: `unknown city ${city}` };
    const wx = (await (
      await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,wind_speed_10m`
      )
    ).json()) as { current?: Record<string, number> };
    return { city: place.name, ...wx.current };
  });
}

// AGENT
const run = openboxHandler( // OPENBOX
  async (ctx: restate.Context, { prompt }: { prompt: string }) => {
    const model = wrapLanguageModel({
      model: openai(process.env["OPENAI_MODEL"] ?? "gpt-5.4"),
      // Persist LLM responses
      middleware: durableCalls(ctx, { maxRetryAttempts: 3 })
    });

    const { text } = await generateText({
      model,
      system: "You are a helpful agent. Use the tools when asked.",
      prompt,
      tools: governTools(ctx, { // OPENBOX
        get_weather: tool({
          description: "Get the current weather for a given city.",
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => getWeather(ctx, city)
        }),
        send_email: tool({
          description: "Send an email.",
          inputSchema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
          // Stand-in for a real email API: the POST shows up as an http_request span.
          execute: async (email) =>
            ctx.run("send email", async () => {
              const res = await fetch("https://httpbin.org/post", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(email)
              });
              return { sent: res.ok, to: email.to };
            })
        }),
        delete_records: tool({
          description: "Delete records from a database table.",
          inputSchema: z.object({ table: z.string() }),
          execute: async ({ table }) => ctx.run("delete records", () => ({ deleted: 42, table }))
        }),
        wire_money: tool({
          description: "Wire money to an account.",
          inputSchema: z.object({ account: z.string(), amount: z.number() }),
          execute: async ({ account, amount }) => ctx.run("wire money", () => ({ wired: amount, account }))
        })
      }),
      stopWhen: [stepCountIs(5)],
      providerOptions: { openai: { parallelToolCalls: false } }
    });

    return text;
  },
  { agentName: "vercel-ai-agent", promptFrom: (input) => input.prompt } // OPENBOX
);

// AGENT SERVICE
const agent = restate.service({
  name: "vercelAgent",
  handlers: {
    run: restate.createServiceHandler(
      {
        input: restate.serde.schema(z.object({ prompt: z.string().default("What's the weather in San Francisco?") }))
      },
      run
    )
  },
  options: { onJournalMismatchErrors: "pause" } // OPENBOX: rollout rule (architecture §10 I7)
});

restate.serve({ services: [agent], port: Number(process.env["PORT"] ?? 9081) });
