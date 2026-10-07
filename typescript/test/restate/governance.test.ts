/**
 * Restate integration tests (architecture §18.3) against a real Restate server
 * (testcontainers) with alwaysReplay=true, so every suspension point is
 * followed by a full journal replay. Scenario numbers refer to §18.3.
 */

import * as restate from "@restatedev/restate-sdk";
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  OpenBoxRestate,
  governedCall,
  governedRun,
  isBlocked,
  openboxHandler,
  type OpenBoxRestateOptions
} from "../../src/index.js";
import { FakeCore } from "../helpers/fake-core.js";

const core = new FakeCore();
const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

function runtime(extra: Partial<OpenBoxRestateOptions> = {}): OpenBoxRestate {
  return new OpenBoxRestate({
    apiUrl: "http://localhost:8787",
    apiKey: "obx_test_restatesdk",
    environ: {},
    fetchImpl: (...a) => core.fetchImpl(...a),
    logger: quietLogger,
    governanceMaxRetries: 2,
    approvalPollIntervalMs: 100,
    ...extra
  });
}

const rtOpen = runtime({ onApiError: "fail_open" });
const rtClosed = runtime({ onApiError: "fail_closed" });
const rtNoHitl = runtime({ hitlEnabled: false });
const rtFastOutage = runtime({ maxConsecutivePollFailures: 2 });

// Side-effect counters (in-process; the service runs in this test process).
const counters = { tool: 0 };
let crashOnce = false;

async function weatherTool(ctx: restate.Context, city: string) {
  return ctx.run(`weather ${city}`, () => {
    counters.tool++;
    return { city, temperature: 23 };
  });
}

type Out = Record<string, unknown>;

const describeError = (e: unknown): Out =>
  e instanceof restate.TerminalError ? { error: e.constructor.name, code: e.code } : { error: String(e) };

const agent = restate.service({
  name: "agent",
  handlers: {
    // 3: plain ALLOW path
    allow: openboxHandler(
      async (ctx: restate.Context, city: string): Promise<Out> => {
        const r = await governedRun(ctx, "get_weather", { input: city, toolCallId: "call_1" }, (c) => weatherTool(ctx, c));
        return { result: r };
      },
      { runtime: rtOpen, agentName: "weather-agent", promptFrom: (c) => `weather in ${c}?` }
    ),

    // 1: crash between the journaled pre-check and the tool
    crash: openboxHandler(
      async (ctx: restate.Context, city: string): Promise<Out> => {
        const r = await governedRun(ctx, "get_weather", { input: city, toolCallId: "call_1" }, async (c) => {
          if (!crashOnce) {
            crashOnce = true;
            throw new Error("simulated crash after openbox:pre");
          }
          return weatherTool(ctx, c);
        });
        return { result: r };
      },
      { runtime: rtOpen, agentName: "weather-agent" }
    ),

    // 6: BLOCK is a value, the tool never runs
    block: openboxHandler(
      async (ctx: restate.Context): Promise<Out> => {
        const r = await governedCall(ctx, { toolName: "delete_db", toolCallId: "call_1", input: { table: "users" } }, async () => {
          counters.tool++;
          return "deleted";
        }, { wrapInRun: true });
        return { blocked: isBlocked(r), result: r };
      },
      { runtime: rtOpen, agentName: "db-agent" }
    ),

    // 7: HALT ends the invocation; later steps never run
    halt: openboxHandler(
      async (ctx: restate.Context): Promise<Out> => {
        await governedRun(ctx, "wire_money", { input: { amount: 5000 }, toolCallId: "call_1" }, async () => {
          counters.tool++;
          return "sent";
        }, { wrapInRun: true });
        await governedRun(ctx, "get_weather", { input: "Paris", toolCallId: "call_2" }, (c) => weatherTool(ctx, c));
        return { unreachable: true };
      },
      { runtime: rtOpen, agentName: "money-agent" }
    ),

    // 8: output guardrail redaction
    redact: openboxHandler(
      async (ctx: restate.Context): Promise<Out> => {
        const r = await governedRun(ctx, "lookup_user", { input: { id: 7 }, toolCallId: "call_1" }, async () => ({ ssn: "123-45-6789" }), {
          wrapInRun: true
        });
        return { result: r };
      },
      { runtime: rtOpen, agentName: "crm-agent" }
    ),

    // 14: CONSTRAIN is explicitly unsupported
    constrain: openboxHandler(
      async (ctx: restate.Context): Promise<Out> => {
        try {
          await governedRun(ctx, "constrained_tool", { input: 1, toolCallId: "call_1" }, async () => 1, { wrapInRun: true });
          return { ok: true };
        } catch (e) {
          return describeError(e);
        }
      },
      { runtime: rtOpen, agentName: "c-agent" }
    ),

    // 4 + 19: fail_closed outage surfaces as OpenBoxUnavailableError (class survives the ctx.run boundary)
    closedOutage: async (ctx: restate.Context): Promise<Out> => {
      try {
        return await openboxHandler(async () => ({ ok: true }), { runtime: rtClosed, agentName: "x" })(ctx, undefined);
      } catch (e) {
        return describeError(e);
      }
    },

    // 5: fail_open outage proceeds (degraded)
    openOutage: openboxHandler(
      async (ctx: restate.Context): Promise<Out> => {
        const r = await governedRun(ctx, "get_weather", { input: "Oslo", toolCallId: "call_1" }, (c) => weatherTool(ctx, c));
        return { result: r };
      },
      { runtime: rtOpen, agentName: "weather-agent" }
    ),

    // 11 + 19: 401 is terminal immediately and surfaces as OpenBoxAuthTerminalError
    auth: async (ctx: restate.Context): Promise<Out> => {
      try {
        return await openboxHandler(async () => ({ ok: true }), { runtime: rtClosed, agentName: "x" })(ctx, undefined);
      } catch (e) {
        return describeError(e);
      }
    },

    // 12: contract violation (empty workflow_type) — zero network calls for the event
    contract: async (ctx: restate.Context): Promise<Out> => {
      try {
        return await openboxHandler(async () => ({ ok: true }), { runtime: rtOpen, agentName: "" })(ctx, undefined);
      } catch (e) {
        return describeError(e);
      }
    },

    // 2: durable approval (approved after polls) — replayed after every sleep
    approve: openboxHandler(
      async (ctx: restate.Context): Promise<Out> => {
        try {
          const r = await governedRun(ctx, "send_email", { input: { to: "a@b.com" }, toolCallId: "call_1" }, async () => {
            counters.tool++;
            return "sent";
          }, { wrapInRun: true });
          return { result: r };
        } catch (e) {
          return describeError(e);
        }
      },
      { runtime: rtOpen, agentName: "mail-agent" }
    ),

    // approval outage policy (default fail_closed)
    approveOutage: openboxHandler(
      async (ctx: restate.Context): Promise<Out> => {
        try {
          await governedRun(ctx, "send_email", { input: {}, toolCallId: "call_1" }, async () => "sent", { wrapInRun: true });
          return { ok: true };
        } catch (e) {
          return describeError(e);
        }
      },
      { runtime: rtFastOutage, agentName: "mail-agent" }
    ),

    // 13: HITL disabled → REQUIRE_APPROVAL treated as BLOCK
    noHitl: openboxHandler(
      async (ctx: restate.Context): Promise<Out> => {
        const r = await governedRun(ctx, "send_email", { input: {}, toolCallId: "call_1" }, async () => {
          counters.tool++;
          return "sent";
        }, { wrapInRun: true });
        return { result: r };
      },
      { runtime: rtNoHitl, agentName: "mail-agent" }
    ),

    // workflow-level approval gate before user code
    startGate: openboxHandler(
      async (ctx: restate.Context): Promise<Out> => {
        await ctx.run("side effect", () => {
          counters.tool++;
        });
        return { ran: true };
      },
      { runtime: rtOpen, agentName: "gated-agent" }
    ),

    // the same toolCallId governed twice is a contract error
    duplicate: openboxHandler(
      async (ctx: restate.Context): Promise<Out> => {
        await governedRun(ctx, "get_weather", { input: "a", toolCallId: "same" }, (c) => weatherTool(ctx, c));
        try {
          await governedRun(ctx, "get_weather", { input: "b", toolCallId: "same" }, (c) => weatherTool(ctx, c));
          return { ok: true };
        } catch (e) {
          return describeError(e);
        }
      },
      { runtime: rtOpen, agentName: "weather-agent" }
    )
  }
});

let env: RestateTestEnvironment;
const makeClient = (url: string) => clients.connect({ url }).serviceClient(agent);
let client: ReturnType<typeof makeClient>;

beforeAll(async () => {
  env = await RestateTestEnvironment.start({ services: [agent], alwaysReplay: true });
  client = makeClient(env.baseUrl());
}, 180_000);

afterAll(async () => {
  await env?.stop();
});

beforeEach(() => {
  core.reset();
  counters.tool = 0;
});

describe("governed step (P0)", () => {
  it("3: ALLOW — every event sent exactly once despite replays", async () => {
    const out = await client.allow("Paris");
    expect(out).toEqual({ result: { city: "Paris", temperature: 23 } });
    expect(counters.tool).toBe(1);
    expect(core.evaluations("WorkflowStarted")).toHaveLength(1);
    expect(core.evaluations("SignalReceived")).toHaveLength(1);
    expect(core.evaluations("ActivityStarted", "get_weather")).toHaveLength(1);
    expect(core.evaluations("ActivityCompleted", "get_weather")).toHaveLength(1);
    // Latency for the dashboard, from journaled timestamps (identical on every replay).
    expect(core.evaluations("ActivityCompleted", "get_weather")[0]!.body["duration_ms"]).toEqual(expect.any(Number));
    expect(core.evaluations("WorkflowCompleted")).toHaveLength(1);

    const started = core.evaluations("ActivityStarted", "get_weather")[0]!;
    expect(started.activityId).toMatch(/^inv.*:call_1$/);
    expect(started.body["workflow_type"]).toBe("weather-agent");
    expect(started.body["activity_input"]).toEqual(["Paris"]);
    expect(started.body["session_id"]).toBe(started.workflowId);
    const completed = core.evaluations("ActivityCompleted", "get_weather")[0]!;
    expect(completed.body["activity_output"]).toEqual({ city: "Paris", temperature: 23 });
  });

  it("1: crash after openbox:pre — tool runs once, one ActivityStarted", async () => {
    crashOnce = false;
    const out = await client.crash("Rome");
    expect(out).toEqual({ result: { city: "Rome", temperature: 23 } });
    expect(counters.tool).toBe(1);
    expect(core.evaluations("ActivityStarted", "get_weather")).toHaveLength(1);
  });

  it("6: BLOCK returns a value and the tool never runs", async () => {
    core.onActivity("delete_db", "ActivityStarted", { verdict: "block", reason: "deletes are forbidden", policy_id: "p1" });
    const out = await client.block(null as never);
    expect(out["blocked"]).toBe(true);
    expect(out["result"]).toMatchObject({ blocked: true, reason: "deletes are forbidden", policyId: "p1" });
    expect(counters.tool).toBe(0);
    expect(core.evaluations("ActivityCompleted", "delete_db")).toHaveLength(0);
  });

  it("7: HALT fails the invocation, no later steps, nothing sent after it", async () => {
    core.onActivity("wire_money", "ActivityStarted", { verdict: "halt", reason: "fraud pattern" });
    await expect(client.halt(null as never)).rejects.toThrow(/OpenBox HALT: fraud pattern/);
    expect(counters.tool).toBe(0);
    expect(core.evaluations("ActivityStarted", "get_weather")).toHaveLength(0);
    // Core closes the session on HALT and answers anything later with "Session is no longer active".
    expect(core.evaluations("WorkflowFailed")).toHaveLength(0);
    expect(core.evaluations("WorkflowCompleted")).toHaveLength(0);
  });

  it("8: output guardrail redaction replaces the result", async () => {
    core.onActivity("lookup_user", "ActivityCompleted", {
      verdict: "allow",
      guardrails_result: { input_type: "activity_output", redacted_input: { ssn: "[REDACTED]" }, validation_passed: true }
    });
    const out = await client.redact(null as never);
    expect(out).toEqual({ result: { ssn: "[REDACTED]" } });
  });

  it("14: CONSTRAIN → ConstrainUnsupportedError", async () => {
    core.onActivity("constrained_tool", "ActivityStarted", { verdict: "constrain", reason: "limit" });
    expect(await client.constrain(null as never)).toEqual({ error: "ConstrainUnsupportedError", code: 501 });
  });

  it("4 + 19: fail_closed outage → OpenBoxUnavailableError (class rebuilt outside ctx.run)", async () => {
    core.mode = "down";
    expect(await client.closedOutage(null as never)).toEqual({ error: "OpenBoxUnavailableError", code: 503 });
    // validate (skipped: unreachable) + governanceMaxRetries=2 evaluate attempts
    expect(core.evaluations("WorkflowStarted")).toHaveLength(2);
  });

  it("5: fail_open outage proceeds (degraded ALLOW)", async () => {
    core.mode = "down";
    const out = await client.openOutage(null as never);
    expect(out).toEqual({ result: { city: "Oslo", temperature: 23 } });
    expect(counters.tool).toBe(1);
  });

  it("11 + 19: 401 → OpenBoxAuthTerminalError immediately, no retries", async () => {
    core.mode = "auth401";
    expect(await client.auth(null as never)).toEqual({ error: "OpenBoxAuthTerminalError", code: 401 });
    // key already validated by an earlier test: the 401 comes from evaluate and is NOT retried
    expect(core.evaluations()).toHaveLength(1);
  });

  it("12: contract violation (empty workflow_type) → OpenBoxContractError, no evaluate sent", async () => {
    expect(await client.contract(null as never)).toEqual({ error: "OpenBoxContractError", code: 500 });
    expect(core.evaluations()).toHaveLength(0);
  });

  it("duplicate toolCallId in one invocation → OpenBoxContractError", async () => {
    expect(await client.duplicate(null as never)).toEqual({ error: "OpenBoxContractError", code: 500 });
  });
});

describe("durable approvals (P1, Mode A)", () => {
  it("2: REQUIRE_APPROVAL suspends, polls durably, runs once after approval", async () => {
    core.onActivity("send_email", "ActivityStarted", { verdict: "require_approval", reason: "emails need review" });
    core.scriptApproval(":call_1", { verdict: "require_approval" }, { verdict: "require_approval" }, { action: "allow" });
    const out = await client.approve(null as never);
    expect(out).toEqual({ result: "sent" });
    expect(counters.tool).toBe(1);
    expect(core.evaluations("ActivityStarted", "send_email")).toHaveLength(1);
    expect(core.polls()).toHaveLength(3); // journaled: replays never re-poll
    expect(core.polls()[0]!.body).toMatchObject({ activity_id: expect.stringMatching(/:call_1$/) });
  });

  it("approval rejected → ApprovalRejectedError, tool never runs", async () => {
    core.onActivity("send_email", "ActivityStarted", { verdict: "require_approval" });
    core.scriptApproval(":call_1", { action: "block", reason: "not today" });
    expect(await client.approve(null as never)).toEqual({ error: "ApprovalRejectedError", code: 403 });
    expect(counters.tool).toBe(0);
  });

  it("approval expired → ApprovalExpiredError", async () => {
    core.onActivity("send_email", "ActivityStarted", { verdict: "require_approval" });
    core.scriptApproval(":call_1", { verdict: "require_approval", approval_expiration_time: "2000-01-01T00:00:00Z" });
    expect(await client.approve(null as never)).toEqual({ error: "ApprovalExpiredError", code: 408 });
    expect(counters.tool).toBe(0);
  });

  it("approval outage → fail_closed by default (OpenBoxUnavailableError)", async () => {
    core.onActivity("send_email", "ActivityStarted", { verdict: "require_approval" });
    core.approvalMode = "down";
    expect(await client.approveOutage(null as never)).toEqual({ error: "OpenBoxUnavailableError", code: 503 });
    expect(core.polls()).toHaveLength(2);
  });

  it("13: HITL disabled → REQUIRE_APPROVAL treated as BLOCK", async () => {
    core.onActivity("send_email", "ActivityStarted", { verdict: "require_approval" });
    const out = await client.noHitl(null as never);
    expect(out["result"]).toMatchObject({ blocked: true });
    expect(counters.tool).toBe(0);
  });

  it("workflow-level approval gate runs before user code", async () => {
    core.onEvent("WorkflowStarted", { verdict: "require_approval" });
    core.onActivity("agent_start", "ActivityStarted", { verdict: "require_approval" });
    core.scriptApproval(":__start__", { verdict: "require_approval" }, { action: "allow" });
    expect(await client.startGate(null as never)).toEqual({ ran: true });
    expect(counters.tool).toBe(1);
    expect(core.polls()).toHaveLength(2);
  });
});
