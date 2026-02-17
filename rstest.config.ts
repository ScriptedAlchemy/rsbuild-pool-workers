import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: [
    "test/**/*.test.cjs",
    "test/**/*.test.cts",
    "test/**/*.test.js",
    "test/**/*.test.jsx",
    "test/**/*.test.mjs",
    "test/**/*.test.mts",
    "test/**/*.test.ts",
    "test/**/*.test.tsx"
  ],
  testEnvironment: "node",
  pool: {
    type: "forks",
    maxWorkers: 2
  }
});
