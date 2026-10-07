/**
 * Live smoke test against a real OpenBox sandbox (architecture §22.2 / §22.3).
 *
 * Skipped unless OPENBOX_API_URL (or OPENBOX_URL) and OPENBOX_API_KEY are set,
 * either in the environment or in the repo-root `.env` file.
 *
 * Expected sandbox policies (architecture §22.1):
 *   get_weather → ALLOW, delete_* → BLOCK, wire_money → HALT, send_email → REQUIRE_APPROVAL
 *
 * The approval test needs a human to click Approve in the OpenBox dashboard;
 * it only runs when OPENBOX_LIVE_APPROVAL=1.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as restate from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OpenBoxRestate, governedRun, isBlocked, openboxHandler } from "../../src/index.js";

const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const hasCreds = Boolean((process.env["OPENBOX_API_URL"] ?? process.env["OPENBOX_URL"]) && process.env["OPENBOX_API_KEY"]);
const liveApproval = process.env["OPENBOX_LIVE_APPROVAL"] === "1";

const rt = hasCreds ? new OpenBoxRestate({ agentName: "restate-sdk-smoke", approvalPollIntervalMs: 3_000, approvalWaitCapMs: 10 * 60_000 }) : null;

const smoke = restate.service({
  name: "openboxSmoke",
  handlers: {
    tool: openboxHandler(
      async (ctx: restate.Context, req: { tool: string; input: unknown }) => {
        try {
          const r = await governedRun(ctx, req.tool, { input: req.input, toolCallId: "call_1" }, async (i) =>
            ctx.run(`run ${req.tool}`, () => ({ ok: true, echo: i }))
          );
          return { blocked: isBlocked(r), result: r };
        } catch (e) {
          return { error: e instanceof Error ? e.constructor.name : String(e) };
        }
      },
      { ...(rt ? { runtime: rt } : {}), promptFrom: (req) => `smoke test: call ${req.tool}` }
    )
  }
});

describe.skipIf(!hasCreds)("live OpenBox sandbox", () => {
  let env: RestateTestEnvironment;
  let client: ReturnType<ReturnType<typeof clients.connect>["serviceClient"]>;

  beforeAll(async () => {
    env = await RestateTestEnvironment.start({ services: [smoke] });
    client = clients.connect({ url: env.baseUrl() }).serviceClient(smoke) as never;
  }, 180_000);
  afterAll(async () => env?.stop());

  const call = (tool: string, input: unknown) => (client as unknown as { tool: (r: unknown) => Promise<Record<string, unknown>> }).tool({ tool, input });

  it("ALLOW: get_weather runs", async () => {
    const out = await call("get_weather", { city: "Paris" });
    expect(out["blocked"]).toBe(false);
    expect(out["result"]).toMatchObject({ ok: true });
  });

  it("BLOCK: delete_records is returned as a BlockedResult", async () => {
    const out = await call("delete_records", { table: "users" });
    expect(out["blocked"]).toBe(true);
  });

  it("HALT: wire_money ends the session even if user code catches it", async () => {
    // The handler above swallows the GovernanceHaltError; openboxHandler must still end the invocation (§9).
    await expect(call("wire_money", { amount: 5000 })).rejects.toThrow(/OpenBox HALT/);
  });

  it.skipIf(!liveApproval)(
    "REQUIRE_APPROVAL: send_email waits for a human (approve it in the dashboard)",
    async () => {
      // Fire-and-forget, then re-attach: a single ingress call would hit undici's 5 min headers timeout
      // while the invocation is suspended waiting for the reviewer.
      const ingress = clients.connect({ url: env.baseUrl() });
      const send = await (ingress.serviceSendClient(smoke) as unknown as {
        tool: (r: unknown, o: unknown) => Promise<clients.Send<Record<string, unknown>>>;
      }).tool({ tool: "send_email", input: { to: "test@example.com" } }, clients.rpc.sendOpts({ idempotencyKey: `smoke-approval-${Date.now()}` }));
      console.log(`waiting for approval (invocation ${send.invocationId}) — approve send_email in the OpenBox dashboard`);
      let out: Record<string, unknown> | undefined;
      while (out === undefined) {
        try {
          out = await ingress.result(send);
        } catch (e) {
          if ((e as { cause?: { code?: string } }).cause?.code !== "UND_ERR_HEADERS_TIMEOUT") throw e;
        }
      }
      expect(out["result"]).toMatchObject({ ok: true });
    },
    11 * 60_000
  );
});
