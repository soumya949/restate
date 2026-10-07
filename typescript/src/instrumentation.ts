/**
 * `@openbox-ai/openbox-restate-sdk/instrumentation` — opt-in span capture.
 *
 * Installs the base SDK's HTTP (fetch, node:http/https), file and (opt-in) DB
 * instrumentation and binds every `governedRun` tool execution as an OpenBox
 * activity, so the calls a tool makes show up as `http_request` / `db_query` /
 * `file_operation` spans under that activity, each with its own verdict.
 *
 * Never imported by the package root: this module patches process globals.
 *
 * Restate semantics:
 *  - Spans are side effects of the tool's own `ctx.run` closure, so they fire
 *    exactly when the closure really executes (once per attempt), never on replay.
 *  - A span preflight BLOCK/HALT is raised INSIDE that closure, so it is thrown
 *    as a tagged `TerminalError` (architecture §9.1): Restate does not retry
 *    it, and `governedRun` maps it back to a BlockedResult / GovernanceHaltError.
 *  - A span-level REQUIRE_APPROVAL cannot suspend durably from inside a
 *    closure. It passes when the activity itself was already approved (one
 *    poll), and otherwise fails safe as a block.
 */

import { ActivityContext, type EvaluationResult } from "@openbox-ai/openbox-sdk-ts";
import type { FrameworkAdapter } from "@openbox-ai/openbox-sdk-ts/adapters";
import type { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import {
  OpenBoxInstrumentationError,
  initOpenBoxInstrumentation,
  type DatabaseDriverName,
  type OpenBoxInstrumentationController
} from "@openbox-ai/openbox-sdk-ts/instrumentation";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

import { taggedHookError } from "./errors.js";
import { getDefaultRuntime, type OpenBoxRestate, type SpanBinder, type SpanScopeInfo } from "./runtime.js";

const SPAN_APPROVAL_NOT_GRANTED =
  "span requires approval, but its activity has not been approved; span-level approvals cannot wait inside ctx.run " +
  "on Restate, so put the approval rule on the activity (event_type ActivityStarted, no hook_trigger)";

function approvalKey(workflowId: string, activityId: string): string {
  return `${workflowId}/${activityId}`;
}

/** Turns span verdicts into errors that survive the ctx.run boundary. */
class RestateSpanAdapter implements FrameworkAdapter {
  readonly name = "restate";

  /** Activities currently running whose ActivityStarted was approved by a human (key: workflow/activity). */
  readonly approvedActivities = new Set<string>();

  constructor(private readonly client: OpenBoxClient) {}

  /**
   * Span events carry `event_type: ActivityStarted` + the activity's type, so an
   * activity-level approval rule also matches the tool's own spans. When the
   * activity itself was approved (governedRun waited for that durably), its
   * spans pass without asking again. Otherwise: one poll, no waiting, and a
   * block unless Core already reports the activity approved.
   */
  async handleApproval(_result: EvaluationResult, context?: ActivityContext | null): Promise<void> {
    if (context?.workflowId && context.activityId && this.approvedActivities.has(approvalKey(context.workflowId, context.activityId))) {
      return;
    }
    if (context?.workflowId && context.runId && context.activityId) {
      const approval = await this.client.pollApproval(context.workflowId, context.runId, context.activityId).catch(() => null);
      if (approval?.allowShaped) return;
    }
    throw taggedHookError("hook_block", SPAN_APPROVAL_NOT_GRANTED, null);
  }

  raiseLifecycleBlocked(result: EvaluationResult): never {
    // Lifecycle events go through governedRun/openboxHandler, never through this runtime.
    this.raiseHookBlocked(result);
  }

  raiseHookBlocked(result: EvaluationResult): never {
    const kind = result.verdict === "halt" ? "hook_halt" : "hook_block";
    throw taggedHookError(kind, result.reason ?? `span ${result.verdict} by policy`, result.policyId ?? null);
  }

  onCompletedHookResult(): void {
    // The call already happened. The base runtime records abort/halt flags; governedRun reads the halt flag.
  }
}

export interface OpenBoxSpansOptions {
  /** Defaults to the env-configured default runtime. */
  runtime?: OpenBoxRestate;
  /** Throw instead of logging when a target cannot be patched. Default false. */
  strict?: boolean;
  /** DB drivers to govern (explicit opt-in): "pg" | "redis" | "mysql2" | "mongodb". */
  databases?: readonly DatabaseDriverName[];
}

export interface OpenBoxSpans {
  readonly installedTargets: readonly string[];
  /** Drain in-flight completed-span telemetry, then restore every patched target. */
  close(): Promise<void>;
}

/**
 * Enable span capture for a runtime. Call once at startup, before serving:
 *
 * ```ts
 * import { enableOpenBoxSpans } from "@openbox-ai/openbox-restate-sdk/instrumentation";
 * enableOpenBoxSpans();
 * ```
 *
 * Which targets are patched follows the base config (`instrumentation.httpEnabled`,
 * `fileEnabled`, `dbEnabled`, ...). Only one runtime per process can own the patches.
 */
export function enableOpenBoxSpans(options: OpenBoxSpansOptions = {}): OpenBoxSpans {
  const rt = options.runtime ?? getDefaultRuntime();
  if (rt.spanBinder) throw new OpenBoxInstrumentationError("OpenBox spans are already enabled for this runtime");

  // Shares the runtime's client (same identity and auth). Never closed here: the client belongs to `rt`.
  const adapter = new RestateSpanAdapter(rt.client);
  const base = new OpenBoxRuntime(rt.config.base, { client: rt.client, adapter, logger: rt.logger });
  const controller: OpenBoxInstrumentationController = initOpenBoxInstrumentation({
    runtime: base,
    strict: options.strict ?? false,
    logger: rt.logger,
    ...(options.databases ? { databases: options.databases } : {})
  });

  const binder: SpanBinder = {
    run<T>(info: SpanScopeInfo, fn: () => Promise<T>): Promise<T> {
      const activity = new ActivityContext({
        workflowId: info.workflowId,
        runId: info.runId,
        workflowType: info.workflowType,
        activityId: info.activityId,
        activityType: info.activityType,
        agentName: info.agentName,
        sessionId: info.sessionId,
        multiAgentSessionId: info.multiAgentSessionId
      });
      if (!info.approved) return base.contextStore.activityScope(activity, fn);
      const key = approvalKey(info.workflowId, info.activityId);
      adapter.approvedActivities.add(key);
      return base.contextStore.activityScope(activity, fn).finally(() => adapter.approvedActivities.delete(key));
    },
    isHaltRequested(workflowId: string, runId: string): boolean {
      return base.contextStore.isHaltRequested(workflowId, runId);
    }
  };
  rt.spanBinder = binder;

  return {
    installedTargets: controller.installedTargets,
    async close(): Promise<void> {
      if (rt.spanBinder === binder) rt.spanBinder = null;
      await controller.flush();
      controller.shutdown();
    }
  };
}
