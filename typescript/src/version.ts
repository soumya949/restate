/**
 * Static package version. Kept in sync with package.json by `test/unit/version.test.ts`.
 * Never read from package metadata at runtime (import-light rule, architecture §19).
 */
export const SDK_VERSION = "0.1.0";
export const SDK_ENGINE = "restate";
export const SDK_LANGUAGE = "typescript";
