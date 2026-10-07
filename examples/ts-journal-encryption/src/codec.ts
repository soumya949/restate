/**
 * AES-256-GCM journal value codec (architecture §15).
 *
 * Restate stores every `ctx.run` result, awakeable/signal value and state value
 * in its journal. With OpenBox governance that includes the journaled verdict
 * records, and, when output guardrails redact a tool result, the redacted value.
 * A journal value codec encrypts all of them before they leave the service, so
 * the Restate server (or Restate Cloud) only ever stores ciphertext. The SDK
 * needs no change: it is configured on the endpoint.
 *
 * <start_here>
 * Production: keep the key in a KMS and use envelope encryption, e.g.
 * `@restatedev/journal-encryption-lib` with AWS KMS. This file shows the
 * mechanics with a key from the environment.
 * <end_here>
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { JournalValueCodec } from "@restatedev/restate-sdk";

const VERSION = 1; // first byte: lets you rotate the scheme later
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** `key` must be 32 bytes (AES-256). */
export function aesGcmCodec(key: Uint8Array): JournalValueCodec {
  if (key.length !== 32) throw new Error("journal key must be 32 bytes (AES-256)");
  return {
    encode(buf: Uint8Array): Uint8Array {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(buf), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
    },
    async decode(buf: Uint8Array): Promise<Uint8Array> {
      if (buf.length === 0) return buf; // empty values are stored unencoded by Restate
      const data = Buffer.from(buf);
      if (data[0] !== VERSION) throw new Error(`unknown journal codec version ${data[0]}`);
      const iv = data.subarray(1, 1 + IV_BYTES);
      const tag = data.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]);
    }
  };
}

/** Read the key from `RESTATE_JOURNAL_KEY` (base64, 32 bytes). */
export function keyFromEnv(): Uint8Array {
  const b64 = process.env["RESTATE_JOURNAL_KEY"];
  if (!b64) throw new Error("set RESTATE_JOURNAL_KEY (generate one: openssl rand -base64 32)");
  return Buffer.from(b64, "base64");
}
