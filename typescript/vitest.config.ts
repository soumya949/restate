import { defineConfig } from "vitest/config";

// Live tests hit the real OpenBox from .env: only when explicitly asked for (`npm run test:live`).
const live = process.argv.some((a) => a.replaceAll("\\", "/").includes("test/live"));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: live ? [] : ["test/live/**"],
    // Restate integration tests share one Restate container per file and are slow to boot.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    // Floors from the LangChain TS adapter (architecture §19); enforced by `npm run test:coverage` / ci:check.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "lcov"],
      thresholds: { branches: 70, functions: 90, lines: 75, statements: 75 }
    }
  }
});
