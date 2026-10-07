# Governed Vercel AI SDK agent (TypeScript)

Restate's [`vercel-ai`](https://github.com/restatedev/ai-examples) template with OpenBox governance. The OpenBox changes are marked `// OPENBOX` in [`src/app.ts`](src/app.ts):

1. the handler is wrapped in `openboxHandler`;
2. the tools passed to `generateText` go through `governTools(ctx, { ... })`;
3. `enableOpenBoxSpans()` reports each tool's HTTP calls as spans.

## How the AI SDK behaves under governance

- **Order.** The AI SDK starts a step's tool calls concurrently. `governTools` runs their checks one at a time, in tool-call order.
- **BLOCK.** The tool result is a `BlockedResult` (`{ blocked: true, reason }`), so the model can explain or try something else.
- **HALT.** The AI SDK turns tool errors into tool results. The invocation still ends with the policy's reason, and is reported to OpenBox as failed.

## Run

The steps are the same as [`ts-restate-only`](../ts-restate-only/README.md), except that the service listens on **9081** and is called `vercelAgent`:

```bash
npm install && npm start
restate deployments register http://host.docker.internal:9081
curl localhost:8080/vercelAgent/run --json '{"prompt": "What is the weather in Berlin?"}'
```

The tools and policies are the same four as in `ts-restate-only`. Versions follow the template (`ai` ^7, `@ai-sdk/openai` ^4, `@restatedev/vercel-ai-middleware` ^0.4).
