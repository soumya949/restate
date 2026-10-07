# Governed Restate agent (Python, no framework)

Restate's [`python-restate-only`](https://github.com/restatedev/ai-examples) template with OpenBox governance. The OpenBox changes are marked `# OPENBOX`:

1. the handler is decorated with `@openbox_handler`;
2. each tool call goes through `governed_call`;
3. `enable_openbox_spans()` (in `__main__.py`) reports each tool's HTTP calls as spans.

## Run

`restate-sdk` ships no Windows wheel, so this runs in Docker: the Restate server, the agent, and a one-shot registration.

1. **Environment.** Fill `../../.env` (`OPENBOX_*`, `OPENAI_API_KEY`).
2. **Restate server, service (9080) and registration in one go**, from the repo root:
   ```bash
   docker compose -f examples/py-restate-only/docker-compose.yml up
   ```
   Set `RESTATE_INGRESS_PORT` / `RESTATE_ADMIN_PORT` to run it next to another Restate on 8080 / 9070.
3. **Call it.**
   ```bash
   curl localhost:8080/agent/run --json '{"message": "What is the weather in Tokyo?"}'
   ```

On Linux and macOS you can also run it directly: `uv sync && uv run python __main__.py`, then register `localhost:9080`. The tools and policies are the same four as in [`ts-restate-only`](../ts-restate-only/README.md).
