# openbox-restate-sdk

OpenBox governance for durable AI agents running on [Restate](https://restate.dev).

Every side-effecting step of a Restate agent is checked against OpenBox policy **before** it runs and reported **after** it runs. All of these checks are journaled, so a replay never asks OpenBox the same question twice.

When a policy needs human approval, the invocation **suspends durably** until a reviewer decides in the OpenBox dashboard. While it waits it uses no compute, and the wait survives crashes, redeploys and serverless cold starts.

| Package | Path | Status |
|---|---|---|
| `@openbox-ai/openbox-restate-sdk` (TypeScript) | [`typescript/`](typescript) | P0 + P1 done |
| `openbox-restate-sdk` / `openbox_restate` (Python) | [`python/`](python) | P1 done |

Design docs: [`../openbox-restate-sdk-prd.md`](../openbox-restate-sdk-prd.md) and [`../architecture.md`](../architecture.md). Section numbers in code comments (§x.y) refer to `architecture.md`.

## How it works

1. **`openboxHandler` / `@openbox_handler`** wraps the Restate handler.
   - It sends `WorkflowStarted` (plus `SignalReceived(user_prompt)`) at the start.
   - It sends `WorkflowCompleted` at the end, or `WorkflowFailed` on a terminal error.
2. **`governedRun` / `governed_run`** wraps each tool call:

| Phase | What happens |
|---|---|
| PRE | `ctx.run("openbox:pre:<id>")` sends `ActivityStarted` and returns a verdict. The verdict is journaled. |
| ENFORCE | `halt` throws `GovernanceHaltError`. `block` **returns** a `BlockedResult`, which goes back to the LLM. `require_approval` starts a durable poll (`ctx.sleep` between journaled polls). |
| EXECUTE | Your tool runs, journaled by its own `ctx.run`. |
| POST | `ctx.run("openbox:post:<id>")` sends `ActivityCompleted`. Output guardrails can redact the result here. |

## Quickstart (TypeScript)

```ts
import * as restate from "@restatedev/restate-sdk";
import { openboxHandler, governedCall, isBlocked } from "@openbox-ai/openbox-restate-sdk";

const run = openboxHandler(async (ctx: restate.Context, { message }: { message: string }) => {
  // ... LLM call in ctx.run ...
  for (const { toolName, toolCallId, input } of result.toolCalls) {
    const out = await governedCall(ctx, { toolName, toolCallId, input }, (i) => runTool(ctx, toolName, i));
    messages.push(toolResult(toolCallId, toolName, isBlocked(out) ? `Blocked by policy: ${out.reason}` : out));
  }
}, { agentName: "my-agent", promptFrom: (i) => i.message });
```

## Quickstart (Python)

```python
from openbox_restate import openbox_handler, governed_call

@agent.handler()
@openbox_handler(agent_name="my-agent", prompt_from=lambda p: p.message)
async def run(ctx: restate.Context, prompt: Prompt) -> str:
    ...
    result = await governed_call(ctx, tool_name=name, tool_call_id=tc.id, arguments=args, run=run_tool)
```

## Spans (HTTP / file / DB calls inside a tool)

Opt in once at startup, after the env is loaded:

```ts
import { enableOpenBoxSpans } from "@openbox-ai/openbox-restate-sdk/instrumentation";
enableOpenBoxSpans(); // { databases: ["pg"] } to also govern a DB driver
```

Every call a governed tool makes (fetch, node:http/https, fs, opted-in DB drivers) is reported as a span of that tool's activity, with `stage: started` before it goes out and `stage: completed` after. Each span gets its own verdict.
- **Exactly once.** Spans fire only when the tool's `ctx.run` closure really executes, never on replay.
- **Span BLOCK / HALT.** The call never goes out. BLOCK returns a `BlockedResult`; HALT ends the session. Restate does not retry either.
- **Approval rules.** Span events are sent as `event_type: ActivityStarted` with `hook_trigger: true` and the tool's `activity_type`, so an activity approval rule also matches the tool's spans. They pass because the activity was already approved. A span-only approval cannot wait inside `ctx.run`, so it fails safe as a block.
- **LLM calls are not spans.** Calls made outside a governed tool, such as the LLM call itself, are skipped with a log line.

Python: `pip install "openbox-restate-sdk[spans]"`, then call it once before serving. It covers httpx, requests, urllib3 and urllib, plus DB drivers and file I/O per the base config.

```python
from openbox_restate.instrumentation import enable_openbox_spans
enable_openbox_spans()
```

## Configuration

1. Copy [`.env.example`](.env.example) to `.env` in this folder. `.env` is git-ignored.
2. Fill in `OPENBOX_API_URL`, `OPENBOX_API_KEY`, `OPENBOX_AGENT_DID` and `OPENBOX_AGENT_PRIVATE_KEY` from a **sandbox** OpenBox agent.
3. Set `OPENAI_API_KEY` if you want to run the examples.

Defaults:

| Setting | Default |
|---|---|
| `onApiError` | `fail_open` |
| `approvalOutagePolicy` | `fail_closed` (a pending approval is never auto-granted because OpenBox was unreachable) |
| Approval poll interval | 15 s |
| Approval wait cap | 1 h |

All options are listed in architecture §13.

## Tests

| Command | What it runs | Needs |
|---|---|---|
| `cd typescript && npm test` | unit tests + Restate integration (testcontainers, `alwaysReplay`) | Docker |
| `cd typescript && npm run ci:check` | source rules, typecheck, tests, build, import-light check | Docker |
| `docker compose -f python/docker-compose.test.yml run --rm tests` | ruff, mypy (strict), unit tests + Restate integration (replay forced) | Docker |
| `cd typescript && npm run test:live` | live smoke against your OpenBox sandbox (never part of `npm test`) | `.env` |

`restate-sdk` (Python) ships no Windows wheel. On Windows, run the Python suite and the Python example through Docker as shown.

The integration tests use a routing fake OpenBox Core that keeps a request ledger. Every test asserts that each event reaches Core **exactly once**, even though the Restate server replays the journal after every suspension.

## Examples

| Example | Run |
|---|---|
| [`examples/ts-restate-only`](examples/ts-restate-only) | `npm install && npm start`, then `restate deployments register localhost:9080` |
| [`examples/py-restate-only`](examples/py-restate-only) | `docker compose -f examples/py-restate-only/docker-compose.yml up` |

Invoke either example:

```bash
curl localhost:8080/agent/run --json '{"message": "What is the weather in Paris? Then email it to bob@example.com"}'
```

Each example has four tools, one per sandbox policy:
- `get_weather`: ALLOW
- `delete_records`: BLOCK
- `wire_money`: HALT
- `send_email`: REQUIRE_APPROVAL. Approve or reject it in the OpenBox dashboard and the agent resumes.

## Rollout rule

Adding governance changes the journal shape of a handler. Deploy it as a **new deployment revision** and let the old one drain. Governed services set `onJournalMismatchErrors: "pause"` (architecture §10 I7).
