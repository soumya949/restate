# Encrypted journal for a governed agent (TypeScript)

Restate journals every `ctx.run` result, along with the handler's input and output. With OpenBox that includes the journaled verdict records and any guardrail-redacted values. A **journal value codec** encrypts all of it in your process, so the Restate server or Restate Cloud stores only ciphertext. The OpenBox SDK needs no change.

- [`src/codec.ts`](src/codec.ts): an AES-256-GCM `JournalValueCodec`.
- [`src/app.ts`](src/app.ts): `restate.serve({ ..., journalValueCodecProvider })`.
- [`src/call.ts`](src/call.ts): a caller using the same codec. Callers need the key too, because input and output are encrypted.
- [`src/check-codec.ts`](src/check-codec.ts): a self-check run by CI. It covers the round trip, no plaintext in the ciphertext, tampering, and a wrong key.

## Run

```bash
export RESTATE_JOURNAL_KEY=$(openssl rand -base64 32)
npm install && npm start                      # :9084
restate deployments register http://host.docker.internal:9084
npm run call -- Lisbon                        # plain curl is rejected: "Failed to decode input using journal value codec"
```

To check what was stored, ask the Restate admin API for the journal of the last invocation (`SELECT ... FROM sys_journal`). Every entry, including `openbox:pre:*` / `openbox:post:*`, is ciphertext.

**Production:** keep the key in a KMS and use envelope encryption, for example `@restatedev/journal-encryption-lib` with AWS KMS. Rotate the key by adding a new codec version byte.
