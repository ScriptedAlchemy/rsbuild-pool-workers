import path from "node:path";
import { describe, expect, test } from "@rstest/core";
import { defineWorkersConfig } from "../src/config/index";
import type { WorkerPoolOptionsContext } from "../src/config/index";

describe("defineWorkersConfig", () => {
  test("flattens vitest-like `test` config and injects workers wiring", async () => {
    const value = defineWorkersConfig({
      test: {
        globals: true,
        setupFiles: ["./custom-setup.ts"],
        poolOptions: {
          workers: {
            main: "./src/worker.ts",
            isolatedStorage: false
          }
        }
      }
    });

    const resolved = value instanceof Promise ? await value : value;

    expect(resolved.globals).toBe(true);
    const setupFiles = Array.isArray(resolved.setupFiles)
      ? resolved.setupFiles
      : resolved.setupFiles
        ? [resolved.setupFiles]
        : [];
    expect(setupFiles).toContain("./custom-setup.ts");
    expect(
      setupFiles.some((entry: string) => entry.endsWith(path.join("runtime", "setup.js")))
    ).toBe(true);
    expect(resolved.plugins?.length).toBe(1);

    const defineValue =
      resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("worker.ts");
    expect(String(defineValue)).toContain("isolatedStorage");
  });

  test("supports async config functions", async () => {
    const configFactory = defineWorkersConfig(async () => ({
      workers: {
        main: "./src/index.ts"
      },
      include: ["test/**/*.test.ts"]
    }));

    expect(typeof configFactory).toBe("function");
    const resolved = await configFactory();
    expect(resolved.include).toEqual(["test/**/*.test.ts"]);
    expect(resolved.source?.define).toBeDefined();
  });

  test("supports sync function-valued workers options with inject()", () => {
    process.env.RSTEST_INJECT_API_PORT = "8787";

    const value = defineWorkersConfig({
      test: {
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/index.ts",
            miniflare: {
              bindings: {
                API_PORT: inject<number>("API_PORT")
              }
            }
          })
        }
      }
    });

    if (value instanceof Promise || typeof value === "function") {
      throw new Error("Expected sync config export");
    }

    const defineValue = value.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("8787");

    delete process.env.RSTEST_INJECT_API_PORT;
  });

  test("supports async workers option function in async config export", async () => {
    process.env.RSTEST_INJECT_SERVICE_URL = "\"http://localhost:9000\"";

    const value = defineWorkersConfig(async () => ({
      test: {
        poolOptions: {
          workers: async ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/index.ts",
            miniflare: {
              bindings: {
                SERVICE_URL: inject<string>("SERVICE_URL")
              }
            }
          })
        }
      }
    }));

    if (typeof value !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await value();
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("http://localhost:9000");

    delete process.env.RSTEST_INJECT_SERVICE_URL;
  });
});
