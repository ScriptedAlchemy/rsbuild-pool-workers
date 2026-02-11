import path from "node:path";
import { describe, expect, test } from "@rstest/core";
import { defineWorkersConfig } from "../src/config/index";
import type { WorkerPoolOptionsContext } from "../src/config/index";
import { WORKERS_RSBUILD_PLUGIN_NAME } from "../src/plugin/workers-plugin";

describe("defineWorkersConfig", () => {
  test("flattens vitest-like `test` config and injects workers wiring", async () => {
    const value = defineWorkersConfig({
      test: {
        globals: true,
        setupFiles: ["./custom-setup.ts"],
        poolOptions: {
          workers: {
            main: "./src/worker.ts",
                isolatedStorage: false,
                remoteBindings: false,
                additionalExports: {
                  DurableThing: "DurableObject"
                }
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
      setupFiles.some(
        (entry: string) =>
          entry.endsWith(path.join("runtime", "setup.js")) ||
          entry.endsWith(path.join("runtime", "setup.ts"))
      )
    ).toBe(true);
    expect(resolved.plugins?.length).toBe(1);

    const defineValue =
      resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("worker.ts");
    expect(String(defineValue)).toContain("isolatedStorage");
    expect(String(defineValue)).toContain("remoteBindings");
    expect(String(defineValue)).toContain("DurableThing");
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

  test("preserves sync config function return shape", () => {
    const configFactory = defineWorkersConfig(() => ({
      workers: {
        main: "./src/index.ts"
      },
      include: ["test/**/*.test.ts"]
    }));

    expect(typeof configFactory).toBe("function");
    const resolved = configFactory();
    expect(resolved).not.toBeInstanceOf(Promise);

    if (resolved instanceof Promise) {
      throw new Error("Expected sync config result");
    }

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

  test("throws when async workers options are used in sync config export", () => {
    expect(() =>
      defineWorkersConfig({
        test: {
          poolOptions: {
            workers: async ({ inject }: WorkerPoolOptionsContext) => ({
              main: "./src/index.ts",
              miniflare: {
                bindings: {
                  VALUE: inject<string>("VALUE")
                }
              }
            })
          }
        }
      })
    ).toThrow(
      "Async function-valued workers options require an async config export. " +
      "Wrap your `defineWorkersConfig(...)` call in an async config function."
    );
  });

  test("does not inject duplicate workers plugin when already present", () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const value = defineWorkersConfig({
      plugins: [existingPlugin],
      workers: {
        main: "./src/index.ts"
      }
    });

    if (value instanceof Promise || typeof value === "function") {
      throw new Error("Expected sync config export");
    }

    const plugins = Array.isArray(value.plugins)
      ? value.plugins
      : value.plugins
        ? [value.plugins]
        : [];

    expect(plugins.length).toBe(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });
});
