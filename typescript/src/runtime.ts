/**
 * Process-scoped runtime (architecture §3.4): one resolved config and one
 * `OpenBoxClient` per process. Never holds per-invocation state.
 */

import { OpenBoxAuthError } from "@openbox-ai/openbox-sdk-ts";
import { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";

import { resolveRestateConfig, type Logger, type OpenBoxRestateOptions, type ResolvedConfig } from "./config.js";

/** Identity of one governed tool call, used to bind its HTTP/DB/file spans (instrumentation.ts). */
export interface SpanScopeInfo {
  workflowId: string;
  runId: string;
  workflowType: string;
  activityId: string;
  activityType: string;
  agentName: string | null;
  sessionId: string;
  multiAgentSessionId: string;
}

/**
 * Installed by `enableOpenBoxSpans()` (subpath `./instrumentation`). The root
 * never imports the base instrumentation; it only calls this seam if present.
 */
export interface SpanBinder {
  run<T>(info: SpanScopeInfo, fn: () => Promise<T>): Promise<T>;
  /** A completed-span verdict asked to HALT this run. */
  isHaltRequested(workflowId: string, runId: string): boolean;
}

export class OpenBoxRestate {
  readonly config: ResolvedConfig;
  readonly client: OpenBoxClient;
  readonly logger: Logger;
  /** Null unless span capture was enabled for this runtime. */
  spanBinder: SpanBinder | null = null;
  private validated = false;
  private validating: Promise<void> | null = null;

  constructor(options: OpenBoxRestateOptions = {}) {
    this.logger = options.logger ?? console;
    this.config = resolveRestateConfig(options);
    this.client = OpenBoxClient.fromConfig(this.config.base, {
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      logger: this.logger
    });
  }

  /**
   * Validate the API key once per process, lazily, from inside the first
   * journaled governance step (never at import time). Auth failures throw;
   * a network failure is logged and validation is retried on a later step.
   */
  async ensureValidated(): Promise<void> {
    if (this.validated || !this.config.restate.validate) return;
    this.validating ??= (async () => {
      try {
        await this.client.validateApiKey();
        this.validated = true;
      } catch (e) {
        if (e instanceof OpenBoxAuthError) throw e;
        this.logger.warn(`OpenBox API key validation skipped (Core unreachable): ${String(e)}`);
      } finally {
        this.validating = null;
      }
    })();
    return this.validating;
  }

  close(): void {
    this.client.close();
  }
}

/** Create a runtime with explicit options (recommended for production code). */
export function createOpenBoxRestate(options: OpenBoxRestateOptions = {}): OpenBoxRestate {
  return new OpenBoxRestate(options);
}

let defaultRuntime: OpenBoxRestate | null = null;

/** Lazily-built runtime from environment variables, used when a handler is given no runtime. */
export function getDefaultRuntime(): OpenBoxRestate {
  defaultRuntime ??= new OpenBoxRestate();
  return defaultRuntime;
}

/** Test hook: replace or clear the default runtime. */
export function setDefaultRuntime(rt: OpenBoxRestate | null): void {
  defaultRuntime = rt;
}
