/**
 * CHILD agent: a research agent with its own OpenBox identity (CHILD_OPENBOX_* in .env).
 *
 * It is a normal governed handler. When the lead calls it with `governedSubAgent`, the
 * x-openbox-* headers make it join the lead's Multi-Agent Session and send the Handoff.
 */
import { existsSync } from "node:fs";

import { openai } from "@ai-sdk/openai";
import { createOpenBoxRestate, openboxHandler } from "@openbox-ai/openbox-restate-sdk";
import { enableOpenBoxSpans } from "@openbox-ai/openbox-restate-sdk/instrumentation";
import { governTools, openboxLlmTelemetry } from "@openbox-ai/openbox-restate-sdk/vercel-ai";
import * as restate from "@restatedev/restate-sdk";
import { durableCalls } from "@restatedev/vercel-ai-middleware";
import { generateText, stepCountIs, tool, wrapLanguageModel } from "ai";
import { z } from "zod";

const envFile = new URL("../../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const childKey = process.env["CHILD_OPENBOX_API_KEY"];
if (!childKey) throw new Error("Set CHILD_OPENBOX_API_KEY (+ CHILD_OPENBOX_AGENT_DID / _PRIVATE_KEY) in .env for the child agent");

// The child's own OpenBox identity. `environ: {}` keeps the lead's OPENBOX_* variables out of it:
// otherwise a missing child DID would silently fall back to the PARENT's DID and key.
const rt = createOpenBoxRestate({
  environ: {},
  apiUrl: process.env["OPENBOX_API_URL"] ?? process.env["OPENBOX_URL"],
  apiKey: childKey,
  ...(process.env["CHILD_OPENBOX_AGENT_DID"]
    ? { agentDid: process.env["CHILD_OPENBOX_AGENT_DID"], agentPrivateKey: process.env["CHILD_OPENBOX_AGENT_PRIVATE_KEY"] }
    : {}),
  agentName: "research-agent"
});
enableOpenBoxSpans({ runtime: rt });

export type ResearchApi = typeof research;

// <start_here>
const research = restate.service({
  name: "research",
  handlers: {
    run: openboxHandler(
      async (ctx: restate.Context, { question }: { question: string }) => {
        const { text } = await generateText({
          model: wrapLanguageModel({
            model: openai(process.env["OPENAI_MODEL"] ?? "gpt-5.4"),
            middleware: [openboxLlmTelemetry(ctx), durableCalls(ctx, { maxRetryAttempts: 3 })]
          }),
          system: "You are a research agent. Use the tools, answer briefly with facts.",
          prompt: question,
          tools: governTools(ctx, {
            get_weather: tool({
              description: "Get the current weather for a given city.",
              inputSchema: z.object({ city: z.string() }),
              execute: async ({ city }) =>
                ctx.run(`get weather ${city}`, async () => {
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
                })
            })
          }),
          stopWhen: [stepCountIs(5)],
          providerOptions: { openai: { parallelToolCalls: false } }
        });
        return text;
      },
      { runtime: rt, promptFrom: (i) => i.question }
    )
  },
  options: { onJournalMismatchErrors: "pause" }
});

// <end_here>

// Restate Cloud: accept only requests signed by your environment (comma-separated publickeyv1_… keys).
const identityKeys = process.env["RESTATE_IDENTITY_KEYS"]?.split(",").filter(Boolean);
restate.serve({ services: [research], port: Number(process.env["PORT"] ?? 9083), ...(identityKeys?.length ? { identityKeys } : {}) });
