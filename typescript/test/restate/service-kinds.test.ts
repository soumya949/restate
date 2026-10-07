/**
 * openboxHandler / governedRun on every Restate service kind (Service is
 * covered by governance.test.ts): Workflow `run` + shared handlers, and
 * Virtual Object exclusive handlers. Real Restate server, alwaysReplay=true.
 */

import * as restate from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OpenBoxRestate, governedRun, isBlocked, openboxHandler } from "../../src/index.js";
import { FakeCore } from "../helpers/fake-core.js";

const core = new FakeCore();
const rt = new OpenBoxRestate({
  apiUrl: "http://localhost:8787",
  apiKey: "obx_test_restatesdk",
  environ: {},
  fetchImpl: (...a) => core.fetchImpl(...a),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  governanceMaxRetries: 2,
  approvalPollIntervalMs: 100
});

let sent = 0;

// A durable workflow: one governed step that needs approval, plus a shared status handler.
const onboarding = restate.workflow({
  name: "onboarding",
  handlers: {
    run: openboxHandler(
      async (ctx: restate.WorkflowContext, req: { email: string }) => {
        ctx.set("stage", "emailing");
        const r = await governedRun(ctx, "send_email", { input: req, toolCallId: "welcome" }, (i) =>
          ctx.run("send welcome", () => {
            sent++;
            return { sent: true, to: i.email };
          })
        );
        ctx.set("stage", "done");
        return { blocked: isBlocked(r), result: r };
      },
      { runtime: rt, agentName: "onboarding-workflow", promptFrom: (req) => `onboard ${req.email}` }
    ),
    // Shared handlers are reads/signals: left ungoverned.
    status: async (ctx: restate.WorkflowSharedContext) => (await ctx.get<string>("stage")) ?? "pending"
  }
});

// A stateful agent per user: exclusive handler, session = object key.
const chat = restate.object({
  name: "chat",
  handlers: {
    message: openboxHandler(
      async (ctx: restate.ObjectContext, text: string) => {
        const turns = ((await ctx.get<number>("turns")) ?? 0) + 1;
        ctx.set("turns", turns);
        const r = await governedRun(ctx, "get_weather", { input: text, toolCallId: `turn_${turns}` }, (i) =>
          ctx.run("weather", () => ({ city: i, temperature: 23 }))
        );
        return { turns, result: r };
      },
      { runtime: rt, agentName: "chat-agent", promptFrom: (t) => t }
    )
  }
});

let env: RestateTestEnvironment;
let ingress: clients.Ingress;

beforeAll(async () => {
  env = await RestateTestEnvironment.start({ services: [onboarding, chat], alwaysReplay: true });
  ingress = clients.connect({ url: env.baseUrl() });
}, 180_000);
afterAll(async () => env?.stop());
beforeEach(() => {
  core.reset();
  sent = 0;
});

describe("Workflow", () => {
  it("governs run: session = workflow key, durable approval, exactly-once events", async () => {
    core.onActivity("send_email", "ActivityStarted", { verdict: "require_approval", reason: "review welcome mail" });
    core.scriptApproval("welcome", { verdict: "require_approval" }, { verdict: "require_approval" }, { verdict: "allow" });

    const wf = ingress.workflowClient(onboarding, "user-42");
    await wf.workflowSubmit({ email: "a@example.com" });
    const out = await wf.workflowAttach();

    expect(out).toMatchObject({ blocked: false, result: { sent: true } });
    expect(sent).toBe(1);
    expect(await wf.status()).toBe("done");

    const started = core.evaluations("WorkflowStarted");
    expect(started).toHaveLength(1);
    expect(started[0]!.body["session_id"]).toBe("onboarding/user-42");
    expect(started[0]!.body["workflow_type"]).toBe("onboarding-workflow");
    expect(core.evaluations("ActivityStarted", "send_email")).toHaveLength(1);
    expect(core.evaluations("ActivityCompleted", "send_email")).toHaveLength(1);
    expect(core.evaluations("WorkflowCompleted")).toHaveLength(1);
    expect(core.polls().length).toBe(3);
  });

  it("BLOCK inside a workflow is a value; the workflow still completes", async () => {
    core.onActivity("send_email", "ActivityStarted", { verdict: "block", reason: "no emails" });
    const wf = ingress.workflowClient(onboarding, "user-43");
    await wf.workflowSubmit({ email: "b@example.com" });
    expect(await wf.workflowAttach()).toMatchObject({ blocked: true, result: { reason: "no emails" } });
    expect(sent).toBe(0);
  });
});

describe("Virtual Object", () => {
  it("governs exclusive handlers: session = object key, one OpenBox run per call", async () => {
    const obj = ingress.objectClient(chat, "alice");
    const a = await obj.message("Paris");
    const b = await obj.message("Rome");
    expect(a).toMatchObject({ turns: 1, result: { city: "Paris" } });
    expect(b).toMatchObject({ turns: 2, result: { city: "Rome" } });

    const started = core.evaluations("WorkflowStarted");
    expect(started.map((e) => e.body["session_id"])).toEqual(["chat/alice", "chat/alice"]);
    // Each call is its own OpenBox run (workflow_id = invocation id) inside the same session.
    expect(new Set(started.map((e) => e.workflowId)).size).toBe(2);
    expect(core.evaluations("ActivityStarted", "get_weather")).toHaveLength(2);
  });
});
