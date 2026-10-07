/** Self-check for the codec (run by CI): round-trips a journaled verdict record and rejects tampering. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { aesGcmCodec } from "./codec.js";

const codec = aesGcmCodec(randomBytes(32));
const record = new TextEncoder().encode(JSON.stringify({ v: 1, verdict: "allow", reason: null, policyId: "p1" }));

const sealed = codec.encode(record);
assert.ok(!Buffer.from(sealed).includes(Buffer.from("allow")), "ciphertext must not contain the plaintext");
assert.deepEqual(Buffer.from(await codec.decode(sealed)), Buffer.from(record));
assert.deepEqual(await codec.decode(new Uint8Array()), new Uint8Array());

const tampered = Buffer.from(sealed);
tampered[tampered.length - 1]! ^= 1;
await assert.rejects(codec.decode(tampered), /auth|Unsupported state/i);

await assert.rejects(aesGcmCodec(randomBytes(32)).decode(sealed), "a different key must not decrypt");
console.log("journal codec OK");
