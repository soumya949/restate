# Governed Google ADK agent (Python)

Restate's [`google-adk`](https://github.com/restatedev/ai-examples) template with OpenBox governance. The OpenBox changes are marked `# OPENBOX` in [`agent.py`](agent.py): one class swap, plus `@openbox_handler`.

What you get:
- every tool call is checked by OpenBox before it runs and reported after it runs;
- each model call is an `llm_call` activity with model and tokens;
- the HTTP calls of tools and of the model are spans.

## Run

Docker runs the Restate server, the agent and a one-shot registration. `restate-sdk` ships no Windows wheel. From the repo root:

```bash
docker compose -f examples/py-google-adk/docker-compose.yml up
curl localhost:8080/agent/run --json '{"message": "What is the weather in Madrid?"}'
```

The tools and policies are the same four as in [`ts-restate-only`](../ts-restate-only/README.md).
