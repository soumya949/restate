/**
 * PARENT agent: the lead, with the main OpenBox identity (OPENBOX_* in .env).
 *
 * Its `ask_research_agent` tool delegates to the research agent over Restate RPC through
 * `governedSubAgent`: the delegation is itself a governed activity (`call:research`), and
 * the headers it passes make the research agent part of the same Multi-Agent Session.
 */
import { existsSync } from "node:fs";

import { openai } from "@ai-sdk/openai";
import { governedSubAgent, isBlocked, openboxHandler } from "@openbox-ai/openbox-restate-sdk";
import * as restate from "@restatedev/restate-sdk";
import { durableCalls } from "@restatedev/vercel-ai-middleware";
import { generateText, stepCountIs, tool, wrapLanguageModel } from "ai";
import { z } from "zod";

import type { ResearchApi } from "./research.js";

const envFile = new URL("../../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const Research: ResearchApi = { name: "research" } as ResearchApi;

// <start_here>
const lead = restate.service({
  name: "lead",
  handlers: {
    run: openboxHandler(
      async (ctx: restate.Context, { prompt }: { prompt: string }) => {
        const { text } = await generateText({
          model: wrapLanguageModel({
            model: openai(process.env["OPENAI_MODEL"] ?? "gpt-5.4"),
            middleware: durableCalls(ctx, { maxRetryAttempts: 3 })
          }),
          system: "You are a lead agent. Delegate research questions to the research agent, then answer.",
          prompt,
          tools: {
            ask_research_agent: tool({
              description: "Ask the research agent a question. It can look up live weather.",
              inputSchema: z.object({ question: z.string() }),
              execute: async ({ question }, { toolCallId }) => {
                const out = await governedSubAgent(ctx, { agentName: "research", input: { question }, toolCallId }, (input, headers) =>
                  ctx.serviceClient(Research).run(input, restate.rpc.opts({ headers }))
                );
                return isBlocked(out) ? `Blocked by policy: ${out.reason}` : out;
              }
            })
          },
          stopWhen: [stepCountIs(5)],
          providerOptions: { openai: { parallelToolCalls: false } }
        });
        return text;
      },
      { agentName: "lead-agent", promptFrom: (i) => i.prompt }
    )
  },
  options: { onJournalMismatchErrors: "pause" }
});

// <end_here>

restate.serve({ services: [lead], port: Number(process.env["PORT"] ?? 9082) });
