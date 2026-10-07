/**
 * Routing fake OpenBox Core (architecture §18.2).
 *
 * - Answers evaluate requests from rules keyed on the request body (so answers
 *   do not depend on call order, which Restate retries/replays would break).
 * - Answers approval polls from a per-activity script.
 * - Records a LEDGER of every request, so tests can assert "exactly one
 *   ActivityStarted per step" across retries and replays.
 */

export interface LedgerEntry {
  path: string;
  eventType: string | null;
  activityId: string | null;
  activityType: string | null;
  workflowId: string | null;
  body: Record<string, unknown>;
}

export type EvaluateAnswer = Record<string, unknown>;
export type Rule = (body: Record<string, unknown>) => EvaluateAnswer | undefined;
export type Mode = "ok" | "down" | "auth401" | "http500";

export class FakeCore {
  readonly ledger: LedgerEntry[] = [];
  private rules: Rule[] = [];
  private approvals = new Map<string, EvaluateAnswer[]>();
  /** Applies to evaluate + approval; validate always succeeds unless `auth401`. */
  mode: Mode = "ok";
  /** Mode for approval polls only (overrides `mode` when set). */
  approvalMode: Mode | null = null;

  reset(): void {
    this.ledger.length = 0;
    this.rules = [];
    this.approvals.clear();
    this.mode = "ok";
    this.approvalMode = null;
  }

  /** Add a rule; first matching rule wins. Unmatched → `{verdict:"allow"}`. */
  rule(r: Rule): this {
    this.rules.push(r);
    return this;
  }

  /** Answer `verdict` for every event of `activityType` with the given event type. */
  onActivity(activityType: string, eventType: "ActivityStarted" | "ActivityCompleted", answer: EvaluateAnswer): this {
    return this.rule((b) => (b["activity_type"] === activityType && b["event_type"] === eventType ? answer : undefined));
  }

  onEvent(eventType: string, answer: EvaluateAnswer): this {
    return this.rule((b) => (b["event_type"] === eventType && !b["activity_type"] ? answer : undefined));
  }

  /** Script approval-poll answers for activities whose id ends with `suffix`; the last answer repeats. */
  scriptApproval(activityIdSuffix: string, ...answers: EvaluateAnswer[]): this {
    this.approvals.set(activityIdSuffix, [...answers]);
    return this;
  }

  count(pred: (e: LedgerEntry) => boolean): number {
    return this.ledger.filter(pred).length;
  }

  evaluations(eventType?: string, activityType?: string): LedgerEntry[] {
    return this.ledger.filter(
      (e) =>
        e.path.endsWith("/governance/evaluate") &&
        (eventType === undefined || e.eventType === eventType) &&
        (activityType === undefined || e.activityType === activityType)
    );
  }

  polls(): LedgerEntry[] {
    return this.ledger.filter((e) => e.path.endsWith("/governance/approval"));
  }

  readonly fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    let body: Record<string, unknown> = {};
    if (init?.body) {
      const text = typeof init.body === "string" ? init.body : Buffer.from(init.body as Uint8Array).toString("utf8");
      if (text) body = JSON.parse(text) as Record<string, unknown>;
    }
    this.ledger.push({
      path,
      eventType: (body["event_type"] as string) ?? null,
      activityId: (body["activity_id"] as string) ?? null,
      activityType: (body["activity_type"] as string) ?? null,
      workflowId: (body["workflow_id"] as string) ?? null,
      body
    });

    if (path.endsWith("/auth/validate")) {
      return this.mode === "auth401" ? json(401, { error: "invalid api key" }) : json(200, { valid: true });
    }

    const mode = path.endsWith("/governance/approval") ? (this.approvalMode ?? this.mode) : this.mode;
    if (mode === "down") throw new TypeError("fetch failed (fake Core down)");
    if (mode === "auth401") return json(401, { error: "invalid api key" });
    if (mode === "http500") return json(500, { error: "boom" });

    if (path.endsWith("/governance/evaluate")) {
      for (const r of this.rules) {
        const a = r(body);
        if (a) return json(200, a);
      }
      return json(200, { verdict: "allow" });
    }
    if (path.endsWith("/governance/approval")) {
      const id = String(body["activity_id"] ?? "");
      for (const [suffix, answers] of this.approvals) {
        if (id.endsWith(suffix)) {
          const a = answers.length > 1 ? answers.shift()! : answers[0]!;
          return json(200, a);
        }
      }
      return json(200, { verdict: "require_approval" }); // pending
    }
    return json(404, { error: `unknown path ${path}` });
  };
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
