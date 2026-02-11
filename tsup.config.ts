import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/config/index.ts",
    "src/plugin/workers-plugin.ts",
    "src/runtime/setup.ts",
    "src/cloudflare-test/index.ts"
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  outDir: "dist"
});
