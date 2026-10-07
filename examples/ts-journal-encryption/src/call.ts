/**
 * Callers of an encrypted service must use the same codec: Restate journals the handler's
 * input and output too, so requests are sent encrypted and responses come back encrypted.
 * A plain `curl` gets "Failed to decode input using journal value codec".
 *
 *   RESTATE_JOURNAL_KEY=<same key as the service> npm run call -- Lisbon
 */
import * as clients from "@restatedev/restate-sdk-clients";

import { aesGcmCodec, keyFromEnv } from "./codec.js";
import type { EncryptedAgent } from "./service.js";

// <start_here>
const ingress = clients.connect({
  url: process.env["RESTATE_INGRESS_URL"] ?? "http://localhost:8080",
  journalValueCodec: aesGcmCodec(keyFromEnv())
});
// <end_here>

const Agent: EncryptedAgent = { name: "encryptedAgent" } as EncryptedAgent;

const out = await ingress.serviceClient(Agent).run({ city: process.argv[2] ?? "Lisbon" });
console.log(JSON.stringify(out));
