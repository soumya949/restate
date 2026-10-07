/**
 * A governed agent whose journal is encrypted end to end (architecture §15).
 * The only difference from an unencrypted service is `journalValueCodecProvider`.
 *
 *   RESTATE_JOURNAL_KEY=$(openssl rand -base64 32) npm start
 */
import { existsSync } from "node:fs";

import * as restate from "@restatedev/restate-sdk";

import { aesGcmCodec, keyFromEnv } from "./codec.js";
import { agent } from "./service.js";

const envFile = new URL("../../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

// <start_here>
restate.serve({
  services: [agent],
  port: Number(process.env["PORT"] ?? 9084),
  // Every journaled value (tool results, OpenBox verdict records, state) is encrypted before it leaves this process.
  journalValueCodecProvider: async () => aesGcmCodec(keyFromEnv())
});
// <end_here>
