# Governed Restate agent (TypeScript, no framework)

Restate's [`typescript-restate-only`](https://github.com/restatedev/ai-examples) template with OpenBox governance. The OpenBox changes are marked `// OPENBOX` in [`src/agent.ts`](src/agent.ts):

1. the handler is wrapped in `openboxHandler`;
2. each tool call goes through `governedCall` (policy check, then a durable approval wait if needed, then the tool, then a report);
3. `enableOpenBoxSpans()` reports each tool's HTTP calls as spans.

A blocked call is fed back to the LLM as the tool result instead of failing the agent.

## Run

1. **Environment.** Fill `../../.env` from [`.env.example`](../../.env.example): the `OPENBOX_*` values for a sandbox agent, plus `OPENAI_API_KEY`.
2. **Restate server.**
   ```bash
   docker run --rm -p 8080:8080 -p 9070:9070 --add-host=host.docker.internal:host-gateway docker.io/restatedev/restate:latest
   ```
3. **The service (port 9080).** Pack the SDK once with `cd ../../typescript && npm run pack:examples`, then:
   ```bash
   npm install && npm start
   ```
4. **Register it.**
   ```bash
   restate deployments register http://host.docker.internal:9080
   ```
   Or: `curl localhost:9070/deployments --json '{"uri":"http://host.docker.internal:9080"}'`.
5. **Call it.**
   ```bash
   curl localhost:8080/agent/run --json '{"message": "What is the weather in Paris?"}'
   ```

## Policies to try

Create one rule per tool on the sandbox agent. Each rule matches `activity_type is <tool>` and `event_type is ActivityStarted`.

| Tool | Decision | What you see |
|---|---|---|
| `get_weather` | ALLOW | The answer, plus 4 HTTP spans (2 Open-Meteo calls, each with a started and a completed span) |
| `delete_records` | BLOCK | The model is told "Blocked by policy: …" |
| `wire_money` | HALT | The invocation ends with HTTP 403 |
| `send_email` | REQUIRE APPROVAL | The invocation waits, using no compute, until you approve or reject it in the dashboard |

Versions follow the template (`ai` ^6, `@ai-sdk/openai` ^3). `@restatedev/restate-sdk` is ^1.17.2, the SDK's floor.
