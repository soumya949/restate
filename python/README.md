# openbox-restate-sdk (Python)

[OpenBox](https://openbox.ai) governance for durable AI agents on [Restate](https://restate.dev).

Every side-effecting step of your agent is checked against OpenBox policy **before** it runs and reported **after** it runs. The checks are journaled by Restate, so a replay never asks OpenBox the same question twice. When a policy needs a human, the invocation **suspends durably** until a reviewer decides in the OpenBox dashboard.

```bash
pip install openbox-restate-sdk                 # core
pip install "openbox-restate-sdk[openai]"       # + OpenAI Agents SDK integration
pip install "openbox-restate-sdk[spans]"        # + HTTP span capture
pip install "openbox-restate-sdk[adk]"          # + Google ADK          (also [pydantic-ai], [langchain])
```

Requires Python ≥ 3.11 and `restate-sdk` ≥ 1.0.5.

## Quickstart (no framework)

```python
import restate
from openbox_restate import openbox_handler, governed_call, is_blocked

agent = restate.Service("agent")

@agent.handler()
@openbox_handler(agent_name="my-agent", prompt_from=lambda p: p.message)
async def run(ctx: restate.Context, prompt: Prompt) -> str:
    ...  # your LLM loop; for each tool call:
    result = await governed_call(ctx, tool_name=name, tool_call_id=call_id, arguments=args, run=run_tool)
    content = str(result) if is_blocked(result) else result
```

## OpenAI Agents SDK

```python
from restate.ext.openai import DurableRunner
from openbox_restate.openai import govern_agent

@agent_service.handler()
@openbox_handler(agent_name="my-agent", prompt_from=lambda r: r.message)
async def run(_ctx: restate.Context, req: Prompt) -> str:
    result = await DurableRunner.run(govern_agent(assistant), req.message)
    return result.final_output
```

- `govern_agent` governs every `FunctionTool` of the agent and of its handoff agents.
- `@governed_function_tool` builds a single governed tool.
- BLOCK goes back to the model as `"Blocked by policy: …"`.
- HALT ends the invocation and is never retried.

## API

| Import | What |
|---|---|
| `openbox_handler(...)` | Decorator for a Restate handler (Services, Virtual Objects, Workflows) |
| `governed_run` / `governed_call` | Govern one side-effecting step |
| `governed_parallel` (`openbox_restate.governed_run`) | Pre-checks in call order, tools concurrently, post-checks in call order |
| `governed_sub_agent`, `child_headers` (`openbox_restate.multi_agent`) | Call another governed agent in the same Multi-Agent Session |
| `govern_agent`, `govern_tool`, `governed_function_tool` (`openbox_restate.openai`) | OpenAI Agents SDK |
| `OpenBoxRestatePlugin` (`openbox_restate.adk`) | Google ADK: drop-in for Restate's `RestatePlugin` |
| `OpenBoxRestateAgent` (`openbox_restate.pydantic_ai`) | Pydantic AI: drop-in for Restate's `RestateAgent` |
| `OpenBoxRestateMiddleware` (`openbox_restate.langchain`) | LangChain `create_agent`: drop-in for Restate's `RestateMiddleware` |
| `governed_llm_call` / `report_llm_call` (`openbox_restate.llm`) | Govern a model call as an `llm_call` activity (model, tokens): input guardrails redact the prompt, HALT / BLOCK / approval are enforced, and `call` receives the approved prompt. The framework integrations do it for you. `report_llm_call` is telemetry only |
| `enable_openbox_spans()` (`openbox_restate.instrumentation`) | Report each tool's httpx, requests, urllib3, urllib, DB and file calls as spans |

Configuration and verdict behaviour are the same as the TypeScript package; see its README. The environment variables are `OPENBOX_API_URL`, `OPENBOX_API_KEY`, `OPENBOX_AGENT_DID`, `OPENBOX_AGENT_PRIVATE_KEY` and the `OPENBOX_RESTATE_*` overrides.

**Windows:** `restate-sdk` ships no Windows wheel. Run your service (and this SDK's tests: `docker compose -f docker-compose.test.yml run --rm tests`) in Docker or WSL.
