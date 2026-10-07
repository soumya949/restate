/**
 * Per-invocation governance context (architecture §3.4, §4).
 *
 * Rebuilt on EVERY attempt from invocation-constant inputs only (invocation
 * id, target, headers). Nothing here is a source of truth for decisions —
 * the Restate journal is.
 */

import type * as restate from "@restatedev/restate-sdk";

import { OpenBoxContractError, type GovernanceHaltError } from "./errors.js";
import type { OpenBoxRestate } from "./runtime.js";

export const HEADER_MULTI_AGENT_SESSION_ID = "x-openbox-multi-agent-session-id";
export const HEADER_PARENT_WORKFLOW_ID = "x-openbox-parent-workflow-id";
export const HEADER_PARENT_ACTIVITY_ID = "x-openbox-parent-activity-id";
export const HEADER_PARENT_AGENT_DID = "x-openbox-parent-agent-did";

export interface GovernanceContext {
  readonly rt: OpenBoxRestate;
  readonly workflowId: string;
  readonly runId: string;
  readonly workflowType: string;
  readonly sessionId: string;
  readonly multiAgentSessionId: string;
  readonly parentWorkflowId: string | null;
  readonly parentActivityId: string | null;
  /** Parent agent's DID (informational; the child sends Handoff with it, never trusted for auth). */
  readonly parentAgentDid: string | null;
  readonly agentName: string | null;
  readonly service: string;
  readonly handler: string;
  readonly key: string | null;
  readonly scope: string | null;
  readonly limitKey: string | null;
  /** Set after a HALT has been thrown in this attempt; short-circuits later governed calls. */
  halted: boolean;
  /** The HALT that was thrown, rethrown by later short-circuits so the real reason and policy survive. */
  haltError: GovernanceHaltError | null;
  /** Per-name counters for steps that have no toolCallId (deterministic: program order). */
  readonly nameCounters: Map<string, number>;
  readonly usedActivityIds: Set<string>;
  vobjWarningLogged: boolean;
  /** Governed tool executions in flight; the audit hook skips ctx.run calls they make (already governed). */
  activeTools: number;
  /** Per-name counters for the audit hook's activity ids (per attempt; audit only). */
  readonly auditCounters: Map<string, number>;
}

const registry = new WeakMap<object, GovernanceContext>();
// Invocation id → context of the attempt in flight. Released when the attempt ends (handler.ts).
const byInvocation = new Map<string, GovernanceContext>();

export interface ContextInit<I> {
  agentName?: string | undefined;
  sessionId?: ((input: I) => string | null | undefined) | undefined;
}

export function createGovernanceContext<I>(
  ctx: restate.Context,
  rt: OpenBoxRestate,
  init: ContextInit<I>,
  input: I
): GovernanceContext {
  const req = ctx.request();
  const target = req.target;
  const workflowId = String(req.id);
  // Never read `ctx.key` here: it throws TerminalError on plain services (architecture §4).
  const key = target.key ?? null;
  const headers = req.headers;

  const workflowType = init.agentName ?? rt.config.restate.agentName ?? `${target.service}.${target.handler}`;

  let sessionId: string;
  if (key !== null) sessionId = `${target.service}/${key}`;
  else sessionId = init.sessionId?.(input) ?? workflowId;

  const g: GovernanceContext = {
    rt,
    workflowId,
    runId: workflowId,
    workflowType,
    sessionId,
    multiAgentSessionId: headers.get(HEADER_MULTI_AGENT_SESSION_ID) ?? `mas:${workflowId}`,
    parentWorkflowId: headers.get(HEADER_PARENT_WORKFLOW_ID) ?? null,
    parentActivityId: headers.get(HEADER_PARENT_ACTIVITY_ID) ?? null,
    parentAgentDid: headers.get(HEADER_PARENT_AGENT_DID) ?? null,
    agentName: init.agentName ?? rt.config.restate.agentName ?? null,
    service: target.service,
    handler: target.handler,
    key,
    scope: req.scope ?? null,
    limitKey: req.limitKey ?? null,
    halted: false,
    haltError: null,
    nameCounters: new Map(),
    usedActivityIds: new Set(),
    vobjWarningLogged: false,
    activeTools: 0,
    auditCounters: new Map()
  };
  registry.set(ctx, g);
  byInvocation.set(workflowId, g);
  return g;
}

/** The governance context of a running invocation, by invocation id (for Restate hooks, which only see the request). */
export function governanceContextForInvocation(invocationId: string): GovernanceContext | undefined {
  return byInvocation.get(invocationId);
}

/** Forget an invocation's context when its attempt ends. */
export function releaseGovernanceContext(g: GovernanceContext): void {
  if (byInvocation.get(g.workflowId) === g) byInvocation.delete(g.workflowId);
}

export function getGovernanceContext(ctx: restate.Context): GovernanceContext | undefined {
  return registry.get(ctx);
}

export function requireGovernanceContext(ctx: restate.Context): GovernanceContext {
  const g = registry.get(ctx);
  if (!g) {
    throw new OpenBoxContractError(
      "governedRun/governedCall used outside an openboxHandler-wrapped handler. Wrap the handler with openboxHandler(...)."
    );
  }
  return g;
}
