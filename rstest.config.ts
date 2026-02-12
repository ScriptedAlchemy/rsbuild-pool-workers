import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: [
    "test/**/*.test.ts",
    "test/**/*.test.tsx",
    "test/**/*.test.mts",
    "test/**/*.test.cts",
    "test/**/*.test.js",
    "test/**/*.test.jsx",
    "test/**/*.test.mjs",
    "test/**/*.test.cjs"
  ],
  testEnvironment: "node",
  pool: {
    type: "forks",
    maxWorkers: 2
  }
});
