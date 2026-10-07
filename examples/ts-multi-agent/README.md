# Two governed agents in one Multi-Agent Session (TypeScript)

A **lead** agent delegates to a **research** agent over Restate RPC. Each is a separate process with its own OpenBox identity.

- [`src/lead.ts`](src/lead.ts) uses the main identity (`OPENBOX_*`). Its `ask_research_agent` tool calls `governedSubAgent(...)`. The delegation is itself a governed activity, `call:research` with `tool_type: a2a`.
- [`src/research.ts`](src/research.ts) uses the child identity (`CHILD_OPENBOX_*`). It is a normal `openboxHandler`. The `x-openbox-*` headers make it join the lead's session, and it sends the **Handoff** event with its own signed client.

In the dashboard, both agents appear in **one Multi-Agent Sessions timeline**.

## Run

1. **Environment.** Add a second sandbox agent to `../../.env`: `CHILD_OPENBOX_API_KEY`, `CHILD_OPENBOX_AGENT_DID` and `CHILD_OPENBOX_AGENT_PRIVATE_KEY`.
2. **Restate server.** As in [`ts-restate-only`](../ts-restate-only/README.md).
3. **Both services.**
   ```bash
   npm install
   npm run start:research   # :9083
   npm run start:lead       # :9082, in a second terminal
   ```
4. **Register both.**
   ```bash
   restate deployments register http://host.docker.internal:9083
   restate deployments register http://host.docker.internal:9082
   ```
5. **Call the lead.**
   ```bash
   curl localhost:8080/lead/run --json '{"prompt": "Ask the research agent for the weather in Tokyo, then summarize it."}'
   ```

A BLOCK rule on `call:research` stops the delegation before the research agent is ever invoked.
