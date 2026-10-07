/**
 * openboxAuditHook (architecture §16.2) against a real Restate server with
 * alwaysReplay=true: ungoverned ctx.run calls are audited exactly once;
 * governed tools' own runs and OpenBox's steps are not.
 */

import * as restate from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OpenBoxRestate, governedRun, openboxAuditHook, openboxHandler } from "../../src/index.js";
import { FakeCore } from "../helpers/fake-core.js";

const core = new FakeCore();
const rt = new OpenBoxRestate({
  apiUrl: "http://localhost:8787",
  apiKey: "obx_test_restatesdk",
  environ: {},
  fetchImpl: (...a) => core.fetchImpl(...a),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  governanceMaxRetries: 2
});

const audited = restate.service({
  name: "audited",
  handlers: {
    run: openboxHandler(
      async (ctx: restate.Context, fail: boolean) => {
        // Ungoverned side effects: the hook reports these.
        const quote = await ctx.run("fetch quote", () => ({ price: 42 }));
        await ctx.sleep(10); // a suspension point: forces a replay
        // A governed tool: its own run is already an activity, so the hook skips it.
        const w = await governedRun(ctx, "get_weather", { input: "Paris", toolCallId: "c1" }, (c) =>
          ctx.run("weather api", () => ({ city: c }))
        );
        if (fail) {
          await ctx.run("charge card", () => {
            throw new restate.TerminalError("card declined");
          });
        }
        return { quote, w };
      },
      { runtime: rt, agentName: "audited-agent" }
    )
  },
  options: { hooks: [openboxAuditHook()] }
});

let env: RestateTestEnvironment;
let call: (fail: boolean) => Promise<unknown>;

beforeAll(async () => {
  env = await RestateTestEnvironment.start({ services: [audited], alwaysReplay: true });
  const c = clients.connect({ url: env.baseUrl() }).serviceClient(audited);
  call = (fail) => (c as unknown as { run: (f: boolean) => Promise<unknown> }).run(fail);
}, 180_000);
afterAll(async () => env?.stop());
beforeEach(() => core.reset());

/** Audit events are fire-and-forget: give them a moment to land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20 && core.ledger.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 100));
}

const auditEvents = () => core.evaluations().filter((e) => (e.body["__openbox"] as { audit_only?: boolean } | undefined)?.audit_only);

describe("openboxAuditHook", () => {
  it("audits an ungoverned ctx.run exactly once across replays, never a governed tool's own runs", async () => {
    await call(false);
    await settle();
    const events = auditEvents();
    expect(events.map((e) => [e.eventType, e.activityType])).toEqual([
      ["ActivityStarted", "fetch quote"],
      ["ActivityCompleted", "fetch quote"]
    ]);
    // "unconfirmed" when the attempt suspended before Restate acknowledged the result (timing-dependent here).
    expect(["succeeded", "unconfirmed"]).toContain((events[1]!.body["__openbox"] as { outcome: string }).outcome);
    expect(events[0]!.activityId).toMatch(/:audit:fetch quote#1$/);
    expect(events.some((e) => e.activityType === "weather api")).toBe(false);
    // The governed tool is still governed as usual.
    expect(core.evaluations("ActivityStarted", "get_weather")).toHaveLength(1);
  });

  it("never changes the outcome of a failing run; the failure surfaces as WorkflowFailed", async () => {
    await expect(call(true)).rejects.toThrow(/card declined/);
    await settle();
    const charge = auditEvents().filter((e) => e.activityType === "charge card");
    expect(charge.map((e) => e.eventType)).toEqual(["ActivityStarted", "ActivityCompleted"]);
    // Under forced replay the run's own outcome is unconfirmed (see hooks.ts); the workflow carries the failure.
    expect(core.evaluations("WorkflowFailed")).toHaveLength(1);
    expect(JSON.stringify(core.evaluations("WorkflowFailed")[0]!.body["error"])).toContain("card declined");
  });

  it("an OpenBox outage never affects the invocation", async () => {
    core.mode = "down";
    // Governance steps fail open (default); audit sends fail silently.
    await expect(call(false)).resolves.toMatchObject({ quote: { price: 42 } });
  });
});
