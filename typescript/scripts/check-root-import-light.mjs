#!/usr/bin/env node
/**
 * Import-light guard (architecture §3.2, §19). Run after `npm run build`.
 *  1. Static: no file in dist/ (except the opt-in ./instrumentation subpath) imports an LLM framework, OpenTelemetry, a DB
 *     driver, or a heavy base-SDK subpath (instrumentation, runtime).
 *  2. Dynamic: importing the root in a clean process patches nothing global.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const FORBIDDEN = [
  /^ai$/,
  /^@ai-sdk\//,
  /^@restatedev\/vercel-ai-middleware/,
  /^@opentelemetry\//,
  /^(pg|redis|mysql2|mongodb)$/,
  /^@openbox-ai\/openbox-sdk-ts\/(instrumentation|runtime|adapters)$/,
  /^\.\/instrumentation\.js$/ // nothing else may pull in the opt-in subpath
];

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : [];
  });
}

// The ./instrumentation subpath is opt-in and patches globals by design; the root never imports it.
const OPT_IN = new Set([join(DIST, "instrumentation.js")]);
const bad = [];
for (const file of walk(DIST)) {
  if (OPT_IN.has(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/(?:import|export)[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = m[1] ?? m[2];
    if (FORBIDDEN.some((re) => re.test(spec))) bad.push(`${file}: imports "${spec}"`);
  }
}
if (bad.length) {
  console.error("check-root-import-light: forbidden imports\n" + bad.join("\n"));
  process.exit(1);
}

const fetchBefore = globalThis.fetch;
await import(pathToFileURL(join(DIST, "index.js")).href);
if (globalThis.fetch !== fetchBefore) {
  console.error("check-root-import-light: importing the root patched globalThis.fetch");
  process.exit(1);
}
console.log("check-root-import-light: OK");
