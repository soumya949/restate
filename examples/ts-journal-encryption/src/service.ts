/** The governed agent, shared by the server (app.ts) and the caller (call.ts). No side effects. */
import { governedRun, isBlocked, openboxHandler } from "@openbox-ai/openbox-restate-sdk";
import * as restate from "@restatedev/restate-sdk";

export const agent = restate.service({
  name: "encryptedAgent",
  handlers: {
    run: openboxHandler(
      async (ctx: restate.Context, { city }: { city: string }) => {
        const out = await governedRun(ctx, "get_weather", { input: { city }, toolCallId: "call_1" }, (i) =>
          ctx.run("weather", () => ({ city: i.city, temperature: 23 }))
        );
        return isBlocked(out) ? `Blocked by policy: ${out.reason}` : out;
      },
      { agentName: "encrypted-agent", promptFrom: (i) => `weather in ${i.city}` }
    )
  }
});

export type EncryptedAgent = typeof agent;
