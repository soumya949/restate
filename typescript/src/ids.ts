/**
 * Deterministic identifiers (architecture §4). Pure functions of journaled or
 * invocation-constant inputs. Never use randomUUID / Date.now here.
 */

import type { GovernanceContext } from "./context.js";
import { OpenBoxContractError } from "./errors.js";

/**
 * `${workflow_id}:${toolCallId}` when the LLM gave us a tool-call id (stable on
 * replay because the LLM response itself is journaled), else
 * `${workflow_id}:${name}#${n}` with a per-name counter in program order.
 */
export function activityIdFor(g: GovernanceContext, name: string, toolCallId?: string | null): string {
  let id: string;
  if (toolCallId) {
    id = `${g.workflowId}:${toolCallId}`;
  } else {
    const n = g.nameCounters.get(name) ?? 0;
    g.nameCounters.set(name, n + 1);
    id = `${g.workflowId}:${name}#${n}`;
  }
  if (g.usedActivityIds.has(id)) {
    throw new OpenBoxContractError(
      `duplicate activity id "${id}" in one invocation (the same toolCallId was governed twice); approval polling would collide`
    );
  }
  g.usedActivityIds.add(id);
  return id;
}

export const START_ACTIVITY_SUFFIX = "__start__";
export const END_ACTIVITY_SUFFIX = "__end__";

export const stepNames = {
  start: "openbox:start",
  end: "openbox:end",
  endFailed: "openbox:end-failed",
  pre: (activityId: string) => `openbox:pre:${activityId}`,
  post: (activityId: string) => `openbox:post:${activityId}`,
  postFailed: (activityId: string) => `openbox:post-failed:${activityId}`,
  approvalPoll: (key: string, n: number) => `openbox:approval-poll:${key}:${n}`,
  approvalWait: (key: string, n: number) => `openbox:approval-wait:${key}:${n}`,
  llm: (activityId: string) => `openbox:llm:${activityId}`,
  llmPre: (activityId: string) => `openbox:llm-pre:${activityId}`,
  llmPost: (activityId: string) => `openbox:llm-post:${activityId}`
} as const;
