import { readFileSync } from "node:fs";

import { ApprovalResult, EvaluationResult, GovernanceAPIError, OpenBoxAuthError } from "@openbox-ai/openbox-sdk-ts";
import * as restate from "@restatedev/restate-sdk";
import { describe, expect, it } from "vitest";

import { nextIntervalMs } from "../../src/approvals.js";
import { resolveRestateConfig } from "../../src/config.js";
import type { GovernanceContext } from "../../src/context.js";
import { decide, redacted } from "../../src/enforce.js";
import {
  ConstrainUnsupportedError,
  GuardrailsValidationError,
  OpenBoxAuthTerminalError,
  OpenBoxContractError,
  OpenBoxUnavailableError,
  taggedStepError
} from "../../src/errors.js";
import { activityIdFor } from "../../src/ids.js";
import { classifyStepFailure, isAuthRejection } from "../../src/steps.js";
import { highestPriority, toApprovalRecord, toRecord, type VerdictRecord } from "../../src/verdict-record.js";
import { SDK_VERSION } from "../../src/version.js";

const env = { OPENBOX_API_URL: "https://core.example.com", OPENBOX_API_KEY: "obx_test_abc" };

function rec(partial: Partial<VerdictRecord>): VerdictRecord {
  return {
    v: 1,
    verdict: "allow",
    reason: null,
    policyId: null,
    governanceEventId: null,
    approvalId: null,
    approvalExpirationTime: null,
    guardrails: null,
    fallbackUsed: false,
    ...partial
  };
}

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});

describe("config", () => {
  it("defaults: fail_open, approval outage fail_closed, poll 15s, cap 1h", () => {
    const c = resolveRestateConfig({ environ: env });
    expect(c.base.onApiError).toBe("fail_open");
    expect(c.base.sdkEngine).toBe("restate");
    expect(c.restate).toMatchObject({
      approvalOutagePolicy: "fail_closed",
      approvalPollIntervalMs: 15_000,
      approvalWaitCapMs: 3_600_000,
      maxConsecutivePollFailures: 20,
      governanceMaxRetries: 3,
      hitlEnabled: true
    });
  });

  it("accepts OPENBOX_URL as an alias for OPENBOX_API_URL", () => {
    const c = resolveRestateConfig({ environ: { OPENBOX_URL: "https://alias.example.com", OPENBOX_API_KEY: "obx_test_abc" } });
    expect(c.base.apiUrl).toBe("https://alias.example.com");
  });

  it("prefers OPENBOX_API_URL and OPENBOX_RESTATE_* over OPENBOX_*", () => {
    const warns: string[] = [];
    const c = resolveRestateConfig({
      environ: {
        ...env,
        OPENBOX_URL: "https://other.example.com",
        OPENBOX_HITL_ENABLED: "true",
        OPENBOX_RESTATE_HITL_ENABLED: "false",
        OPENBOX_RESTATE_APPROVAL_POLL_INTERVAL_MS: "2000"
      },
      logger: { info() {}, warn: (m) => warns.push(m), error() {} }
    });
    expect(c.base.apiUrl).toBe("https://core.example.com");
    expect(warns.join()).toMatch(/differ/);
    expect(c.restate.hitlEnabled).toBe(false);
    expect(c.restate.approvalPollIntervalMs).toBe(2000);
  });

  it("rejects invalid values", () => {
    expect(() => resolveRestateConfig({ environ: { ...env, OPENBOX_RESTATE_APPROVAL_OUTAGE_POLICY: "maybe" } })).toThrow();
    expect(() => resolveRestateConfig({ environ: { OPENBOX_API_URL: "https://x.example.com", OPENBOX_API_KEY: "bad" } })).toThrow();
  });
});

describe("ids", () => {
  const g = () => ({ workflowId: "inv_1", nameCounters: new Map(), usedActivityIds: new Set() }) as unknown as GovernanceContext;

  it("uses toolCallId when present, per-name counters otherwise", () => {
    const ctx = g();
    expect(activityIdFor(ctx, "send", "call_9")).toBe("inv_1:call_9");
    expect(activityIdFor(ctx, "send")).toBe("inv_1:send#0");
    expect(activityIdFor(ctx, "send")).toBe("inv_1:send#1");
    expect(activityIdFor(ctx, "other")).toBe("inv_1:other#0");
  });

  it("rejects a duplicate id", () => {
    const ctx = g();
    activityIdFor(ctx, "send", "same");
    expect(() => activityIdFor(ctx, "send", "same")).toThrow(OpenBoxContractError);
  });
});

describe("verdict records", () => {
  it("keeps fallbackUsed (which EvaluationResult.fromDict would drop)", () => {
    expect(toRecord(EvaluationResult.fallbackAllow("down")).fallbackUsed).toBe(true);
  });

  it("maps guardrails", () => {
    const r = toRecord(
      EvaluationResult.fromDict({
        verdict: "allow",
        guardrails_result: { validation_passed: false, input_type: "activity_input", reasons: [{ reason: "PII" }] }
      })
    );
    expect(r.guardrails).toEqual({ validationPassed: false, inputType: "activity_input", redacted: null, reasons: ["PII"] });
  });

  it("highestPriority: halt > block > guardrail-fail > approval > constrain > allow", () => {
    const gf = rec({ guardrails: { validationPassed: false, inputType: null, redacted: null, reasons: [] } });
    expect(highestPriority([rec({}), rec({ verdict: "require_approval" }), gf]).guardrails?.validationPassed).toBe(false);
    expect(highestPriority([gf, rec({ verdict: "block" })]).verdict).toBe("block");
    expect(highestPriority([rec({ verdict: "block" }), rec({ verdict: "halt" })]).verdict).toBe("halt");
    expect(highestPriority([rec({ verdict: "constrain" }), rec({})]).verdict).toBe("constrain");
    expect(highestPriority([rec({}), rec({ fallbackUsed: true })]).fallbackUsed).toBe(true);
  });

  it("approval records use the strict parser (unknown verdict = pending, never allow)", () => {
    expect(toApprovalRecord(ApprovalResult.fromDict({ action: "allow" })).status).toBe("approved");
    expect(toApprovalRecord(ApprovalResult.fromDict({ action: "block" })).status).toBe("rejected");
    expect(toApprovalRecord(ApprovalResult.fromDict({ verdict: "yes-please" })).status).toBe("pending");
    expect(toApprovalRecord(ApprovalResult.fromDict({ verdict: "require_approval", expired: true })).status).toBe("expired");
  });
});

describe("enforce", () => {
  it("decides by precedence", () => {
    expect(decide(rec({ verdict: "halt", reason: "x" }), true)).toEqual({ kind: "halt", reason: "x" });
    expect(decide(rec({ verdict: "block" }), true).kind).toBe("blocked");
    expect(decide(rec({ verdict: "require_approval" }), true).kind).toBe("approval");
    expect(decide(rec({ verdict: "require_approval" }), false).kind).toBe("blocked");
    expect(decide(rec({}), true).kind).toBe("proceed");
    expect(() => decide(rec({ verdict: "constrain" }), true)).toThrow(ConstrainUnsupportedError);
    expect(() =>
      decide(rec({ verdict: "require_approval", guardrails: { validationPassed: false, inputType: null, redacted: null, reasons: ["PII"] } }), true)
    ).toThrow(GuardrailsValidationError);
  });

  it("applies redaction only for the matching phase and unwraps one-element input lists", () => {
    const input = rec({ guardrails: { validationPassed: true, inputType: "activity_input", redacted: [{ q: "***" }], reasons: [] } });
    expect(redacted(input, { q: "secret" }, "input")).toEqual({ q: "***" });
    expect(redacted(input, "out", "output")).toBe("out");
    const output = rec({ guardrails: { validationPassed: true, inputType: "activity_output", redacted: "[REDACTED]", reasons: [] } });
    expect(redacted(output, "secret", "output")).toBe("[REDACTED]");
  });
});

describe("ctx.run error boundary", () => {
  it("rebuilds public classes from plain TerminalErrors", () => {
    expect(classifyStepFailure(taggedStepError("auth", new Error("bad key")))).toBeInstanceOf(OpenBoxAuthTerminalError);
    expect(classifyStepFailure(taggedStepError("contract", new Error("bad envelope")))).toBeInstanceOf(OpenBoxContractError);
    // What Restate hands back after RunOptions exhaustion: untagged.
    expect(classifyStepFailure(new restate.TerminalError("exhausted"))).toBeInstanceOf(OpenBoxUnavailableError);
    const cancelled = new restate.TerminalError("cancelled", { errorCode: 409 });
    expect(classifyStepFailure(cancelled)).toBe(cancelled);
    const plain = new Error("retry me");
    expect(classifyStepFailure(plain)).toBe(plain);
  });

  it("recognises the base client's 401/403 GovernanceAPIError message (pinned to base 2.1.0)", () => {
    expect(isAuthRejection(new OpenBoxAuthError("x"))).toBe(true);
    expect(
      isAuthRejection(new GovernanceAPIError("Governance API auth rejected (HTTP 401); refusing to fail-open on an auth failure."))
    ).toBe(true);
    expect(isAuthRejection(new GovernanceAPIError("Governance API unreachable: fetch failed"))).toBe(false);
  });
});

describe("approval polling interval", () => {
  it("backs off and caps at 60s", () => {
    const cfg = { approvalPollIntervalMs: 15_000, approvalPollBackoff: 2, approvalPollMaxIntervalMs: 60_000 } as never;
    expect([0, 1, 2, 3].map((n) => nextIntervalMs(cfg, n))).toEqual([15_000, 30_000, 60_000, 60_000]);
  });
});
