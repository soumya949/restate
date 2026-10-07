import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/**/*.ts"],
  format: ["esm"],
  target: "node24",
  dts: true,
  sourcemap: true,
  clean: true,
  bundle: false,
  splitting: false
});
