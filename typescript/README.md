# @openbox-ai/openbox-restate-sdk

[OpenBox](https://openbox.ai) governance for durable AI agents on [Restate](https://restate.dev).

Every side-effecting step of your agent is checked against OpenBox policy **before** it runs and reported **after** it runs. The checks are journaled by Restate, so a replay never asks OpenBox the same question twice. When a policy needs a human, the invocation **suspends durably** until a reviewer decides in the OpenBox dashboard. While it waits it uses no compute, and the wait survives crashes, redeploys and serverless cold starts.

```bash
npm install @openbox-ai/openbox-restate-sdk @restatedev/restate-sdk
```

Requires Node ≥ 24.10. `@restatedev/restate-sdk` (≥ 1.17.2) is a peer dependency, so your app and this SDK share one copy.

## Quickstart

```ts
import * as restate from "@restatedev/restate-sdk";
import { openboxHandler, governedCall, isBlocked } from "@openbox-ai/openbox-restate-sdk";

const run = openboxHandler(
  async (ctx: restate.Context, { message }: { message: string }) => {
    // ... your LLM loop; for each tool call the model makes:
    const out = await governedCall(ctx, { toolName, toolCallId, input }, (i) =>
      ctx.run(toolName, () => runTool(toolName, i))
    );
    return isBlocked(out) ? `Blocked by policy: ${out.reason}` : out;
  },
  { agentName: "my-agent", promptFrom: (i) => i.message }
);

restate.serve({ services: [restate.service({ name: "agent", handlers: { run } })] });
```

Credentials come from the environment: `OPENBOX_API_URL`, `OPENBOX_API_KEY`, and optionally `OPENBOX_AGENT_DID` + `OPENBOX_AGENT_PRIVATE_KEY` for signed requests. To pass them explicitly, use `createOpenBoxRestate({ ... })` and the `runtime` option.

## What you get

| Verdict | Effect |
|---|---|
| ALLOW | The tool runs. |
| BLOCK | The tool does not run; `governedCall` **returns** a `BlockedResult` for the model. Use `onBlock: "throw"` to throw instead. |
| HALT | `GovernanceHaltError` (a Restate `TerminalError`) ends the invocation, even if your code or a framework swallows it. OpenBox closes the session at that point, so nothing further is reported. |
| REQUIRE_APPROVAL | A durable wait (`ctx.sleep` between journaled polls), then the tool runs, or `ApprovalRejectedError` / `ApprovalExpiredError`. |
| Guardrails | Input and output redaction is applied; a failed validation throws `GuardrailsValidationError`. |

## API

| Import | What |
|---|---|
| `openboxHandler(fn, opts)` | Wraps a Restate handler. Works for Services, Virtual Objects and Workflows. |
| `governedRun(ctx, name, op, fn)` / `governedCall(ctx, call, fn)` | Govern one side-effecting step. |
| `governedParallel(ctx, calls)` | Pre-checks in call order, tools concurrently, post-checks in call order. |
| `governedSubAgent(ctx, call, invoke)`, `childHeaders(ctx)` | Call another governed agent in the same Multi-Agent Session. |
| `governedLlmCall(ctx, info, call, describe)`, `reportLlmCall(ctx, report)`, `./vercel-ai` → `openboxLlmTelemetry(ctx)` | Govern model calls as `llm_call` activities (model, tokens): input guardrails redact the prompt before the provider sees it; HALT / BLOCK / approval are enforced. `call` receives the approved prompt. `reportLlmCall` is telemetry only. |
| `openboxAuditHook()` | Optional Restate hook. Reports `ctx.run` calls made outside governed tools, audit only. |
| `@openbox-ai/openbox-restate-sdk/vercel-ai` → `governTools(ctx, tools)` | Govern Vercel AI SDK tools (`ai` v6 or v7). |
| `@openbox-ai/openbox-restate-sdk/instrumentation` → `enableOpenBoxSpans()` | Report each tool's HTTP, file and DB calls as spans (patches globals; opt in). |

## Configuration

Resolution order: explicit option, then `OPENBOX_RESTATE_*`, then `OPENBOX_*`, then the default.

| Option | Default | |
|---|---|---|
| `onApiError` | `fail_open` | `fail_closed` turns an OpenBox outage into `OpenBoxUnavailableError` |
| `approvalPollIntervalMs` | 15000 | How often a pending approval is polled (durable sleep) |
| `approvalWaitCapMs` | 3600000 | Then `ApprovalExpiredError` |
| `approvalOutagePolicy` | `fail_closed` | An approval is never auto-granted because OpenBox was unreachable |
| `maxConsecutivePollFailures` | 20 | Before the outage policy applies |
| `governanceMaxRetries` | 3 | Retries of a governance step before the outage policy applies |
| `hitlEnabled` | `true` | `false` turns REQUIRE_APPROVAL into BLOCK |
| `toolTypeMap` | `{}` | Semantic event type per tool name (`EMAIL_SEND`, …) |
| `agentName` | `<Service>.<handler>` | Shown in OpenBox |

## Rules

- **Rollout.** Adding governance changes a handler's journal shape. Deploy it as a new deployment revision, let the old one drain, and set `onJournalMismatchErrors: "pause"`.
- **Journal encryption.** Verdict records (and any redacted values) are journaled. For encrypted journals use Restate's `journalValueCodecProvider`; see `examples/ts-journal-encryption`.
- **One Restate copy.** If a HALT or BLOCK is retried as an HTTP 500, two copies of `@restatedev/restate-sdk` are loaded. Check `npm ls @restatedev/restate-sdk`.

Examples are in the [repository](https://github.com/soumya949/restate).
