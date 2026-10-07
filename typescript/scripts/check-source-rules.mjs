#!/usr/bin/env node
/**
 * Static guards (architecture §18.4, §10):
 *  - I3/I4 determinism: no randomUUID / Date.now / new Date( / Math.random in src/
 *    (ctx.date.now(), ctx.rand and journaled values only).
 *  - P2 never bypass the base client: no raw "/api/v" paths, no X-OpenBox-* signing
 *    header literals (CopilotKit's check-no-duplicate-signing rule).
 *  - I1 Core I/O only in steps.ts (and API-key validation in runtime.ts). instrumentation.ts is
 *    allowed: span I/O only ever runs inside the tool's own ctx.run closure.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url);
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));

const rules = [
  { re: /\brandomUUID\s*\(|\bMath\.random\s*\(/, msg: "non-deterministic id source (use ids.ts / ctx.rand)" },
  { re: /\bDate\.now\s*\(|\bnew Date\s*\(/, msg: "wall clock in control flow (use ctx.date.now())" },
  { re: /["'`]\/api\/v\d/, msg: "raw OpenBox API path (use the base OpenBoxClient)" },
  { re: /x-openbox-(agent-(did|timestamp|nonce|signature|assertion)|sdk-version|body-sha256|workload-token)/i, msg: "signing header literal (base SDK owns signing)" },
  {
    re: /\.(evaluate|pollApproval|sendHandoff)\s*\(/,
    msg: "OpenBox Core I/O outside steps.ts",
    allow: ["steps.ts", "instrumentation.ts"]
  }
];

const violations = [];
for (const f of files) {
  const lines = readFileSync(join(SRC.pathname.replace(/^\/([A-Za-z]:)/, "$1"), f), "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
    for (const r of rules) {
      if (r.allow?.includes(f)) continue;
      if (r.re.test(code)) violations.push(`src/${f}:${i + 1}: ${r.msg}\n    ${line.trim()}`);
    }
  });
}

if (violations.length) {
  console.error(`check-source-rules: ${violations.length} violation(s)\n` + violations.join("\n"));
  process.exit(1);
}
console.log(`check-source-rules: ${files.length} files OK`);
