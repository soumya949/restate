# openbox-restate-sdk

[![CI](https://github.com/soumya949/restate/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/soumya949/restate/actions/workflows/ci.yml)

OpenBox governance for durable AI agents running on [Restate](https://restate.dev).

Every side-effecting step of a Restate agent is checked against OpenBox policy **before** it runs and reported **after** it runs. All of these checks are journaled, so a replay never asks OpenBox the same question twice.

When a policy needs human approval, the invocation **suspends durably** until a reviewer decides in the OpenBox dashboard. While it waits it uses no compute, and the wait survives crashes, redeploys and serverless cold starts.

| Package | Path | Status |
|---|---|---|
| `@openbox-ai/openbox-restate-sdk` (TypeScript) | [`typescript/`](typescript) | P0–P3 done (not yet published) |
| `openbox-restate-sdk` / `openbox_restate` (Python) | [`python/`](python) | P0–P4 done (not yet published) |

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

## Frameworks (one diff on top of Restate's templates)

**Vercel AI SDK** (TypeScript, `ai` v6 or v7): wrap the tools passed to `generateText`.

```ts
import { governTools } from "@openbox-ai/openbox-restate-sdk/vercel-ai";

const run = openboxHandler(async (ctx: restate.Context, { prompt }: { prompt: string }) => {
  const { text } = await generateText({
    model: wrapLanguageModel({ model: openai("gpt-5.4"), middleware: durableCalls(ctx) }),
    prompt,
    tools: governTools(ctx, { getWeather: tool({ inputSchema, execute }) }),
  });
  return text;
}, { agentName: "my-agent", promptFrom: (i) => i.prompt });
```

- Each tool is governed under the AI SDK's `toolCallId`.
- A BLOCK goes back to the model as the tool result.
- Tool calls from one step run their checks one at a time, in call order, even though the AI SDK starts them concurrently.
- A HALT ends the invocation, even though the AI SDK turns tool errors into tool results.

**OpenAI Agents SDK** (Python): `pip install "openbox-restate-sdk[openai]"` and govern the agent before `DurableRunner.run`.

```python
from openbox_restate.openai import govern_agent

@agent_service.handler()
@openbox_handler(agent_name="my-agent", prompt_from=lambda r: r.message)
async def run(_ctx: restate.Context, req: Prompt) -> str:
    result = await DurableRunner.run(govern_agent(assistant), req.message)
    return result.final_output
```

- Every `FunctionTool` of the agent and its handoff agents is governed under the model's `tool_call_id`.
- A BLOCK goes back to the model as `"Blocked by policy: …"`.
- A HALT is raised as an exception that is both an `AgentsException` and a `TerminalError`, so the Agents SDK does not retry it.
- `@governed_function_tool` builds a single governed tool directly.
- Hosted tools (web search, hosted MCP) run at OpenAI and cannot be checked before they run.

**Google ADK, Pydantic AI, LangChain** (Python): swap Restate's integration class for the OpenBox one. It *is* Restate's class, with governance added inside Restate's turn-ordered tool window and an `llm_call` activity around every model call.

| Framework | Restate's class | OpenBox drop-in | Extra |
|---|---|---|---|
| Google ADK | `RestatePlugin()` | `openbox_restate.adk.OpenBoxRestatePlugin()` | `[adk]` |
| Pydantic AI | `RestateAgent(agent)` | `openbox_restate.pydantic_ai.OpenBoxRestateAgent(agent)` | `[pydantic-ai]` |
| LangChain | `RestateMiddleware()` | `openbox_restate.langchain.OpenBoxRestateMiddleware()` | `[langchain]` |

Add `@openbox_handler` to the handler as usual. In all three, a BLOCK goes back to the model as the tool result, a HALT ends the invocation, and approvals wait durably. ADK wraps callback errors in `RuntimeError`; `openbox_handler` unwraps governance errors, so they stay terminal.

**Parallel tool calls** (`governedParallel` / `governed_parallel`): the pre-checks run one at a time in call order, the tools run concurrently, then the post-checks run in call order. This keeps the journal deterministic.

## LLM calls (Model Usage, Cost, "LLM Calls")

Each model call is governed as an `llm_call` activity carrying the prompt, the model, the token counts and the completion. Both checks are journaled, so a replay never sends them twice. The verdict is enforced like a tool's:

- **Input guardrails** (for example PII redaction) rewrite the latest user prompt **before** the model provider sees it.
- **HALT** ends the invocation, and **BLOCK** or a failed guardrail refuses the call. Both are terminal, and the model is never called.
- **REQUIRE_APPROVAL** waits durably for a reviewer, then the call runs.

Guardrails check the latest user prompt. Earlier turns of a conversation are sent as they are in your history.

| Where | How |
|---|---|
| Vercel AI SDK | `wrapLanguageModel({ model, middleware: [openboxLlmTelemetry(ctx), durableCalls(ctx)] })`. Put it before `durableCalls`. |
| OpenAI Agents SDK | Automatic: `govern_agent` adds agent hooks, chained with any hooks you already have |
| Google ADK, Pydantic AI, LangChain | Automatic: the OpenBox drop-in classes |
| Raw loops | Wrap the journaled LLM call: `governedLlmCall(ctx, { prompt }, ({ prompt }) => ctx.run(...), describe)` / `governed_llm_call(ctx, lambda approved: ctx.run_typed(...), describe, prompt=...)`. `call` receives the **approved** prompt: build the model request from it. (`reportLlmCall` / `report_llm_call` reports after the fact, without spans, and is telemetry only.) |

With span capture on, the model provider's HTTP request appears as a span of its `llm_call`. The `llm_call` is started before the request, the same way as a governed tool.

Governed tools also send `duration_ms` on `ActivityCompleted`, which OpenBox shows as latency. It is measured from journaled timestamps, starting after any approval wait.

## Multi-agent

A parent agent calls a child agent over Restate RPC with `governedSubAgent` / `governed_sub_agent`:

```ts
const report = await governedSubAgent(ctx, { agentName: "research", input: { question }, toolCallId },
  (input, headers) => ctx.serviceClient(Research).run(input, restate.rpc.opts({ headers })));
```

- **The delegation is governed.** It is an activity, `call:<agent>` with `__openbox.tool_type = "a2a"`, so policies can block, halt or require approval for it.
- **The child joins the parent's session.** It is a normal `openboxHandler`. The headers make it adopt the parent's `multi_agent_session_id` and link `parent_workflow_id` / `parent_activity_id`.
- **The child sends the Handoff.** When the parent has a DID, the child sends `Handoff{from_agent_did: <parent DID>}` with its own signed client, because Core identifies the receiver from the signature.
- **Each agent keeps its own identity.** Every agent uses its own OpenBox API key and DID.

## Spans (HTTP / file / DB calls inside a tool)

Opt in once at startup, after the env is loaded:

```ts
import { enableOpenBoxSpans } from "@openbox-ai/openbox-restate-sdk/instrumentation";
enableOpenBoxSpans(); // { databases: ["pg"] } to also govern a DB driver
```

Every call a governed tool makes (fetch, node:http/https, fs, opted-in DB drivers) is reported as a span of that tool's activity, with `stage: started` before it goes out and `stage: completed` after. Each span gets its own verdict.
- **Exactly once.** Spans fire only when the tool's `ctx.run` closure really executes, never on replay.
- **Span BLOCK / HALT.** The call never goes out. BLOCK returns a `BlockedResult`; HALT ends the session. Restate does not retry either.
- **Approval rules.** Span events are sent as `event_type: ActivityStarted` with `hook_trigger: true` and the tool's `activity_type`, so an activity approval rule also matches the tool's spans.
  - When a human already approved the activity, its spans pass without asking again.
  - A span-only approval on an activity nobody approved cannot wait inside `ctx.run`, so it fails safe as a block.
  - To keep such a rule from matching spans at all, add `hook_trigger is not true` to it.
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

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on every pull request to `main` and every push to `main`. It has three jobs: TypeScript (`ci:check`), Python (the Docker suite) and a typecheck of the TypeScript examples. It needs no secrets; the live tests are never run there.

`restate-sdk` (Python) ships no Windows wheel. On Windows, run the Python suite and the Python example through Docker as shown.

The integration tests use a routing fake OpenBox Core that keeps a request ledger. Every test asserts that each event reaches Core **exactly once**, even though the Restate server replays the journal after every suspension.

## Examples

The TypeScript examples install the SDK from a packed tarball, as a real install would. Run `cd typescript && npm run pack:examples` once, and again after SDK changes.

| Example | What | Run |
|---|---|---|
| [`examples/ts-restate-only`](examples/ts-restate-only) | raw agent loop + `governedCall` | `npm install && npm start`, register `localhost:9080` |
| [`examples/ts-vercel-ai`](examples/ts-vercel-ai) | Vercel AI SDK + `governTools` | `npm install && npm start`, register `localhost:9081` |
| [`examples/ts-multi-agent`](examples/ts-multi-agent) | lead → research over RPC, two OpenBox agents | `npm run start:research` and `npm run start:lead`, register `:9083` and `:9082` |
| [`examples/ts-journal-encryption`](examples/ts-journal-encryption) | encrypted journal (incl. verdict records) | `npm install && npm start`, then `npm run call` |
| [`examples/py-restate-only`](examples/py-restate-only) | raw agent loop + `governed_call` | `docker compose -f examples/py-restate-only/docker-compose.yml up` |
| [`examples/py-google-adk`](examples/py-google-adk) | Google ADK + `OpenBoxRestatePlugin` (OpenAI via LiteLLM) | `docker compose -f examples/py-google-adk/docker-compose.yml up` |
| [`examples/py-pydantic-ai`](examples/py-pydantic-ai) | Pydantic AI + `OpenBoxRestateAgent` | `docker compose -f examples/py-pydantic-ai/docker-compose.yml up` |
| [`examples/py-langchain`](examples/py-langchain) | LangChain + `OpenBoxRestateMiddleware` | `docker compose -f examples/py-langchain/docker-compose.yml up` |
| [`examples/py-openai-agents`](examples/py-openai-agents) | OpenAI Agents SDK + `govern_agent` | `docker compose -f examples/py-openai-agents/docker-compose.yml up` |

The multi-agent example also needs the child agent's credentials in `.env`: `CHILD_OPENBOX_API_KEY`, `CHILD_OPENBOX_AGENT_DID` and `CHILD_OPENBOX_AGENT_PRIVATE_KEY`.

Each single-agent example has four tools, one per sandbox policy:
- `get_weather`: ALLOW
- `delete_records`: BLOCK
- `wire_money`: HALT
- `send_email`: REQUIRE_APPROVAL. Approve or reject it in the OpenBox dashboard and the agent resumes.

## Security

- **Keys.** API keys and private keys are read once into the process-wide client. They are never journaled, logged or forwarded to child agents.
- **What is journaled.** Only verdict and approval records, plus guardrail-redacted values (already redacted). For an encrypted journal, use Restate's `journalValueCodecProvider`; see [`examples/ts-journal-encryption`](examples/ts-journal-encryption). Callers then need the same codec.
- **Audit.** `openboxAuditHook()` (TypeScript) reports `ctx.run` side effects made outside governed tools. It is audit only and never blocks.
- **Reporting vulnerabilities.** See [`SECURITY.md`](SECURITY.md).

## Troubleshooting

- **A HALT or BLOCK is retried forever (HTTP 500 in Restate).** Two copies of `@restatedev/restate-sdk` are loaded, so `instanceof TerminalError` fails. This happens with `npm link`, or with `file:` links to a folder that has its own `node_modules`. Install the SDK so it shares your app's `@restatedev/restate-sdk` (it is a peer dependency).

## Rollout rule

Adding governance changes the journal shape of a handler. Deploy it as a **new deployment revision** and let the old one drain. Governed services set `onJournalMismatchErrors: "pause"` (architecture §10 I7).
