/**
 * Event builders (architecture §5.4). Thin wrappers over the base SDK's event
 * factories — payloads are never hand-assembled, so the base strict gate
 * (`prepareLifecyclePayload`) always validates them.
 *
 * These are called INSIDE governance `ctx.run` closures, so any wall-clock
 * timestamp the gate stamps is part of the journaled side effect.
 */

import {
  activityCompleted,
  activityStarted,
  signalReceived,
  workflowCompleted,
  workflowFailed,
  workflowStarted,
  type ErrorInfo,
  type EventEnvelope,
  type JsonValue,
  type WorkflowEventOptions
} from "@openbox-ai/openbox-sdk-ts";
import * as restate from "@restatedev/restate-sdk";

import type { GovernanceContext } from "./context.js";

/** Convert an arbitrary value into JSON (undefined → null, bigint → string, cycles → string). */
export function toJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    const text = JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    return text === undefined ? null : (JSON.parse(text) as JsonValue);
  } catch {
    return String(value);
  }
}

function extraFor(g: GovernanceContext, stepName: string): Record<string, JsonValue> {
  const restateInfo: Record<string, JsonValue> = {
    invocation_id: g.workflowId,
    service: g.service,
    handler: g.handler
  };
  if (g.key !== null) restateInfo["key"] = g.key;
  if (g.scope !== null) restateInfo["scope"] = g.scope;
  if (g.limitKey !== null) restateInfo["limit_key"] = g.limitKey;

  const extra: Record<string, JsonValue> = {
    session_id: g.sessionId,
    restate: restateInfo,
    // Deterministic per journal step: lets Core dedupe once it supports idempotency (PRD §8 D2).
    openbox_restate_event_key: `${g.workflowId}/${stepName}`
  };
  if (g.agentName) extra["agent_name"] = g.agentName;
  if (g.parentWorkflowId) extra["parent_workflow_id"] = g.parentWorkflowId;
  if (g.parentActivityId) extra["parent_activity_id"] = g.parentActivityId;
  return extra;
}

function base(g: GovernanceContext, stepName: string, more: Record<string, JsonValue> = {}): WorkflowEventOptions {
  return {
    workflowId: g.workflowId,
    runId: g.runId,
    workflowType: g.workflowType,
    multiAgentSessionId: g.multiAgentSessionId,
    extra: { ...extraFor(g, stepName), ...more }
  };
}

export function workflowStartedEvent(g: GovernanceContext, stepName: string, input: unknown, captureInput: boolean): EventEnvelope {
  return workflowStarted(base(g, stepName, captureInput ? { activity_input: [toJson(input)] } : {}));
}

export function userPromptEvent(g: GovernanceContext, stepName: string, prompt: string): EventEnvelope {
  return signalReceived({ ...base(g, stepName, { signal_args: [prompt] }), signalName: "user_prompt" });
}

export interface ActivityStartedInit {
  activityId: string;
  activityType: string;
  input: unknown;
  semanticType?: string | null | undefined;
  agentId?: string | null | undefined;
  extra?: Record<string, JsonValue> | undefined;
}

export function activityStartedEvent(g: GovernanceContext, stepName: string, a: ActivityStartedInit): EventEnvelope {
  const more: Record<string, JsonValue> = { ...(a.extra ?? {}) };
  if (a.semanticType) more["type"] = a.semanticType;
  if (a.agentId) more["agent_id"] = a.agentId;
  return activityStarted({
    ...base(g, stepName, more),
    activityId: a.activityId,
    activityType: a.activityType,
    activityInput: [toJson(a.input)]
  });
}

export interface ActivityCompletedInit {
  activityId: string;
  activityType: string;
  result?: unknown;
  error?: ErrorInfo | null;
  status: "completed" | "failed";
}

export function activityCompletedEvent(g: GovernanceContext, stepName: string, a: ActivityCompletedInit): EventEnvelope {
  return activityCompleted({
    ...base(g, stepName, { status: a.status }),
    activityId: a.activityId,
    activityType: a.activityType,
    ...(a.status === "completed" ? { result: toJson(a.result) } : {}),
    ...(a.error ? { error: a.error } : {})
  });
}

export function workflowCompletedEvent(g: GovernanceContext, stepName: string, output: unknown, captureOutput: boolean): EventEnvelope {
  return workflowCompleted(base(g, stepName, captureOutput ? { workflow_output: toJson(output) } : {}));
}

export function workflowFailedEvent(g: GovernanceContext, stepName: string, error: ErrorInfo): EventEnvelope {
  return workflowFailed({ ...base(g, stepName), error });
}

/** Structured error object Core requires (a bare string is rejected with HTTP 400). */
export function errorInfoOf(e: unknown): ErrorInfo {
  if (e instanceof restate.TerminalError && e.code === 409) {
    return { type: "Cancelled", message: e.message };
  }
  if (e instanceof Error) {
    const info: ErrorInfo = { type: e.name || "Error", message: e.message };
    if (e.stack) info.stack_trace = e.stack;
    if (e instanceof restate.TerminalError) info.non_retryable = true;
    return info;
  }
  return { type: "Error", message: String(e) };
}
