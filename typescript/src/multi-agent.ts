/**
 * Multi-agent (architecture §12): one OpenBox Multi-Agent Session across Restate RPC.
 *
 * Parent:
 * ```ts
 * const report = await governedSubAgent(ctx, { agentName: "ResearchAgent", input: task, toolCallId },
 *   (t, headers) => ctx.serviceClient(ResearchAgent).run(t, restate.rpc.opts({ headers })));
 * ```
 *
 * Child: a normal `openboxHandler`. It reads the headers, joins the parent's
 * `multi_agent_session_id`, links `parent_workflow_id` / `parent_activity_id`,
 * and (when the parent has a DID) sends the `Handoff` event with its own
 * signed client, so Core links the two agents.
 *
 * Headers are never propagated automatically by Restate: pass them explicitly.
 */

import * as restate from "@restatedev/restate-sdk";

import {
  HEADER_MULTI_AGENT_SESSION_ID,
  HEADER_PARENT_ACTIVITY_ID,
  HEADER_PARENT_AGENT_DID,
  HEADER_PARENT_WORKFLOW_ID,
  requireGovernanceContext
} from "./context.js";
import { finishPhase, prePhase, runTool, type BlockedResult, type GovernedRunOptions } from "./governed-run.js";

/**
 * The four `x-openbox-*` headers that make a child invocation part of this
 * agent's Multi-Agent Session. `parentActivityId` is the governing activity
 * of the call (governedSubAgent passes it for you).
 */
export function childHeaders(ctx: restate.Context, parentActivityId?: string | null): Record<string, string> {
  const g = requireGovernanceContext(ctx);
  const headers: Record<string, string> = {
    [HEADER_MULTI_AGENT_SESSION_ID]: g.multiAgentSessionId,
    [HEADER_PARENT_WORKFLOW_ID]: g.workflowId
  };
  if (parentActivityId) headers[HEADER_PARENT_ACTIVITY_ID] = parentActivityId;
  const did = g.rt.config.base.agentDid;
  if (did) headers[HEADER_PARENT_AGENT_DID] = did;
  return headers;
}

export interface SubAgentCall<I> {
  /** The child agent's name, e.g. its Restate service name. The activity is `call:<agentName>`. */
  agentName: string;
  input: I;
  /** The LLM's tool-call id, when the delegation comes from a tool call. */
  toolCallId?: string | null;
  /** Semantic type. Default `AGENT_ACTION`. */
  type?: string | null;
}

/**
 * Govern a call to another governed agent. The delegation itself is an
 * activity (`call:<agentName>`, `__openbox.tool_type = "a2a"`), so policies
 * can block, halt or require approval for it, and `call` receives the
 * headers that put the child in this session.
 */
export async function governedSubAgent<I, O>(
  ctx: restate.Context,
  call: SubAgentCall<I>,
  invoke: (input: I, headers: Record<string, string>) => Promise<O>,
  opts: GovernedRunOptions = {}
): Promise<O | BlockedResult> {
  const g = requireGovernanceContext(ctx);
  const name = `call:${call.agentName}`;
  const p = await prePhase(
    ctx,
    g,
    name,
    {
      input: call.input,
      toolCallId: call.toolCallId ?? null,
      type: call.type ?? "AGENT_ACTION",
      extra: { __openbox: { tool_type: "a2a", subagent_name: call.agentName } }
    },
    opts
  );
  if (p.kind === "done") return p.value;
  const outcome = await runTool(g, p, ctx, (input: I) => invoke(input, childHeaders(ctx, p.id)), opts);
  return finishPhase(ctx, g, p, outcome, opts);
}
