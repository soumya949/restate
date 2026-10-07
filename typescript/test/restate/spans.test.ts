/**
 * Span capture (`./instrumentation`) against a real Restate server with
 * alwaysReplay=true. Runs in its own vitest worker: it patches global fetch.
 *
 * Proves: the activity binding survives into the tool's ctx.run closure; each
 * span is reported exactly once despite replays; a span BLOCK/HALT stops the
 * HTTP call before it goes out and is not retried by Restate; an activity-level
 * approval also covers the activity's own spans.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import * as restate from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OpenBoxRestate, governedRun, isBlocked, openboxHandler } from "../../src/index.js";
import { enableOpenBoxSpans, type OpenBoxSpans } from "../../src/instrumentation.js";
import { FakeCore, type LedgerEntry } from "../helpers/fake-core.js";

const core = new FakeCore();
const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };
const rt = new OpenBoxRestate({
  apiUrl: "http://localhost:8787",
  apiKey: "obx_test_restatesdk",
  environ: {},
  fetchImpl: (...a) => core.fetchImpl(...a),
  logger: quietLogger,
  governanceMaxRetries: 2,
  approvalPollIntervalMs: 100
});

// The tool's downstream API: counts real hits.
let hits = 0;
let api: Server;
let apiUrl = "";

const callApi = (ctx: restate.Context, tool: string) =>
  ctx.run(`call ${tool}`, async () => {
    const res = await fetch(`${apiUrl}/v1/${tool}`, { method: "POST", body: JSON.stringify({ q: 1 }), headers: { "content-type": "application/json" } });
    return (await res.json()) as Record<string, unknown>;
  });

const agent = restate.service({
  name: "spans",
  handlers: {
    tool: openboxHandler(
      async (ctx: restate.Context, tool: string) => {
        const r = await governedRun(ctx, tool, { input: { q: 1 }, toolCallId: "call_1" }, () => callApi(ctx, tool));
        return { blocked: isBlocked(r), result: r };
      },
      { runtime: rt, agentName: "span-agent" }
    )
  }
});

let env: RestateTestEnvironment;
let spans: OpenBoxSpans;
let call: (tool: string) => Promise<Record<string, unknown>>;

const hookEvals = (activityType: string): LedgerEntry[] =>
  core.evaluations("ActivityStarted", activityType).filter((e) => e.body["hook_trigger"] === true);
const stages = (entries: LedgerEntry[]) =>
  entries.map((e) => (e.body["spans"] as Array<Record<string, unknown>>)[0]?.["stage"]);

beforeAll(async () => {
  api = createServer((req, res) => {
    hits++;
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  spans = enableOpenBoxSpans({ runtime: rt });
  env = await RestateTestEnvironment.start({ services: [agent], alwaysReplay: true });
  const c = clients.connect({ url: env.baseUrl() }).serviceClient(agent);
  call = (tool) => (c as unknown as { tool: (t: string) => Promise<Record<string, unknown>> }).tool(tool);
}, 180_000);

afterAll(async () => {
  await spans?.close();
  await env?.stop();
  api?.close();
});

beforeEach(() => {
  core.reset();
  hits = 0;
});

describe("span capture", () => {
  it("installs fetch + http/https", () => {
    expect(spans.installedTargets).toEqual(expect.arrayContaining(["fetch", "http", "https"]));
  });

  it("reports the tool's HTTP call as started + completed spans of its activity, exactly once", async () => {
    const out = await call("get_weather");
    expect(out).toMatchObject({ blocked: false, result: { ok: true } });
    expect(hits).toBe(1);

    const hooks = hookEvals("get_weather");
    expect(stages(hooks)).toEqual(["started", "completed"]);
    const activity = core.evaluations("ActivityStarted", "get_weather").find((e) => e.body["hook_trigger"] !== true)!;
    for (const h of hooks) {
      // Same correlation as the activity, so OpenBox nests the span under it.
      expect(h.activityId).toBe(activity.activityId);
      expect(h.workflowId).toBe(activity.workflowId);
      const span = (h.body["spans"] as Array<Record<string, unknown>>)[0]!;
      expect(span["hook_type"]).toBe("http_request");
      expect(String(span["http_url"])).toContain("/v1/get_weather");
    }
    // OpenBox's own governance calls are never reported as spans.
    expect(core.evaluations().filter((e) => JSON.stringify(e.body["spans"] ?? []).includes("8787"))).toHaveLength(0);
  });

  it("span BLOCK stops the HTTP call before it is sent and returns a BlockedResult (not retried)", async () => {
    core.rule((b) => (b["hook_trigger"] === true && b["activity_type"] === "delete_records" ? { verdict: "block", reason: "no deletes over HTTP" } : undefined));
    const out = await call("delete_records");
    expect(out).toMatchObject({ blocked: true, result: { reason: "no deletes over HTTP" } });
    expect(hits).toBe(0);
    expect(stages(hookEvals("delete_records"))).toEqual(["started"]);
    expect(core.evaluations("ActivityCompleted", "delete_records").map((e) => e.body["status"])).toEqual(["failed"]);
  });

  it("span HALT ends the invocation", async () => {
    core.rule((b) => (b["hook_trigger"] === true && b["activity_type"] === "wire_money" ? { verdict: "halt", reason: "fraud" } : undefined));
    await expect(call("wire_money")).rejects.toThrow(/OpenBox HALT: fraud/);
    expect(hits).toBe(0);
    expect(stages(hookEvals("wire_money"))).toEqual(["started"]);
  });

  it("an approved activity's spans pass the same REQUIRE_APPROVAL rule", async () => {
    // Like a dashboard rule "activity_type = send_email AND event_type = ActivityStarted": it matches the spans too.
    core.onActivity("send_email", "ActivityStarted", { verdict: "require_approval", reason: "email needs review" });
    // Live Core reports the span's own approval as still pending after the activity was approved:
    // the first poll (the activity wait) says allow, every later poll says pending.
    core.scriptApproval("call_1", { verdict: "allow", reason: "approved" }, { verdict: "require_approval" });
    const out = await call("send_email");
    expect(out).toMatchObject({ blocked: false, result: { ok: true } });
    expect(hits).toBe(1);
    expect(stages(hookEvals("send_email"))).toEqual(["started", "completed"]);
    expect(core.polls()).toHaveLength(1); // the span never asked again
  });

  it("a span-only REQUIRE_APPROVAL on an activity nobody approved fails safe as a block", async () => {
    core.rule((b) => (b["hook_trigger"] === true && b["activity_type"] === "upload" ? { verdict: "require_approval", reason: "review uploads" } : undefined));
    const out = await call("upload");
    expect(out).toMatchObject({ blocked: true });
    expect(hits).toBe(0);
  });
});
