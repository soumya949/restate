/**
 * Scenarios 9 (parallel tool calls) and 10 (parent → child RPC), architecture
 * §18.3, against a real Restate server with alwaysReplay=true. Parent and child
 * are distinct OpenBox agents, each with its own fake Core.
 */

import { generateKeyPairSync } from "node:crypto";

import * as restate from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OpenBoxRestate, governedParallel, governedRun, governedSubAgent, isBlocked, openboxHandler } from "../../src/index.js";
import { FakeCore } from "../helpers/fake-core.js";

const parentCore = new FakeCore();
const childCore = new FakeCore();
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

// Ed25519 seed (base64, 32 bytes) for the parent's DID signing.
const der = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" });
const PARENT_DID = "did:aip:6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const parentKey = Buffer.from(der.subarray(der.length - 32)).toString("base64");

const rtParent = new OpenBoxRestate({
  apiUrl: "http://localhost:8787",
  apiKey: "obx_test_parentagent",
  agentDid: PARENT_DID,
  agentPrivateKey: parentKey,
  environ: {},
  fetchImpl: (...a) => parentCore.fetchImpl(...a),
  logger: quiet,
  governanceMaxRetries: 2
});
const rtChild = new OpenBoxRestate({
  apiUrl: "http://localhost:8788",
  apiKey: "obx_test_childagent",
  environ: {},
  fetchImpl: (...a) => childCore.fetchImpl(...a),
  logger: quiet,
  governanceMaxRetries: 2
});

const ran: string[] = [];

const research = restate.service({
  name: "research",
  handlers: {
    run: openboxHandler(
      async (ctx: restate.Context, topic: string) => {
        const r = await governedRun(ctx, "web_search", { input: topic, toolCallId: "s1" }, (t) =>
          ctx.run("search", () => {
            ran.push(`search:${t}`);
            return `facts about ${t}`;
          })
        );
        return isBlocked(r) ? "blocked" : r;
      },
      { runtime: rtChild, agentName: "research-agent", promptFrom: (t) => t }
    )
  }
});

const lead = restate.service({
  name: "lead",
  handlers: {
    // 10: parent → child over Restate RPC
    delegate: openboxHandler(
      async (ctx: restate.Context, topic: string) => {
        const r = await governedSubAgent(ctx, { agentName: "research", input: topic, toolCallId: "call_r1" }, (t, headers) =>
          ctx.serviceClient(research).run(t, restate.rpc.opts({ headers }))
        );
        return { result: r };
      },
      { runtime: rtParent, agentName: "lead-agent", promptFrom: (t) => `research ${t}` }
    ),

    // 9: parallel tool calls
    parallel: openboxHandler(
      async (ctx: restate.Context) => {
        const tool = (name: string) => (city: string) =>
          ctx.run(`${name} ${city}`, async () => {
            ran.push(`${name}:${city}`);
            return { city };
          });
        const results = await governedParallel(ctx, [
          { toolName: "get_weather", toolCallId: "p1", input: "Rome", run: tool("weather") },
          { toolName: "delete_records", toolCallId: "p2", input: "users", run: tool("delete") },
          { toolName: "get_weather", toolCallId: "p3", input: "Oslo", run: tool("weather") }
        ]);
        return results.map((r) => (isBlocked(r) ? `blocked:${r.reason}` : r));
      },
      { runtime: rtParent, agentName: "parallel-agent" }
    )
  }
});

let env: RestateTestEnvironment;
let ingress: clients.Ingress;

beforeAll(async () => {
  env = await RestateTestEnvironment.start({ services: [lead, research], alwaysReplay: true });
  ingress = clients.connect({ url: env.baseUrl() });
}, 180_000);
afterAll(async () => env?.stop());
beforeEach(() => {
  parentCore.reset();
  childCore.reset();
  ran.length = 0;
});

describe("scenario 10: parent → child over Restate RPC", () => {
  it("child joins the parent's session, links to the parent activity, and sends the Handoff", async () => {
    const out = await ingress.serviceClient(lead).delegate("tides");
    expect(out).toEqual({ result: "facts about tides" });
    expect(ran).toEqual(["search:tides"]);

    const parentStart = parentCore.evaluations("WorkflowStarted")[0]!;
    const call = parentCore.evaluations("ActivityStarted", "call:research");
    expect(call).toHaveLength(1);
    expect(call[0]!.body["__openbox"]).toEqual({ tool_type: "a2a", subagent_name: "research" });
    expect(call[0]!.body["type"]).toBe("AGENT_ACTION");

    const childStart = childCore.evaluations("WorkflowStarted");
    expect(childStart).toHaveLength(1);
    const c = childStart[0]!.body;
    // One Multi-Agent Session across both agents.
    expect(c["multi_agent_session_id"]).toBe(parentStart.body["multi_agent_session_id"]);
    expect(c["parent_workflow_id"]).toBe(parentStart.workflowId);
    expect(c["parent_activity_id"]).toBe(call[0]!.activityId);
    expect(childStart[0]!.workflowId).not.toBe(parentStart.workflowId);

    // Handoff: sent once by the CHILD's client (Core takes the receiver from the signature).
    const handoffs = childCore.evaluations("Handoff");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.body["from_agent_did"]).toBe(PARENT_DID);
    expect(handoffs[0]!.body["multi_agent_session_id"]).toBe(c["multi_agent_session_id"]);
    expect(parentCore.evaluations("Handoff")).toHaveLength(0);

    // Every event exactly once on both sides, despite replays.
    expect(childCore.evaluations("ActivityStarted", "web_search")).toHaveLength(1);
    expect(childCore.evaluations("WorkflowCompleted")).toHaveLength(1);
    expect(parentCore.evaluations("ActivityCompleted", "call:research")).toHaveLength(1);
  });

  it("a BLOCK on the delegation means the child is never invoked", async () => {
    parentCore.onActivity("call:research", "ActivityStarted", { verdict: "block", reason: "no delegation" });
    const out = await ingress.serviceClient(lead).delegate("tides");
    expect(out).toMatchObject({ result: { blocked: true, reason: "no delegation" } });
    expect(childCore.ledger).toHaveLength(0);
    expect(ran).toEqual([]);
  });
});

describe("scenario 9: parallel tool calls", () => {
  it("pre-checks in call order, tools run concurrently, results in call order", async () => {
    parentCore.onActivity("delete_records", "ActivityStarted", { verdict: "block", reason: "no deletes" });
    const out = await ingress.serviceClient(lead).parallel(null as never);
    expect(out).toEqual([{ city: "Rome" }, "blocked:no deletes", { city: "Oslo" }]);
    expect([...ran].sort()).toEqual(["weather:Oslo", "weather:Rome"]);

    const order = (type: string) =>
      parentCore.ledger.filter((e) => e.eventType === type && e.activityId).map((e) => e.activityId!.split(":").pop());
    expect(order("ActivityStarted")).toEqual(["p1", "p2", "p3"]);
    expect(order("ActivityCompleted")).toEqual(["p1", "p3"]);
  });
});
