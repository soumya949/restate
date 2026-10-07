# Governed OpenAI Agents SDK agent (Python)

Restate's [`openai-agents`](https://github.com/restatedev/ai-examples) template with OpenBox governance. The OpenBox changes are marked `# OPENBOX`:

1. the handler is decorated with `@openbox_handler`;
2. the agent passed to `DurableRunner.run` goes through `govern_agent(...)`;
3. `enable_openbox_spans()` (in `__main__.py`) reports each tool's HTTP calls as spans.

## How the Agents SDK behaves under governance

- **BLOCK.** The tool output is `"Blocked by policy: …"`.
- **HALT.** It is raised as an exception that is both an `AgentsException` and a Restate `TerminalError`. Without that, the Agents SDK would wrap it into a `UserError` that Restate retries forever.
- **Hosted tools.** `WebSearchTool` and `HostedMCPTool` run at OpenAI and cannot be checked before they execute.

## Run

Docker runs the Restate server, the agent and a one-shot registration. From the repo root:

```bash
docker compose -f examples/py-openai-agents/docker-compose.yml up
curl localhost:8080/agent/run --json '{"message": "What is the weather in Madrid?"}'
```

**Version note:** Restate's template pins `openai-agents==0.6.5`, which breaks with current `openai` (`InputTokensDetails` validation error). This example uses `openai-agents>=0.23.1`, the version the SDK is tested on.
