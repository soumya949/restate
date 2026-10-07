# Security Policy

## Supported versions

Only the latest published release of `@openbox-ai/openbox-restate-sdk` (npm) and `openbox-restate-sdk` (PyPI) receives security fixes.

## Reporting a vulnerability

Report suspected vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/soumya949/restate/security/advisories/new) (Security tab → "Report a vulnerability"). Do not open a public issue.

Please include:
- a description of the issue and its impact;
- steps to reproduce, or a minimal proof of concept;
- the SDK version and language (TypeScript or Python).

We aim to acknowledge reports within 5 business days.

## Secrets and data

- `OPENBOX_API_KEY` and `OPENBOX_AGENT_PRIVATE_KEY` are read once into the process-wide client. They are never journaled, logged, or sent anywhere except signed requests to the configured `OPENBOX_API_URL`, and never forwarded to child agents.
- Only verdict and approval records (and already-redacted guardrail values) are written to the Restate journal. Use Restate's journal value codec to encrypt the journal; see `examples/ts-journal-encryption`.
