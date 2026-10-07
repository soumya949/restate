/**
 * Configuration resolution (architecture §13).
 *
 * Order: explicit option > `<envPrefix>_*` (default `OPENBOX_RESTATE_*`) > `OPENBOX_*` > default.
 * Base fields (URL, key, identity, timeout, onApiError) are resolved by the base
 * SDK's `OpenBoxConfig.resolve`; this module adds the `OPENBOX_URL` alias and the
 * Restate-specific options.
 */

import { OpenBoxConfig, type OnApiError, type PrivacyConfig } from "@openbox-ai/openbox-sdk-ts/config";

import { SDK_ENGINE, SDK_LANGUAGE, SDK_VERSION } from "./version.js";

export const DEFAULT_ENV_PREFIX = "OPENBOX_RESTATE";

export type ApprovalMode = "poll";
export type OutagePolicy = "fail_open" | "fail_closed";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface OpenBoxRestateOptions {
  // ── base OpenBox fields ───────────────────────────────────────────
  apiUrl?: string;
  apiKey?: string;
  timeoutSeconds?: number;
  onApiError?: OnApiError;
  agentDid?: string;
  agentPrivateKey?: string;
  envPrefix?: string;
  privacy?: Partial<PrivacyConfig>;

  // ── Restate-specific ──────────────────────────────────────────────
  /** Sets `workflow_type`. Default: `<Service>.<handler>`. */
  agentName?: string;
  approvalMode?: ApprovalMode;
  approvalPollIntervalMs?: number;
  approvalPollBackoff?: number;
  approvalWaitCapMs?: number;
  maxConsecutivePollFailures?: number;
  /** What to do when Core is unreachable while an approval is pending. Default `fail_closed`. */
  approvalOutagePolicy?: OutagePolicy;
  governanceMaxRetries?: number;
  hitlEnabled?: boolean;
  /** Call `/auth/validate` once per process, lazily on first use. Default true. */
  validate?: boolean;
  /** Maps tool / step names to semantic event types (`EMAIL_SEND`, …). */
  toolTypeMap?: Record<string, string>;

  // ── test / advanced ───────────────────────────────────────────────
  /** Injected fetch (tests, proxies). */
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Environment to read from. Default `process.env`. */
  environ?: Record<string, string | undefined>;
}

export interface RestateGovernanceConfig {
  agentName: string | null;
  approvalMode: ApprovalMode;
  approvalPollIntervalMs: number;
  approvalPollBackoff: number;
  approvalPollMaxIntervalMs: number;
  approvalWaitCapMs: number;
  maxConsecutivePollFailures: number;
  approvalOutagePolicy: OutagePolicy;
  governanceMaxRetries: number;
  hitlEnabled: boolean;
  validate: boolean;
  toolTypeMap: Record<string, string>;
}

export interface ResolvedConfig {
  base: OpenBoxConfig;
  restate: RestateGovernanceConfig;
}

type Env = Record<string, string | undefined>;

function envValue(env: Env, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function lookup(env: Env, prefix: string, suffix: string): string | undefined {
  return envValue(env, `${prefix}_${suffix}`) ?? envValue(env, `OPENBOX_${suffix}`);
}

function num(name: string, raw: string | undefined, fallback: number, min = 0): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`OpenBox Restate config: ${name} must be a number >= ${min}, got "${raw}"`);
  }
  return n;
}

function bool(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`OpenBox Restate config: ${name} must be a boolean, got "${raw}"`);
}

function oneOf<T extends string>(name: string, raw: string | undefined, allowed: readonly T[], fallback: T): T {
  if (raw === undefined) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`OpenBox Restate config: ${name} must be one of ${allowed.join(", ")}, got "${raw}"`);
}

/**
 * `OPENBOX_URL` is what docs.openbox.ai and the Mastra SDK use; the base SDK
 * reads `OPENBOX_API_URL`. Accept both, prefer the base name, warn on conflict.
 */
function resolveApiUrl(opts: OpenBoxRestateOptions, env: Env, prefix: string, logger: Logger): string | undefined {
  if (opts.apiUrl) return opts.apiUrl;
  const canonical = envValue(env, `${prefix}_API_URL`) ?? envValue(env, "OPENBOX_API_URL");
  const alias = envValue(env, `${prefix}_URL`) ?? envValue(env, "OPENBOX_URL");
  if (canonical && alias && canonical !== alias) {
    logger.warn(`OPENBOX_API_URL (${canonical}) and OPENBOX_URL (${alias}) differ; using OPENBOX_API_URL`);
  }
  return canonical ?? alias;
}

export function resolveRestateConfig(opts: OpenBoxRestateOptions = {}): ResolvedConfig {
  const env: Env = opts.environ ?? process.env;
  const prefix = opts.envPrefix ?? DEFAULT_ENV_PREFIX;
  const logger = opts.logger ?? console;

  const apiUrl = resolveApiUrl(opts, env, prefix, logger);
  const base = OpenBoxConfig.resolve({
    envPrefix: prefix,
    environ: env,
    ...(apiUrl !== undefined ? { apiUrl } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
    ...(opts.onApiError !== undefined ? { onApiError: opts.onApiError } : {}),
    ...(opts.agentDid !== undefined ? { agentDid: opts.agentDid } : {}),
    ...(opts.agentPrivateKey !== undefined ? { agentPrivateKey: opts.agentPrivateKey } : {}),
    ...(opts.agentName !== undefined ? { agentName: opts.agentName } : {}),
    sdkEngine: SDK_ENGINE,
    sdkLanguage: SDK_LANGUAGE,
    sdkVersion: SDK_VERSION
  });
  if (opts.privacy) {
    base.privacy = {
      redactKeys: opts.privacy.redactKeys ?? base.privacy.redactKeys,
      maxBodySize: opts.privacy.maxBodySize ?? base.privacy.maxBodySize
    };
  }

  const r = (suffix: string) => lookup(env, prefix, suffix);
  const restate: RestateGovernanceConfig = {
    agentName: opts.agentName ?? base.agentName ?? null,
    approvalMode: opts.approvalMode ?? oneOf("APPROVAL_MODE", r("APPROVAL_MODE"), ["poll"] as const, "poll"),
    approvalPollIntervalMs: opts.approvalPollIntervalMs ?? num("APPROVAL_POLL_INTERVAL_MS", r("APPROVAL_POLL_INTERVAL_MS"), 15_000, 100),
    approvalPollBackoff: opts.approvalPollBackoff ?? num("APPROVAL_POLL_BACKOFF", r("APPROVAL_POLL_BACKOFF"), 1.0, 1),
    approvalPollMaxIntervalMs: 60_000,
    approvalWaitCapMs: opts.approvalWaitCapMs ?? num("APPROVAL_WAIT_CAP_MS", r("APPROVAL_WAIT_CAP_MS"), 3_600_000, 1),
    maxConsecutivePollFailures:
      opts.maxConsecutivePollFailures ?? num("MAX_CONSECUTIVE_POLL_FAILURES", r("MAX_CONSECUTIVE_POLL_FAILURES"), 20, 1),
    approvalOutagePolicy:
      opts.approvalOutagePolicy ??
      oneOf("APPROVAL_OUTAGE_POLICY", r("APPROVAL_OUTAGE_POLICY"), ["fail_open", "fail_closed"] as const, "fail_closed"),
    governanceMaxRetries: opts.governanceMaxRetries ?? num("GOVERNANCE_MAX_RETRIES", r("GOVERNANCE_MAX_RETRIES"), 3, 1),
    hitlEnabled: opts.hitlEnabled ?? bool("HITL_ENABLED", r("HITL_ENABLED"), true),
    validate: opts.validate ?? bool("VALIDATE", r("VALIDATE"), true),
    toolTypeMap: { ...(opts.toolTypeMap ?? {}) }
  };

  return { base, restate };
}
