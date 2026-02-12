import path from "node:path";
import { describe, expect, test } from "@rstest/core";
import { defineWorkersConfig, defineWorkersProject } from "../src/config/index";
import type {
  WorkerPoolOptionsContext,
  WorkersPoolOptions,
  WorkersUserConfig
} from "../src/config/index";
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

  test("prefers top-level workers over test.poolOptions.workers when both are set", () => {
    const value = defineWorkersConfig({
      workers: {
        main: "./src/top-level-worker.ts",
        miniflare: {
          bindings: {
            SELECTED_WORKER: "top-level"
          }
        }
      },
      test: {
        poolOptions: {
          workers: {
            main: "./src/nested-worker.ts",
            miniflare: {
              bindings: {
                SELECTED_WORKER: "nested"
              }
            }
          }
        }
      }
    });

    if (value instanceof Promise || typeof value === "function") {
      throw new Error("Expected sync config export");
    }

    const defineValue = value.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("top-level-worker.ts");
    expect(String(defineValue)).toContain("top-level");
    expect(String(defineValue)).not.toContain("nested-worker.ts");
  });

  test("does not evaluate nested workers function when top-level workers function exists", () => {
    const value = defineWorkersConfig({
      workers: ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/top-level-function-worker.ts",
        miniflare: {
          bindings: {
            TOP_LEVEL_FUNCTION_VALUE: inject<string>("TOP_LEVEL_FUNCTION_VALUE") ?? "top-level-fn"
          }
        }
      }),
      test: {
        poolOptions: {
          workers: () => {
            throw new Error("nested workers function should not execute");
          }
        }
      }
    });

    if (value instanceof Promise || typeof value === "function") {
      throw new Error("Expected sync config export");
    }

    const defineValue = value.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("top-level-function-worker.ts");
    expect(String(defineValue)).toContain("top-level-fn");
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

  test("forwards async config function arguments", async () => {
    const configFactory = defineWorkersConfig(async (...args: unknown[]) => {
      const context = args[0] as { mode?: string } | undefined;
      return {
      workers: {
        main: "./src/index.ts",
        miniflare: {
          bindings: {
            MODE: context?.mode ?? "unknown"
          }
        }
      }
      };
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function");
    }

    const resolved = await configFactory({ mode: "test" });
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("test");
  });

  test("propagates rejection for async config function exports", async () => {
    const errorMessage = "async config function rejection";
    const configFactory = defineWorkersConfig(async () => {
      throw new Error(errorMessage);
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function");
    }

    await expect(configFactory()).rejects.toThrow(errorMessage);
  });

  test("propagates rejection for async config function exports with invalid nested workers options", async () => {
    const configFactory = defineWorkersConfig(async () => ({
      test: {
        poolOptions: {
          workers: [] as unknown as WorkersPoolOptions
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers: expected an object but received array."
    );
  });

  test("propagates rejection for async config function exports when nested workers function returns invalid options", async () => {
    const configFactory = defineWorkersConfig(async () => ({
      test: {
        poolOptions: {
          workers: () => [] as unknown as WorkersPoolOptions
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
    );
  });

  test("propagates rejection for async config function exports when nested workers function returns string", async () => {
    const configFactory = defineWorkersConfig(async () => ({
      test: {
        poolOptions: {
          workers: () => "invalid-workers-options" as unknown as WorkersPoolOptions
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
    );
  });

  test("propagates rejection for async config function exports when nested workers function returns boolean", async () => {
    const configFactory = defineWorkersConfig(async () => ({
      test: {
        poolOptions: {
          workers: () => false as unknown as WorkersPoolOptions
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
    );
  });

  test("propagates rejection for async config function exports when top-level workers function returns invalid options", async () => {
    const configFactory = defineWorkersConfig(async () => ({
      workers: () => null as unknown as WorkersPoolOptions
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received null."
    );
  });

  test("propagates rejection for async config function exports when top-level workers function returns undefined", async () => {
    const configFactory = defineWorkersConfig(async () => ({
      workers: () => undefined as unknown as WorkersPoolOptions
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received undefined."
    );
  });

  test("propagates rejection for async config function exports when top-level workers function returns boolean", async () => {
    const configFactory = defineWorkersConfig(async () => ({
      workers: () => false as unknown as WorkersPoolOptions
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received boolean."
    );
  });

  test("forwards config function arguments when function returns a promise", async () => {
    const configFactory = defineWorkersConfig((...args: unknown[]) => {
      const context = args[0] as { mode?: string } | undefined;
      return Promise.resolve({
        workers: {
          main: "./src/index.ts",
          miniflare: {
            bindings: {
              MODE: context?.mode ?? "unknown"
            }
          }
        }
      });
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    const resolved = await configFactory({ mode: "serve" });
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("serve");
  });

  test("propagates thrown errors for sync config function exports", async () => {
    const errorMessage = "sync config function throw";
    const configFactory = defineWorkersConfig(() => {
      throw new Error(errorMessage);
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    expect(() => configFactory()).toThrow(errorMessage);
  });

  test("throws actionable error for sync config function exports with invalid top-level workers options", () => {
    const configFactory = defineWorkersConfig(() => ({
      workers: "invalid-workers-options" as unknown as WorkersPoolOptions
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    expect(() => configFactory()).toThrow(
      "Invalid workers options from workers: expected an object but received string."
    );
  });

  test("throws actionable error for sync config function exports when top-level workers function returns invalid options", () => {
    const configFactory = defineWorkersConfig(() => ({
      workers: () => null as unknown as WorkersPoolOptions
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    expect(() => configFactory()).toThrow(
      "Invalid workers options from workers() return value: expected an object but received null."
    );
  });

  test("throws actionable error for sync config function exports when top-level workers function returns undefined", () => {
    const configFactory = defineWorkersConfig(() => ({
      workers: () => undefined as unknown as WorkersPoolOptions
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    expect(() => configFactory()).toThrow(
      "Invalid workers options from workers() return value: expected an object but received undefined."
    );
  });

  test("throws actionable error for sync config function exports when top-level workers function returns boolean", () => {
    const configFactory = defineWorkersConfig(() => ({
      workers: () => false as unknown as WorkersPoolOptions
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    expect(() => configFactory()).toThrow(
      "Invalid workers options from workers() return value: expected an object but received boolean."
    );
  });

  test("throws actionable error for sync config function exports when nested workers function returns invalid options", () => {
    const configFactory = defineWorkersConfig(() => ({
      test: {
        poolOptions: {
          workers: () => [] as unknown as WorkersPoolOptions
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    expect(() => configFactory()).toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
    );
  });

  test("throws actionable error for sync config function exports when nested workers function returns string", () => {
    const configFactory = defineWorkersConfig(() => ({
      test: {
        poolOptions: {
          workers: () => "invalid-workers-options" as unknown as WorkersPoolOptions
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    expect(() => configFactory()).toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
    );
  });

  test("throws actionable error for sync config function exports when nested workers function returns boolean", () => {
    const configFactory = defineWorkersConfig(() => ({
      test: {
        poolOptions: {
          workers: () => false as unknown as WorkersPoolOptions
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    expect(() => configFactory()).toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
    );
  });

  test("propagates rejection for promise-returning config function exports", async () => {
    const errorMessage = "promise config function rejection";
    const configFactory = defineWorkersConfig(() => Promise.reject(new Error(errorMessage)));

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    await expect(configFactory()).rejects.toThrow(errorMessage);
  });

  test("propagates rejection for promise-returning config function exports with invalid top-level workers options", async () => {
    const configFactory = defineWorkersConfig(() =>
      Promise.resolve({
        workers: null as unknown as WorkersPoolOptions
      })
    );

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers: expected an object but received null."
    );
  });

  test("propagates rejection for promise-returning config function exports when top-level workers function returns invalid options", async () => {
    const configFactory = defineWorkersConfig(() =>
      Promise.resolve({
        workers: () => null as unknown as WorkersPoolOptions
      })
    );

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received null."
    );
  });

  test("propagates rejection for promise-returning config function exports when top-level workers function returns undefined", async () => {
    const configFactory = defineWorkersConfig(() =>
      Promise.resolve({
        workers: () => undefined as unknown as WorkersPoolOptions
      })
    );

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received undefined."
    );
  });

  test("propagates rejection for promise-returning config function exports when top-level workers function returns boolean", async () => {
    const configFactory = defineWorkersConfig(() =>
      Promise.resolve({
        workers: () => false as unknown as WorkersPoolOptions
      })
    );

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received boolean."
    );
  });

  test("propagates rejection for promise-returning config function exports when nested workers function returns invalid options", async () => {
    const configFactory = defineWorkersConfig(() =>
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () => [] as unknown as WorkersPoolOptions
          }
        }
      })
    );

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
    );
  });

  test("propagates rejection for promise-returning config function exports when nested workers function returns string", async () => {
    const configFactory = defineWorkersConfig(() =>
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () => "invalid-workers-options" as unknown as WorkersPoolOptions
          }
        }
      })
    );

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
    );
  });

  test("propagates rejection for promise-returning config function exports when nested workers function returns boolean", async () => {
    const configFactory = defineWorkersConfig(() =>
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () => false as unknown as WorkersPoolOptions
          }
        }
      })
    );

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
    );
  });

  test("supports config functions returning thenables", async () => {
    const configFactory = defineWorkersConfig((...args: unknown[]) => {
      const context = args[0] as { mode?: string } | undefined;
      const value = {
        workers: {
          main: "./src/index.ts",
          miniflare: {
            bindings: {
              MODE: context?.mode ?? "unknown"
            }
          }
        }
      };

      const thenable = {
        then(resolve: (config: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;

      return thenable;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    const resolved = await configFactory({ mode: "thenable" });
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("thenable");
  });

  test("propagates rejection for thenable-returning config function exports", async () => {
    const errorMessage = "thenable config function rejection";
    const configFactory = defineWorkersConfig(() => {
      const value = {
        workers: {
          main: "./src/thenable-config-rejection.ts"
        } satisfies WorkersPoolOptions
      };
      return {
        then(
          onfulfilled?:
            | ((resolved: typeof value) => unknown)
            | null,
          onrejected?: ((reason: unknown) => unknown) | null
        ) {
          return Promise.reject(new Error(errorMessage)).then(
            onfulfilled as ((value: never) => unknown) | undefined,
            onrejected as ((reason: unknown) => unknown) | undefined
          );
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    await expect(configFactory()).rejects.toThrow(errorMessage);
  });

  test("propagates rejection for thenable-returning config function exports with invalid nested workers options", async () => {
    const configFactory = defineWorkersConfig(() => {
      const value = {
        test: {
          poolOptions: {
            workers: [] as unknown as WorkersPoolOptions
          }
        }
      };
      return {
        then(resolve: (resolved: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers: expected an object but received array."
    );
  });

  test("propagates rejection for thenable-returning config function exports when nested workers function returns invalid options", async () => {
    const configFactory = defineWorkersConfig(() => {
      const value = {
        test: {
          poolOptions: {
            workers: () => [] as unknown as WorkersPoolOptions
          }
        }
      };
      return {
        then(resolve: (resolved: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
    );
  });

  test("propagates rejection for thenable-returning config function exports when nested workers function returns string", async () => {
    const configFactory = defineWorkersConfig(() => {
      const value = {
        test: {
          poolOptions: {
            workers: () => "invalid-workers-options" as unknown as WorkersPoolOptions
          }
        }
      };
      return {
        then(resolve: (resolved: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
    );
  });

  test("propagates rejection for thenable-returning config function exports when nested workers function returns boolean", async () => {
    const configFactory = defineWorkersConfig(() => {
      const value = {
        test: {
          poolOptions: {
            workers: () => false as unknown as WorkersPoolOptions
          }
        }
      };
      return {
        then(resolve: (resolved: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
    );
  });

  test("propagates rejection for thenable-returning config function exports when top-level workers function returns invalid options", async () => {
    const configFactory = defineWorkersConfig(() => {
      const value = {
        workers: () => null as unknown as WorkersPoolOptions
      };
      return {
        then(resolve: (resolved: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received null."
    );
  });

  test("propagates rejection for thenable-returning config function exports when top-level workers function returns undefined", async () => {
    const configFactory = defineWorkersConfig(() => {
      const value = {
        workers: () => undefined as unknown as WorkersPoolOptions
      };
      return {
        then(resolve: (resolved: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received undefined."
    );
  });

  test("propagates rejection for thenable-returning config function exports when top-level workers function returns boolean", async () => {
    const configFactory = defineWorkersConfig(() => {
      const value = {
        workers: () => false as unknown as WorkersPoolOptions
      };
      return {
        then(resolve: (resolved: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received boolean."
    );
  });

  test("forwards arguments for thenable-returning config function exports", async () => {
    const configFactory = defineWorkersConfig((...args: unknown[]) => {
      const context = args[0] as { mode?: string } | undefined;
      const value = {
        workers: {
          main: "./src/thenable-forwarding.ts",
          miniflare: {
            bindings: {
              MODE: context?.mode ?? "unknown"
            }
          }
        }
      };

      return {
        then(resolve: (config: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    const resolved = await configFactory({ mode: "thenable-forwarding" });
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("thenable-forwarding");
    expect(String(defineValue)).toContain("thenable-forwarding.ts");
  });

  test("preserves this binding for thenable-returning config function exports", async () => {
    const configFactory = defineWorkersConfig(function (this: { mode?: string }) {
      const value = {
        workers: {
          main: "./src/thenable-this.ts",
          miniflare: {
            bindings: {
              MODE: this.mode ?? "unknown"
            }
          }
        }
      };

      return {
        then(resolve: (config: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    const resolved = await configFactory.call({ mode: "thenable-this" });
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("thenable-this");
    expect(String(defineValue)).toContain("thenable-this.ts");
  });

  test("dedupes workers plugin when config functions return thenables", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const configFactory = defineWorkersConfig(() => {
      const value = {
        plugins: [existingPlugin],
        workers: {
          main: "./src/index.ts"
        }
      };
      return {
        then(resolve: (config: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    const resolved = await configFactory();
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins).toHaveLength(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("dedupes workers plugin for thenable config function exports when plugins is single value", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const configFactory = defineWorkersConfig(() => {
      const value = {
        plugins: existingPlugin as unknown as any,
        workers: {
          main: "./src/thenable-single-plugin.ts"
        }
      };
      return {
        then(resolve: (config: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    const resolved = await configFactory();
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins).toHaveLength(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("keeps falsey plugin entries while deduping thenable config function exports", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const configFactory = defineWorkersConfig(() => {
      const value = {
        plugins: [false as unknown as any, existingPlugin],
        workers: {
          main: "./src/thenable-falsey-plugin.ts"
        }
      };
      return {
        then(resolve: (config: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    const resolved = await configFactory();
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins).toContain(false);
    const names = plugins
      .map((plugin) =>
        typeof plugin === "object" && plugin !== null && "name" in plugin
          ? String((plugin as { name?: unknown }).name)
          : ""
      )
      .filter(Boolean);
    expect(names.filter((name) => name === WORKERS_RSBUILD_PLUGIN_NAME)).toHaveLength(1);
  });

  test("preserves this binding for promise-returning config function exports", async () => {
    const configFactory = defineWorkersConfig(function (this: { mode?: string }) {
      return Promise.resolve({
        workers: {
          main: "./src/index.ts",
          miniflare: {
            bindings: {
              MODE: this.mode ?? "unknown"
            }
          }
        }
      });
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function");
    }

    const resolved = await configFactory.call({ mode: "promise-this" });
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-this");
  });

  test("supports promise config exports and dedupes workers plugin", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        plugins: [existingPlugin],
        workers: {
          main: "./src/index.ts"
        },
        include: ["test/**/*.test.ts"]
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    expect(resolved.include).toEqual(["test/**/*.test.ts"]);

    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins.length).toBe(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("supports promise-like config exports", async () => {
    const promiseLikeValue = {
      include: ["test/promise-like/**/*.test.ts"],
      workers: {
        main: "./src/index.ts"
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    expect(resolved.include).toEqual(["test/promise-like/**/*.test.ts"]);

    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins.length).toBe(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("propagates rejection from promise-like config exports", async () => {
    const errorMessage = "promise-like config export rejection";
    const configPromiseLike = defineWorkersConfig({
      then(
        _onfulfilled?: ((value: WorkersUserConfig) => unknown) | null,
        onrejected?: ((reason: unknown) => unknown) | null
      ) {
        const error = new Error(errorMessage);
        if (typeof onrejected === "function") {
          onrejected(error);
        }
        return Promise.reject(error);
      }
    } as unknown as PromiseLike<WorkersUserConfig>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    await expect(configPromiseLike).rejects.toThrow(errorMessage);
  });

  test("propagates thrown errors from promise-like config exports", async () => {
    const errorMessage = "promise-like config export throw";
    const configPromiseLike = defineWorkersConfig({
      then() {
        throw new Error(errorMessage);
      }
    } as unknown as PromiseLike<WorkersUserConfig>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    await expect(configPromiseLike).rejects.toThrow(errorMessage);
  });

  test("dedupes workers plugin for promise-like config exports", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const promiseLikeValue = {
      plugins: [existingPlugin],
      workers: {
        main: "./src/index.ts"
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins.length).toBe(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("dedupes workers plugin for promise-like config exports when plugins is single value", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const promiseLikeValue = {
      plugins: existingPlugin as unknown as any,
      workers: {
        main: "./src/index.ts"
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins.length).toBe(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("keeps falsey plugin entries while deduping in promise-like config exports", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const promiseLikeValue = {
      plugins: [false as unknown as any, existingPlugin],
      workers: {
        main: "./src/index.ts"
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins).toContain(false);
    const names = plugins
      .map((plugin) =>
        typeof plugin === "object" && plugin !== null && "name" in plugin
          ? String((plugin as { name?: unknown }).name)
          : ""
      )
      .filter(Boolean);
    expect(names.filter((name) => name === WORKERS_RSBUILD_PLUGIN_NAME)).toHaveLength(1);
  });

  test("prefers top-level workers in promise-like exports when nested workers are also set", async () => {
    const promiseLikeValue = {
      workers: {
        main: "./src/promise-like-top-level-precedence.ts",
        miniflare: {
          bindings: {
            PROMISE_LIKE_PRECEDENCE: "promise-like-top-level"
          }
        }
      },
      test: {
        poolOptions: {
          workers: {
            main: "./src/promise-like-nested-precedence.ts",
            miniflare: {
              bindings: {
                PROMISE_LIKE_PRECEDENCE: "promise-like-nested"
              }
            }
          }
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-like-top-level-precedence.ts");
    expect(String(defineValue)).not.toContain("promise-like-nested-precedence.ts");
  });

  test("throws actionable error for promise-like exports with invalid top-level workers options", async () => {
    const promiseLikeValue = {
      workers: "invalid-workers-options" as unknown as WorkersPoolOptions
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    await expect(configPromiseLike).rejects.toThrow(
      "Invalid workers options from workers: expected an object but received string."
    );
  });

  test("throws actionable error for promise-like exports with invalid nested workers options", async () => {
    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: 123 as unknown as WorkersPoolOptions
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    await expect(configPromiseLike).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers: expected an object but received number."
    );
  });

  test("throws actionable error for promise-like exports with invalid top-level null workers options", async () => {
    const promiseLikeValue = {
      workers: null as unknown as WorkersPoolOptions
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    await expect(configPromiseLike).rejects.toThrow(
      "Invalid workers options from workers: expected an object but received null."
    );
  });

  test("throws actionable error for promise-like exports with invalid nested array workers options", async () => {
    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: [] as unknown as WorkersPoolOptions
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    await expect(configPromiseLike).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers: expected an object but received array."
    );
  });

  test("supports promise-like exports with nested workers function", async () => {
    process.env.RSTEST_INJECT_PROMISE_LIKE_NESTED = "\"promise-like-nested\"";

    const promiseLikeValue = {
      test: {
        include: ["test/promise-like-nested/**/*.test.ts"],
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/promise-like-nested.ts",
            miniflare: {
              bindings: {
                PROMISE_LIKE_NESTED: inject<string>("PROMISE_LIKE_NESTED")
              }
            }
          })
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    expect(resolved.include).toEqual(["test/promise-like-nested/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-like-nested");

    delete process.env.RSTEST_INJECT_PROMISE_LIKE_NESTED;
  });

  test("propagates rejection from promise-like nested workers function", async () => {
    const errorMessage = "promise-like nested workers rejection";
    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: () => Promise.reject(new Error(errorMessage))
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    await expect(configPromiseLike).rejects.toThrow(errorMessage);
  });

  test("propagates actionable error from promise-like nested workers function invalid options", async () => {
    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: () => undefined as unknown as WorkersPoolOptions
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    await expect(configPromiseLike).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received undefined."
    );
  });

  test("propagates actionable error from promise-like nested workers function array return", async () => {
    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: () => [] as unknown as WorkersPoolOptions
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    await expect(configPromiseLike).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
    );
  });

  test("propagates thrown errors from promise-like nested workers function", async () => {
    const errorMessage = "promise-like nested workers throw";
    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: () => {
            throw new Error(errorMessage);
          }
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    await expect(configPromiseLike).rejects.toThrow(errorMessage);
  });

  test("propagates rejection from promise-like nested thenable workers function", async () => {
    const errorMessage = "promise-like nested thenable workers rejection";
    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: () =>
            ({
              then(
                _onfulfilled: ((value: WorkersPoolOptions) => unknown) | null,
                onrejected?: ((reason: unknown) => unknown) | null
              ) {
                const error = new Error(errorMessage);
                if (typeof onrejected === "function") {
                  onrejected(error);
                }
                return Promise.reject(error);
              }
            }) as PromiseLike<WorkersPoolOptions>
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    await expect(configPromiseLike).rejects.toThrow(errorMessage);
  });

  test("supports direct env fallback for promise-like nested workers function", async () => {
    process.env.PROMISE_LIKE_NESTED_DIRECT_FALLBACK = "\"promise-like-nested-direct-fallback\"";

    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/promise-like-nested-direct-fallback.ts",
            miniflare: {
              bindings: {
                PROMISE_LIKE_NESTED_DIRECT_FALLBACK: inject<string>(
                  "PROMISE_LIKE_NESTED_DIRECT_FALLBACK"
                )
              }
            }
          })
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-like-nested-direct-fallback");

    delete process.env.PROMISE_LIKE_NESTED_DIRECT_FALLBACK;
  });

  test("prefers scoped env over direct env for promise-like nested workers function", async () => {
    process.env.PROMISE_LIKE_NESTED_PRECEDENCE = "\"direct-value\"";
    process.env.RSTEST_INJECT_PROMISE_LIKE_NESTED_PRECEDENCE = "\"scoped-value\"";

    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/promise-like-nested-precedence-env.ts",
            miniflare: {
              bindings: {
                PROMISE_LIKE_NESTED_PRECEDENCE: inject<string>("PROMISE_LIKE_NESTED_PRECEDENCE")
              }
            }
          })
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("scoped-value");
    expect(String(defineValue)).not.toContain("direct-value");

    delete process.env.RSTEST_INJECT_PROMISE_LIKE_NESTED_PRECEDENCE;
    delete process.env.PROMISE_LIKE_NESTED_PRECEDENCE;
  });

  test("supports promise-like exports with nested async workers function", async () => {
    process.env.RSTEST_INJECT_PROMISE_LIKE_NESTED_ASYNC = "\"promise-like-nested-async\"";

    const promiseLikeValue = {
      test: {
        include: ["test/promise-like-nested-async/**/*.test.ts"],
        poolOptions: {
          workers: async ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/promise-like-nested-async.ts",
            miniflare: {
              bindings: {
                PROMISE_LIKE_NESTED_ASYNC: inject<string>("PROMISE_LIKE_NESTED_ASYNC")
              }
            }
          })
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    expect(resolved.include).toEqual(["test/promise-like-nested-async/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-like-nested-async");

    delete process.env.RSTEST_INJECT_PROMISE_LIKE_NESTED_ASYNC;
  });

  test("supports direct env fallback for promise-like nested async workers function", async () => {
    process.env.PROMISE_LIKE_NESTED_ASYNC_DIRECT_FALLBACK =
      "\"promise-like-nested-async-direct-fallback\"";

    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: async ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/promise-like-nested-async-direct-fallback.ts",
            miniflare: {
              bindings: {
                PROMISE_LIKE_NESTED_ASYNC_DIRECT_FALLBACK: inject<string>(
                  "PROMISE_LIKE_NESTED_ASYNC_DIRECT_FALLBACK"
                )
              }
            }
          })
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-like-nested-async-direct-fallback");

    delete process.env.PROMISE_LIKE_NESTED_ASYNC_DIRECT_FALLBACK;
  });

  test("prefers scoped env over direct env for promise-like nested async workers function", async () => {
    process.env.PROMISE_LIKE_NESTED_ASYNC_SCOPED_PRECEDENCE = "\"nested-async-direct-value\"";
    process.env.RSTEST_INJECT_PROMISE_LIKE_NESTED_ASYNC_SCOPED_PRECEDENCE =
      "\"nested-async-scoped-value\"";

    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: async ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/promise-like-nested-async-scoped-precedence.ts",
            miniflare: {
              bindings: {
                PROMISE_LIKE_NESTED_ASYNC_SCOPED_PRECEDENCE: inject<string>(
                  "PROMISE_LIKE_NESTED_ASYNC_SCOPED_PRECEDENCE"
                )
              }
            }
          })
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("nested-async-scoped-value");
    expect(String(defineValue)).not.toContain("nested-async-direct-value");

    delete process.env.RSTEST_INJECT_PROMISE_LIKE_NESTED_ASYNC_SCOPED_PRECEDENCE;
    delete process.env.PROMISE_LIKE_NESTED_ASYNC_SCOPED_PRECEDENCE;
  });

  test("supports promise-like exports with nested thenable workers function", async () => {
    process.env.RSTEST_INJECT_PROMISE_LIKE_NESTED_THENABLE = "\"promise-like-nested-thenable\"";

    const promiseLikeValue = {
      test: {
        include: ["test/promise-like-nested-thenable/**/*.test.ts"],
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => {
            const workersValue = {
              main: "./src/promise-like-nested-thenable.ts",
              miniflare: {
                bindings: {
                  PROMISE_LIKE_NESTED_THENABLE: inject<string>("PROMISE_LIKE_NESTED_THENABLE")
                }
              }
            };
            return {
              then(resolve: (value: typeof workersValue) => void) {
                resolve(workersValue);
                return Promise.resolve(workersValue);
              }
            } as unknown as PromiseLike<typeof workersValue>;
          }
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    expect(resolved.include).toEqual(["test/promise-like-nested-thenable/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-like-nested-thenable");

    delete process.env.RSTEST_INJECT_PROMISE_LIKE_NESTED_THENABLE;
  });

  test("supports direct env fallback for promise-like nested thenable workers function", async () => {
    process.env.PROMISE_LIKE_NESTED_THENABLE_DIRECT_FALLBACK =
      "\"promise-like-nested-thenable-direct-fallback\"";

    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => {
            const workersValue = {
              main: "./src/promise-like-nested-thenable-direct-fallback.ts",
              miniflare: {
                bindings: {
                  PROMISE_LIKE_NESTED_THENABLE_DIRECT_FALLBACK: inject<string>(
                    "PROMISE_LIKE_NESTED_THENABLE_DIRECT_FALLBACK"
                  )
                }
              }
            };
            return {
              then(resolve: (value: typeof workersValue) => void) {
                resolve(workersValue);
                return Promise.resolve(workersValue);
              }
            } as unknown as PromiseLike<typeof workersValue>;
          }
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-like-nested-thenable-direct-fallback");

    delete process.env.PROMISE_LIKE_NESTED_THENABLE_DIRECT_FALLBACK;
  });

  test("prefers scoped env over direct env for promise-like nested thenable workers function", async () => {
    process.env.PROMISE_LIKE_NESTED_THENABLE_SCOPED_PRECEDENCE = "\"nested-thenable-direct-value\"";
    process.env.RSTEST_INJECT_PROMISE_LIKE_NESTED_THENABLE_SCOPED_PRECEDENCE =
      "\"nested-thenable-scoped-value\"";

    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => {
            const workersValue = {
              main: "./src/promise-like-nested-thenable-scoped-precedence.ts",
              miniflare: {
                bindings: {
                  PROMISE_LIKE_NESTED_THENABLE_SCOPED_PRECEDENCE: inject<string>(
                    "PROMISE_LIKE_NESTED_THENABLE_SCOPED_PRECEDENCE"
                  )
                }
              }
            };
            return {
              then(resolve: (value: typeof workersValue) => void) {
                resolve(workersValue);
                return Promise.resolve(workersValue);
              }
            } as unknown as PromiseLike<typeof workersValue>;
          }
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("nested-thenable-scoped-value");
    expect(String(defineValue)).not.toContain("nested-thenable-direct-value");

    delete process.env.RSTEST_INJECT_PROMISE_LIKE_NESTED_THENABLE_SCOPED_PRECEDENCE;
    delete process.env.PROMISE_LIKE_NESTED_THENABLE_SCOPED_PRECEDENCE;
  });

  test("does not evaluate nested workers function in promise-like export when top-level function exists", async () => {
    const promiseLikeValue = {
      workers: () => ({
        main: "./src/promise-like-top-level-function-precedence.ts",
        miniflare: {
          bindings: {
            PROMISE_LIKE_TOP_LEVEL_FUNCTION_PRECEDENCE: "promise-like-top-level-function"
          }
        }
      }),
      test: {
        poolOptions: {
          workers: () => {
            throw new Error("nested promise-like workers function should not execute");
          }
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-like-top-level-function-precedence.ts");
    expect(String(defineValue)).toContain("promise-like-top-level-function");
  });

  test("does not evaluate nested workers function in promise-like export when top-level async function exists", async () => {
    const promiseLikeValue = {
      workers: async () => ({
        main: "./src/promise-like-top-level-async-function-precedence.ts",
        miniflare: {
          bindings: {
            PROMISE_LIKE_TOP_LEVEL_ASYNC_FUNCTION_PRECEDENCE:
              "promise-like-top-level-async-function"
          }
        }
      }),
      test: {
        poolOptions: {
          workers: () => {
            throw new Error("nested promise-like workers function should not execute");
          }
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-like-top-level-async-function-precedence.ts");
    expect(String(defineValue)).toContain("promise-like-top-level-async-function");
  });

  test("does not evaluate nested workers function in promise-like export when top-level thenable function exists", async () => {
    const promiseLikeValue = {
      workers: () => {
        const workersValue = {
          main: "./src/promise-like-top-level-thenable-function-precedence.ts",
          miniflare: {
            bindings: {
              PROMISE_LIKE_TOP_LEVEL_THENABLE_FUNCTION_PRECEDENCE:
                "promise-like-top-level-thenable-function"
            }
          }
        };
        return {
          then(resolve: (value: typeof workersValue) => void) {
            resolve(workersValue);
            return Promise.resolve(workersValue);
          }
        } as unknown as PromiseLike<typeof workersValue>;
      },
      test: {
        poolOptions: {
          workers: () => {
            throw new Error("nested promise-like workers function should not execute");
          }
        }
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-like-top-level-thenable-function-precedence.ts");
    expect(String(defineValue)).toContain("promise-like-top-level-thenable-function");
  });

  test("supports promise-like exports with top-level workers function", async () => {
    process.env.RSTEST_INJECT_PROMISE_LIKE_TOP_LEVEL = "\"promise-like-top-level\"";

    const promiseLikeValue = {
      workers: ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/promise-like-top-level.ts",
        miniflare: {
          bindings: {
            PROMISE_LIKE_TOP_LEVEL: inject<string>("PROMISE_LIKE_TOP_LEVEL")
          }
        }
      }),
      include: ["test/promise-like-top-level/**/*.test.ts"]
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    expect(resolved.include).toEqual(["test/promise-like-top-level/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-like-top-level");

    delete process.env.RSTEST_INJECT_PROMISE_LIKE_TOP_LEVEL;
  });

  test("propagates rejection from promise-like top-level workers function", async () => {
    const errorMessage = "promise-like top-level workers rejection";
    const promiseLikeValue = {
      workers: () => Promise.reject(new Error(errorMessage))
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    await expect(configPromiseLike).rejects.toThrow(errorMessage);
  });

  test("propagates actionable error from promise-like top-level workers function invalid options", async () => {
    const promiseLikeValue = {
      workers: () => "invalid-workers-options" as unknown as WorkersPoolOptions
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    await expect(configPromiseLike).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received string."
    );
  });

  test("propagates actionable error from promise-like top-level workers function null return", async () => {
    const promiseLikeValue = {
      workers: () => null as unknown as WorkersPoolOptions
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    await expect(configPromiseLike).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received null."
    );
  });

  test("propagates thrown errors from promise-like top-level workers function", async () => {
    const errorMessage = "promise-like top-level workers throw";
    const promiseLikeValue = {
      workers: () => {
        throw new Error(errorMessage);
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    await expect(configPromiseLike).rejects.toThrow(errorMessage);
  });

  test("propagates rejection from promise-like top-level thenable workers function", async () => {
    const errorMessage = "promise-like top-level thenable workers rejection";
    const promiseLikeValue = {
      workers: () => ({
        then(
          _resolve: (value: WorkersPoolOptions) => unknown,
          reject?: (reason: unknown) => unknown
        ) {
          const error = new Error(errorMessage);
          if (typeof reject === "function") {
            reject(error);
          }
          return Promise.reject(error);
        }
      }) as PromiseLike<WorkersPoolOptions>
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    await expect(configPromiseLike).rejects.toThrow(errorMessage);
  });

  test("supports direct env fallback for promise-like top-level workers function", async () => {
    process.env.PROMISE_LIKE_TOP_LEVEL_DIRECT_FALLBACK =
      "\"promise-like-top-level-direct-fallback\"";

    const promiseLikeValue = {
      workers: ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/promise-like-top-level-direct-fallback.ts",
        miniflare: {
          bindings: {
            PROMISE_LIKE_TOP_LEVEL_DIRECT_FALLBACK: inject<string>(
              "PROMISE_LIKE_TOP_LEVEL_DIRECT_FALLBACK"
            )
          }
        }
      })
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-like-top-level-direct-fallback");

    delete process.env.PROMISE_LIKE_TOP_LEVEL_DIRECT_FALLBACK;
  });

  test("prefers scoped env over direct env for promise-like top-level workers function", async () => {
    process.env.PROMISE_LIKE_TOP_LEVEL_SCOPED_PRECEDENCE = "\"top-level-direct-value\"";
    process.env.RSTEST_INJECT_PROMISE_LIKE_TOP_LEVEL_SCOPED_PRECEDENCE = "\"top-level-scoped-value\"";

    const promiseLikeValue = {
      workers: ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/promise-like-top-level-scoped-precedence.ts",
        miniflare: {
          bindings: {
            PROMISE_LIKE_TOP_LEVEL_SCOPED_PRECEDENCE: inject<string>(
              "PROMISE_LIKE_TOP_LEVEL_SCOPED_PRECEDENCE"
            )
          }
        }
      })
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("top-level-scoped-value");
    expect(String(defineValue)).not.toContain("top-level-direct-value");

    delete process.env.RSTEST_INJECT_PROMISE_LIKE_TOP_LEVEL_SCOPED_PRECEDENCE;
    delete process.env.PROMISE_LIKE_TOP_LEVEL_SCOPED_PRECEDENCE;
  });

  test("supports direct env fallback for promise-like async top-level workers function", async () => {
    process.env.PROMISE_LIKE_TOP_LEVEL_ASYNC_DIRECT_FALLBACK =
      "\"promise-like-top-level-async-direct-fallback\"";

    const promiseLikeValue = {
      workers: async ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/promise-like-top-level-async-direct-fallback.ts",
        miniflare: {
          bindings: {
            PROMISE_LIKE_TOP_LEVEL_ASYNC_DIRECT_FALLBACK: inject<string>(
              "PROMISE_LIKE_TOP_LEVEL_ASYNC_DIRECT_FALLBACK"
            )
          }
        }
      })
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-like-top-level-async-direct-fallback");

    delete process.env.PROMISE_LIKE_TOP_LEVEL_ASYNC_DIRECT_FALLBACK;
  });

  test("prefers scoped env over direct env for promise-like async top-level workers function", async () => {
    process.env.PROMISE_LIKE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE = "\"top-level-async-direct-value\"";
    process.env.RSTEST_INJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE =
      "\"top-level-async-scoped-value\"";

    const promiseLikeValue = {
      workers: async ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/promise-like-top-level-async-scoped-precedence.ts",
        miniflare: {
          bindings: {
            PROMISE_LIKE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE: inject<string>(
              "PROMISE_LIKE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE"
            )
          }
        }
      })
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("top-level-async-scoped-value");
    expect(String(defineValue)).not.toContain("top-level-async-direct-value");

    delete process.env.RSTEST_INJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE;
    delete process.env.PROMISE_LIKE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE;
  });

  test("supports promise-like exports with top-level thenable workers function", async () => {
    process.env.RSTEST_INJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE = "\"promise-like-top-level-thenable\"";

    const promiseLikeValue = {
      workers: ({ inject }: WorkerPoolOptionsContext) => {
        const workersValue = {
          main: "./src/promise-like-top-level-thenable.ts",
          miniflare: {
            bindings: {
              PROMISE_LIKE_TOP_LEVEL_THENABLE: inject<string>("PROMISE_LIKE_TOP_LEVEL_THENABLE")
            }
          }
        };
        return {
          then(resolve: (value: typeof workersValue) => void) {
            resolve(workersValue);
            return Promise.resolve(workersValue);
          }
        } as unknown as PromiseLike<typeof workersValue>;
      },
      include: ["test/promise-like-top-level-thenable/**/*.test.ts"]
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    expect(resolved.include).toEqual(["test/promise-like-top-level-thenable/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-like-top-level-thenable");

    delete process.env.RSTEST_INJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE;
  });

  test("supports direct env fallback for promise-like top-level thenable workers function", async () => {
    process.env.PROMISE_LIKE_TOP_LEVEL_THENABLE_DIRECT_FALLBACK =
      "\"promise-like-top-level-thenable-direct-fallback\"";

    const promiseLikeValue = {
      workers: ({ inject }: WorkerPoolOptionsContext) => {
        const workersValue = {
          main: "./src/promise-like-top-level-thenable-direct-fallback.ts",
          miniflare: {
            bindings: {
              PROMISE_LIKE_TOP_LEVEL_THENABLE_DIRECT_FALLBACK: inject<string>(
                "PROMISE_LIKE_TOP_LEVEL_THENABLE_DIRECT_FALLBACK"
              )
            }
          }
        };
        return {
          then(resolve: (value: typeof workersValue) => void) {
            resolve(workersValue);
            return Promise.resolve(workersValue);
          }
        } as unknown as PromiseLike<typeof workersValue>;
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-like-top-level-thenable-direct-fallback");

    delete process.env.PROMISE_LIKE_TOP_LEVEL_THENABLE_DIRECT_FALLBACK;
  });

  test("prefers scoped env over direct env for promise-like top-level thenable workers function", async () => {
    process.env.PROMISE_LIKE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE = "\"top-level-thenable-direct-value\"";
    process.env.RSTEST_INJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE =
      "\"top-level-thenable-scoped-value\"";

    const promiseLikeValue = {
      workers: ({ inject }: WorkerPoolOptionsContext) => {
        const workersValue = {
          main: "./src/promise-like-top-level-thenable-scoped-precedence.ts",
          miniflare: {
            bindings: {
              PROMISE_LIKE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE: inject<string>(
                "PROMISE_LIKE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE"
              )
            }
          }
        };
        return {
          then(resolve: (value: typeof workersValue) => void) {
            resolve(workersValue);
            return Promise.resolve(workersValue);
          }
        } as unknown as PromiseLike<typeof workersValue>;
      }
    };
    const configPromiseLike = defineWorkersConfig({
      then(resolve: (value: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(configPromiseLike instanceof Promise)) {
      throw new Error("Expected promise-like config export to resolve as Promise");
    }

    const resolved = await configPromiseLike;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("top-level-thenable-scoped-value");
    expect(String(defineValue)).not.toContain("top-level-thenable-direct-value");

    delete process.env.RSTEST_INJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE;
    delete process.env.PROMISE_LIKE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE;
  });

  test("dedupes workers plugin for promise config exports when plugins is single value", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        plugins: existingPlugin as unknown as any,
        workers: {
          main: "./src/index.ts"
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins.length).toBe(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("keeps non-workers plugins while deduping in promise config exports", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };
    const otherPlugin = {
      name: "other-plugin",
      setup() {}
    };

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        plugins: [otherPlugin, existingPlugin],
        workers: {
          main: "./src/index.ts"
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    const names = plugins
      .map((plugin) =>
        typeof plugin === "object" && plugin !== null && "name" in plugin
          ? String((plugin as { name?: unknown }).name)
          : ""
      )
      .filter(Boolean);

    expect(names).toContain(WORKERS_RSBUILD_PLUGIN_NAME);
    expect(names).toContain("other-plugin");
    expect(names.filter((name) => name === WORKERS_RSBUILD_PLUGIN_NAME)).toHaveLength(1);
  });

  test("keeps falsey plugin entries while deduping in promise config exports", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        plugins: [false as unknown as any, existingPlugin],
        workers: {
          main: "./src/index.ts"
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins).toContain(false);

    const names = plugins
      .map((plugin) =>
        typeof plugin === "object" && plugin !== null && "name" in plugin
          ? String((plugin as { name?: unknown }).name)
          : ""
      )
      .filter(Boolean);
    expect(names.filter((name) => name === WORKERS_RSBUILD_PLUGIN_NAME)).toHaveLength(1);
  });

  test("prefers top-level workers in promise exports when nested workers are also set", async () => {
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: {
          main: "./src/promise-top-level-precedence.ts",
          miniflare: {
            bindings: {
              PROMISE_PRECEDENCE: "promise-top-level"
            }
          }
        },
        test: {
          poolOptions: {
            workers: {
              main: "./src/promise-nested-precedence.ts",
              miniflare: {
                bindings: {
                  PROMISE_PRECEDENCE: "promise-nested"
                }
              }
            }
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-top-level-precedence.ts");
    expect(String(defineValue)).toContain("promise-top-level");
    expect(String(defineValue)).not.toContain("promise-nested-precedence.ts");
  });

  test("throws actionable error for promise exports with invalid top-level workers options", async () => {
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: "invalid-workers-options" as unknown as WorkersPoolOptions
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(
      "Invalid workers options from workers: expected an object but received string."
    );
  });

  test("throws actionable error for promise exports with invalid nested workers options", async () => {
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: 123 as unknown as WorkersPoolOptions
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers: expected an object but received number."
    );
  });

  test("throws actionable error for promise exports with invalid top-level null workers options", async () => {
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: null as unknown as WorkersPoolOptions
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(
      "Invalid workers options from workers: expected an object but received null."
    );
  });

  test("throws actionable error for promise exports with invalid nested array workers options", async () => {
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: [] as unknown as WorkersPoolOptions
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers: expected an object but received array."
    );
  });

  test("does not evaluate nested workers function in promise export when top-level function exists", async () => {
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: () => ({
          main: "./src/promise-top-level-function-precedence.ts",
          miniflare: {
            bindings: {
              PROMISE_TOP_LEVEL_FUNCTION_PRECEDENCE: "promise-top-level-function"
            }
          }
        }),
        test: {
          poolOptions: {
            workers: () => {
              throw new Error("nested promise workers function should not execute");
            }
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-top-level-function-precedence.ts");
    expect(String(defineValue)).toContain("promise-top-level-function");
  });

  test("does not evaluate nested workers function in promise export when top-level async function exists", async () => {
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: async () => ({
          main: "./src/promise-top-level-async-function-precedence.ts",
          miniflare: {
            bindings: {
              PROMISE_TOP_LEVEL_ASYNC_FUNCTION_PRECEDENCE: "promise-top-level-async-function"
            }
          }
        }),
        test: {
          poolOptions: {
            workers: () => {
              throw new Error("nested promise workers function should not execute");
            }
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-top-level-async-function-precedence.ts");
    expect(String(defineValue)).toContain("promise-top-level-async-function");
  });

  test("does not evaluate nested workers function in promise export when top-level thenable function exists", async () => {
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: () => {
          const workersValue = {
            main: "./src/promise-top-level-thenable-function-precedence.ts",
            miniflare: {
              bindings: {
                PROMISE_TOP_LEVEL_THENABLE_FUNCTION_PRECEDENCE:
                  "promise-top-level-thenable-function"
              }
            }
          };
          return {
            then(resolve: (value: typeof workersValue) => void) {
              resolve(workersValue);
              return Promise.resolve(workersValue);
            }
          } as unknown as PromiseLike<typeof workersValue>;
        },
        test: {
          poolOptions: {
            workers: () => {
              throw new Error("nested promise workers function should not execute");
            }
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-top-level-thenable-function-precedence.ts");
    expect(String(defineValue)).toContain("promise-top-level-thenable-function");
  });

  test("propagates rejection from promise nested workers function", async () => {
    const errorMessage = "promise nested workers rejection";
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () => Promise.reject(new Error(errorMessage))
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(errorMessage);
  });

  test("propagates rejection from promise nested async workers function", async () => {
    const errorMessage = "promise nested async workers rejection";
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: async () => {
              throw new Error(errorMessage);
            }
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(errorMessage);
  });

  test("propagates actionable error when promise nested workers function returns invalid options", async () => {
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () => undefined as unknown as WorkersPoolOptions
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received undefined."
    );
  });

  test("propagates actionable error when promise nested workers function returns an array", async () => {
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () => [] as unknown as WorkersPoolOptions
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
    );
  });

  test("propagates thrown errors from promise nested workers function", async () => {
    const errorMessage = "promise nested workers throw";
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () => {
              throw new Error(errorMessage);
            }
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(errorMessage);
  });

  test("propagates rejection from promise nested thenable workers function", async () => {
    const errorMessage = "promise nested thenable workers rejection";
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () =>
              ({
                then(
                  _onfulfilled?: ((value: WorkersPoolOptions) => unknown) | null,
                  onrejected?: ((reason: unknown) => unknown) | null
                ) {
                  const error = new Error(errorMessage);
                  if (typeof onrejected === "function") {
                    onrejected(error);
                  }
                  return Promise.reject(error);
                }
              }) as PromiseLike<WorkersPoolOptions>
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(errorMessage);
  });

  test("propagates thrown errors from promise nested thenable workers function", async () => {
    const errorMessage = "promise nested thenable workers throw";
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () =>
              ({
                then() {
                  throw new Error(errorMessage);
                }
              }) as PromiseLike<WorkersPoolOptions>
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(errorMessage);
  });

  test("propagates thrown errors from promise top-level workers function", async () => {
    const errorMessage = "promise top-level workers throw";
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: () => {
          throw new Error(errorMessage);
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(errorMessage);
  });

  test("propagates rejection from promise top-level workers function", async () => {
    const errorMessage = "promise top-level workers rejection";
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: () => Promise.reject(new Error(errorMessage))
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(errorMessage);
  });

  test("propagates actionable error when promise top-level workers function returns invalid options", async () => {
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: () => "invalid-workers-options" as unknown as WorkersPoolOptions
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received string."
    );
  });

  test("propagates actionable error when promise top-level workers function returns null", async () => {
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: () => null as unknown as WorkersPoolOptions
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received null."
    );
  });

  test("propagates rejection from promise top-level async workers function", async () => {
    const errorMessage = "promise top-level async workers rejection";
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: async () => {
          throw new Error(errorMessage);
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(errorMessage);
  });

  test("propagates rejection from promise top-level thenable workers function", async () => {
    const errorMessage = "promise top-level thenable workers rejection";
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: () =>
          ({
            then(
              _onfulfilled?: ((value: WorkersPoolOptions) => unknown) | null,
              onrejected?: ((reason: unknown) => unknown) | null
            ) {
              const error = new Error(errorMessage);
              if (typeof onrejected === "function") {
                onrejected(error);
              }
              return Promise.reject(error);
            }
          }) as PromiseLike<WorkersPoolOptions>
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(errorMessage);
  });

  test("propagates thrown errors from promise top-level thenable workers function", async () => {
    const errorMessage = "promise top-level thenable workers throw";
    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: () =>
          ({
            then() {
              throw new Error(errorMessage);
            }
          }) as PromiseLike<WorkersPoolOptions>
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(configPromise).rejects.toThrow(errorMessage);
  });

  test("supports promise config exports with nested workers function", async () => {
    process.env.RSTEST_INJECT_PROMISE_NESTED = "\"promise-nested\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          include: ["test/promise-nested/**/*.test.ts"],
          poolOptions: {
            workers: ({ inject }: WorkerPoolOptionsContext) => ({
              main: "./src/promise-nested.ts",
              miniflare: {
                bindings: {
                  PROMISE_NESTED: inject<string>("PROMISE_NESTED")
                }
              }
            })
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    expect(resolved.include).toEqual(["test/promise-nested/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-nested");

    delete process.env.RSTEST_INJECT_PROMISE_NESTED;
  });

  test("supports promise config exports with nested async workers function", async () => {
    process.env.RSTEST_INJECT_PROMISE_NESTED_ASYNC = "\"promise-nested-async\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          include: ["test/promise-nested-async/**/*.test.ts"],
          poolOptions: {
            workers: async ({ inject }: WorkerPoolOptionsContext) => ({
              main: "./src/promise-nested-async.ts",
              miniflare: {
                bindings: {
                  PROMISE_NESTED_ASYNC: inject<string>("PROMISE_NESTED_ASYNC")
                }
              }
            })
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    expect(resolved.include).toEqual(["test/promise-nested-async/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-nested-async");

    delete process.env.RSTEST_INJECT_PROMISE_NESTED_ASYNC;
  });

  test("supports promise config exports with nested thenable workers function", async () => {
    process.env.RSTEST_INJECT_PROMISE_NESTED_THENABLE = "\"promise-nested-thenable\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          include: ["test/promise-nested-thenable/**/*.test.ts"],
          poolOptions: {
            workers: ({ inject }: WorkerPoolOptionsContext) => {
              const resolvedValue = {
                main: "./src/promise-nested-thenable.ts",
                miniflare: {
                  bindings: {
                    PROMISE_NESTED_THENABLE: inject<string>("PROMISE_NESTED_THENABLE")
                  }
                }
              };
              return {
                then(resolve: (resolved: typeof resolvedValue) => void) {
                  resolve(resolvedValue);
                  return Promise.resolve(resolvedValue);
                }
              } as unknown as PromiseLike<typeof resolvedValue>;
            }
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    expect(resolved.include).toEqual(["test/promise-nested-thenable/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-nested-thenable");

    delete process.env.RSTEST_INJECT_PROMISE_NESTED_THENABLE;
  });

  test("supports direct env fallback for promise nested async workers function", async () => {
    process.env.PROMISE_NESTED_ASYNC_FALLBACK = "\"promise-nested-async-fallback\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: async ({ inject }: WorkerPoolOptionsContext) => ({
              main: "./src/promise-nested-async-fallback.ts",
              miniflare: {
                bindings: {
                  PROMISE_NESTED_ASYNC_FALLBACK: inject<string>(
                    "PROMISE_NESTED_ASYNC_FALLBACK"
                  )
                }
              }
            })
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-nested-async-fallback");

    delete process.env.PROMISE_NESTED_ASYNC_FALLBACK;
  });

  test("prefers scoped env over direct env for promise nested async workers function", async () => {
    process.env.PROMISE_NESTED_ASYNC_SCOPED_PRECEDENCE = "\"promise-nested-async-direct-value\"";
    process.env.RSTEST_INJECT_PROMISE_NESTED_ASYNC_SCOPED_PRECEDENCE =
      "\"promise-nested-async-scoped-value\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: async ({ inject }: WorkerPoolOptionsContext) => ({
              main: "./src/promise-nested-async-scoped-precedence.ts",
              miniflare: {
                bindings: {
                  PROMISE_NESTED_ASYNC_SCOPED_PRECEDENCE: inject<string>(
                    "PROMISE_NESTED_ASYNC_SCOPED_PRECEDENCE"
                  )
                }
              }
            })
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-nested-async-scoped-value");
    expect(String(defineValue)).not.toContain("promise-nested-async-direct-value");

    delete process.env.RSTEST_INJECT_PROMISE_NESTED_ASYNC_SCOPED_PRECEDENCE;
    delete process.env.PROMISE_NESTED_ASYNC_SCOPED_PRECEDENCE;
  });

  test("supports direct env fallback for promise nested thenable workers function", async () => {
    process.env.PROMISE_NESTED_THENABLE_FALLBACK = "\"promise-nested-thenable-fallback\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: ({ inject }: WorkerPoolOptionsContext) => {
              const resolvedValue = {
                main: "./src/promise-nested-thenable-fallback.ts",
                miniflare: {
                  bindings: {
                    PROMISE_NESTED_THENABLE_FALLBACK: inject<string>(
                      "PROMISE_NESTED_THENABLE_FALLBACK"
                    )
                  }
                }
              };
              return {
                then(resolve: (resolved: typeof resolvedValue) => void) {
                  resolve(resolvedValue);
                  return Promise.resolve(resolvedValue);
                }
              } as unknown as PromiseLike<typeof resolvedValue>;
            }
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-nested-thenable-fallback");

    delete process.env.PROMISE_NESTED_THENABLE_FALLBACK;
  });

  test("prefers scoped env over direct env for promise nested thenable workers function", async () => {
    process.env.PROMISE_NESTED_THENABLE_SCOPED_PRECEDENCE =
      "\"promise-nested-thenable-direct-value\"";
    process.env.RSTEST_INJECT_PROMISE_NESTED_THENABLE_SCOPED_PRECEDENCE =
      "\"promise-nested-thenable-scoped-value\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: ({ inject }: WorkerPoolOptionsContext) => {
              const resolvedValue = {
                main: "./src/promise-nested-thenable-scoped-precedence.ts",
                miniflare: {
                  bindings: {
                    PROMISE_NESTED_THENABLE_SCOPED_PRECEDENCE: inject<string>(
                      "PROMISE_NESTED_THENABLE_SCOPED_PRECEDENCE"
                    )
                  }
                }
              };
              return {
                then(resolve: (resolved: typeof resolvedValue) => void) {
                  resolve(resolvedValue);
                  return Promise.resolve(resolvedValue);
                }
              } as unknown as PromiseLike<typeof resolvedValue>;
            }
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-nested-thenable-scoped-value");
    expect(String(defineValue)).not.toContain("promise-nested-thenable-direct-value");

    delete process.env.RSTEST_INJECT_PROMISE_NESTED_THENABLE_SCOPED_PRECEDENCE;
    delete process.env.PROMISE_NESTED_THENABLE_SCOPED_PRECEDENCE;
  });

  test("supports direct env fallback for promise nested workers function", async () => {
    process.env.PROMISE_NESTED_FALLBACK = "\"promise-nested-fallback\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: ({ inject }: WorkerPoolOptionsContext) => ({
              main: "./src/promise-nested-fallback.ts",
              miniflare: {
                bindings: {
                  PROMISE_NESTED_FALLBACK: inject<string>("PROMISE_NESTED_FALLBACK")
                }
              }
            })
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-nested-fallback");

    delete process.env.PROMISE_NESTED_FALLBACK;
  });

  test("prefers scoped env over direct env for promise nested workers function", async () => {
    process.env.PROMISE_NESTED_SCOPED_PRECEDENCE = "\"promise-nested-direct-value\"";
    process.env.RSTEST_INJECT_PROMISE_NESTED_SCOPED_PRECEDENCE = "\"promise-nested-scoped-value\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: ({ inject }: WorkerPoolOptionsContext) => ({
              main: "./src/promise-nested-scoped-precedence.ts",
              miniflare: {
                bindings: {
                  PROMISE_NESTED_SCOPED_PRECEDENCE: inject<string>(
                    "PROMISE_NESTED_SCOPED_PRECEDENCE"
                  )
                }
              }
            })
          }
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-nested-scoped-value");
    expect(String(defineValue)).not.toContain("promise-nested-direct-value");

    delete process.env.RSTEST_INJECT_PROMISE_NESTED_SCOPED_PRECEDENCE;
    delete process.env.PROMISE_NESTED_SCOPED_PRECEDENCE;
  });

  test("supports promise config exports with top-level workers function", async () => {
    process.env.RSTEST_INJECT_PROMISE_TOP_LEVEL = "\"promise-top-level\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: ({ inject }: WorkerPoolOptionsContext) => ({
          main: "./src/promise-top-level.ts",
          miniflare: {
            bindings: {
              PROMISE_TOP_LEVEL: inject<string>("PROMISE_TOP_LEVEL")
            }
          }
        }),
        include: ["test/promise-top-level/**/*.test.ts"]
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    expect(resolved.include).toEqual(["test/promise-top-level/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-top-level");

    delete process.env.RSTEST_INJECT_PROMISE_TOP_LEVEL;
  });

  test("supports promise config exports with async top-level workers function", async () => {
    process.env.RSTEST_INJECT_PROMISE_TOP_LEVEL_ASYNC = "\"promise-top-level-async\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: async ({ inject }: WorkerPoolOptionsContext) => ({
          main: "./src/promise-top-level-async.ts",
          miniflare: {
            bindings: {
              PROMISE_TOP_LEVEL_ASYNC: inject<string>("PROMISE_TOP_LEVEL_ASYNC")
            }
          }
        }),
        include: ["test/promise-top-level-async/**/*.test.ts"]
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    expect(resolved.include).toEqual(["test/promise-top-level-async/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-top-level-async");

    delete process.env.RSTEST_INJECT_PROMISE_TOP_LEVEL_ASYNC;
  });

  test("supports promise config exports with top-level thenable workers function", async () => {
    process.env.RSTEST_INJECT_PROMISE_TOP_LEVEL_THENABLE = "\"promise-top-level-thenable\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: ({ inject }: WorkerPoolOptionsContext) => {
          const resolvedValue = {
            main: "./src/promise-top-level-thenable.ts",
            miniflare: {
              bindings: {
                PROMISE_TOP_LEVEL_THENABLE: inject<string>("PROMISE_TOP_LEVEL_THENABLE")
              }
            }
          };
          return {
            then(resolve: (resolved: typeof resolvedValue) => void) {
              resolve(resolvedValue);
              return Promise.resolve(resolvedValue);
            }
          } as unknown as PromiseLike<typeof resolvedValue>;
        },
        include: ["test/promise-top-level-thenable/**/*.test.ts"]
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    expect(resolved.include).toEqual(["test/promise-top-level-thenable/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-top-level-thenable");

    delete process.env.RSTEST_INJECT_PROMISE_TOP_LEVEL_THENABLE;
  });

  test("supports direct env fallback for promise top-level thenable workers function", async () => {
    process.env.PROMISE_TOP_LEVEL_THENABLE_FALLBACK = "\"promise-top-level-thenable-fallback\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: ({ inject }: WorkerPoolOptionsContext) => {
          const resolvedValue = {
            main: "./src/promise-top-level-thenable-fallback.ts",
            miniflare: {
              bindings: {
                PROMISE_TOP_LEVEL_THENABLE_FALLBACK: inject<string>(
                  "PROMISE_TOP_LEVEL_THENABLE_FALLBACK"
                )
              }
            }
          };
          return {
            then(resolve: (resolved: typeof resolvedValue) => void) {
              resolve(resolvedValue);
              return Promise.resolve(resolvedValue);
            }
          } as unknown as PromiseLike<typeof resolvedValue>;
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-top-level-thenable-fallback");

    delete process.env.PROMISE_TOP_LEVEL_THENABLE_FALLBACK;
  });

  test("prefers scoped env over direct env for promise top-level thenable workers function", async () => {
    process.env.PROMISE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE =
      "\"promise-top-level-thenable-direct-value\"";
    process.env.RSTEST_INJECT_PROMISE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE =
      "\"promise-top-level-thenable-scoped-value\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: ({ inject }: WorkerPoolOptionsContext) => {
          const resolvedValue = {
            main: "./src/promise-top-level-thenable-scoped-precedence.ts",
            miniflare: {
              bindings: {
                PROMISE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE: inject<string>(
                  "PROMISE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE"
                )
              }
            }
          };
          return {
            then(resolve: (resolved: typeof resolvedValue) => void) {
              resolve(resolvedValue);
              return Promise.resolve(resolvedValue);
            }
          } as unknown as PromiseLike<typeof resolvedValue>;
        }
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-top-level-thenable-scoped-value");
    expect(String(defineValue)).not.toContain("promise-top-level-thenable-direct-value");

    delete process.env.RSTEST_INJECT_PROMISE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE;
    delete process.env.PROMISE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE;
  });

  test("supports direct env fallback for promise async top-level workers function", async () => {
    process.env.PROMISE_TOP_LEVEL_ASYNC_FALLBACK = "\"promise-top-level-async-fallback\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: async ({ inject }: WorkerPoolOptionsContext) => ({
          main: "./src/promise-top-level-async-fallback.ts",
          miniflare: {
            bindings: {
              PROMISE_TOP_LEVEL_ASYNC_FALLBACK: inject<string>("PROMISE_TOP_LEVEL_ASYNC_FALLBACK")
            }
          }
        })
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-top-level-async-fallback");

    delete process.env.PROMISE_TOP_LEVEL_ASYNC_FALLBACK;
  });

  test("prefers scoped env over direct env for promise async top-level workers function", async () => {
    process.env.PROMISE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE =
      "\"promise-top-level-async-direct-value\"";
    process.env.RSTEST_INJECT_PROMISE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE =
      "\"promise-top-level-async-scoped-value\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: async ({ inject }: WorkerPoolOptionsContext) => ({
          main: "./src/promise-top-level-async-scoped-precedence.ts",
          miniflare: {
            bindings: {
              PROMISE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE: inject<string>(
                "PROMISE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE"
              )
            }
          }
        })
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-top-level-async-scoped-value");
    expect(String(defineValue)).not.toContain("promise-top-level-async-direct-value");

    delete process.env.RSTEST_INJECT_PROMISE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE;
    delete process.env.PROMISE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE;
  });

  test("supports direct env fallback for promise top-level workers function", async () => {
    process.env.PROMISE_TOP_LEVEL_DIRECT_FALLBACK = "\"promise-top-level-direct-fallback\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: ({ inject }: WorkerPoolOptionsContext) => ({
          main: "./src/promise-top-level-direct.ts",
          miniflare: {
            bindings: {
              PROMISE_TOP_LEVEL_DIRECT_FALLBACK: inject<string>("PROMISE_TOP_LEVEL_DIRECT_FALLBACK")
            }
          }
        })
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-top-level-direct-fallback");

    delete process.env.PROMISE_TOP_LEVEL_DIRECT_FALLBACK;
  });

  test("prefers scoped env over direct env for promise top-level workers function", async () => {
    process.env.PROMISE_TOP_LEVEL_SCOPED_PRECEDENCE = "\"promise-top-level-direct-value\"";
    process.env.RSTEST_INJECT_PROMISE_TOP_LEVEL_SCOPED_PRECEDENCE =
      "\"promise-top-level-scoped-value\"";

    const configPromise = defineWorkersConfig(
      Promise.resolve({
        workers: ({ inject }: WorkerPoolOptionsContext) => ({
          main: "./src/promise-top-level-scoped-precedence.ts",
          miniflare: {
            bindings: {
              PROMISE_TOP_LEVEL_SCOPED_PRECEDENCE: inject<string>(
                "PROMISE_TOP_LEVEL_SCOPED_PRECEDENCE"
              )
            }
          }
        })
      })
    );

    if (!(configPromise instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await configPromise;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("promise-top-level-scoped-value");
    expect(String(defineValue)).not.toContain("promise-top-level-direct-value");

    delete process.env.RSTEST_INJECT_PROMISE_TOP_LEVEL_SCOPED_PRECEDENCE;
    delete process.env.PROMISE_TOP_LEVEL_SCOPED_PRECEDENCE;
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

  test("forwards sync config function arguments", () => {
    const configFactory = defineWorkersConfig((...args: unknown[]) => {
      const context = args[0] as { mode?: string } | undefined;
      return {
      include: [context?.mode ?? "unknown"],
      workers: {
        main: "./src/index.ts"
      }
      };
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected sync config function");
    }

    const resolved = configFactory({ mode: "test" });
    if (resolved instanceof Promise) {
      throw new Error("Expected sync config result");
    }

    expect(resolved.include).toEqual(["test"]);
  });

  test("preserves this binding for sync config function exports", () => {
    const configFactory = defineWorkersConfig(function (this: { mode?: string }) {
      return {
        workers: {
          main: "./src/index.ts",
          miniflare: {
            bindings: {
              MODE: this.mode ?? "unknown"
            }
          }
        }
      };
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected sync config function");
    }

    const resolved = configFactory.call({ mode: "sync-this" });
    if (resolved instanceof Promise) {
      throw new Error("Expected sync config result");
    }

    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("sync-this");
  });

  test("preserves this binding for async config function exports", async () => {
    const configFactory = defineWorkersConfig(async function (this: { mode?: string }) {
      return {
        workers: {
          main: "./src/index.ts",
          miniflare: {
            bindings: {
              MODE: this.mode ?? "unknown"
            }
          }
        }
      };
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function");
    }

    const resolved = await configFactory.call({ mode: "async-this" });
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("async-this");
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

  test("supports top-level workers function with inject()", () => {
    process.env.RSTEST_INJECT_TOP_LEVEL_API = "\"http://localhost:7000\"";

    const value = defineWorkersConfig({
      workers: ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/index.ts",
        miniflare: {
          bindings: {
            TOP_LEVEL_API: inject<string>("TOP_LEVEL_API")
          }
        }
      }),
      include: ["test/top-level/**/*.test.ts"]
    });

    if (value instanceof Promise || typeof value === "function") {
      throw new Error("Expected sync config export");
    }

    expect(value.include).toEqual(["test/top-level/**/*.test.ts"]);
    const defineValue = value.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("http://localhost:7000");

    delete process.env.RSTEST_INJECT_TOP_LEVEL_API;
  });

  test("resolves relative workers.main from caller directory", () => {
    const value = defineWorkersConfig({
      workers: {
        main: "./fixtures/worker-main.ts"
      }
    });

    if (value instanceof Promise || typeof value === "function") {
      throw new Error("Expected sync config export");
    }

    const defineValue = value.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    const parsed = JSON.parse(JSON.parse(String(defineValue))) as { main?: string };
    expect(parsed.main).toBe(path.resolve(process.cwd(), "test", "fixtures", "worker-main.ts"));
  });

  test("resolves relative wrangler.configPath from caller directory", () => {
    const value = defineWorkersConfig({
      workers: {
        main: "./src/index.ts",
        wrangler: {
          configPath: "./fixtures/wrangler.jsonc"
        }
      }
    });

    if (value instanceof Promise || typeof value === "function") {
      throw new Error("Expected sync config export");
    }

    const defineValue = value.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    const parsed = JSON.parse(JSON.parse(String(defineValue))) as {
      wrangler?: { configPath?: string };
    };
    expect(parsed.wrangler?.configPath).toBe(
      path.resolve(process.cwd(), "test", "fixtures", "wrangler.jsonc")
    );
  });

  test("resolves relative wrangler.configPath for async top-level workers function", async () => {
    const value = defineWorkersConfig(async () => ({
      workers: async () => ({
        main: "./src/index.ts",
        wrangler: {
          configPath: "./fixtures/async-wrangler.jsonc"
        }
      })
    }));

    if (typeof value !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await value();
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    const parsed = JSON.parse(JSON.parse(String(defineValue))) as {
      wrangler?: { configPath?: string };
    };
    expect(parsed.wrangler?.configPath).toBe(
      path.resolve(process.cwd(), "test", "fixtures", "async-wrangler.jsonc")
    );
  });

  test("supports direct env fallback for inject()", () => {
    process.env.API_HOST = "\"http://localhost:8787\"";

    const value = defineWorkersConfig({
      test: {
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/index.ts",
            miniflare: {
              bindings: {
                API_HOST: inject<string>("API_HOST")
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
    expect(String(defineValue)).toContain("http://localhost:8787");

    delete process.env.API_HOST;
  });

  test("supports direct env fallback for top-level workers function inject()", () => {
    process.env.TOP_LEVEL_API_HOST = "\"http://localhost:9898\"";

    const value = defineWorkersConfig({
      workers: ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/index.ts",
        miniflare: {
          bindings: {
            TOP_LEVEL_API_HOST: inject<string>("TOP_LEVEL_API_HOST")
          }
        }
      })
    });

    if (value instanceof Promise || typeof value === "function") {
      throw new Error("Expected sync config export");
    }

    const defineValue = value.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("http://localhost:9898");

    delete process.env.TOP_LEVEL_API_HOST;
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

  test("supports thenable workers option function in async config export", async () => {
    process.env.RSTEST_INJECT_THENABLE_SERVICE_URL = "\"http://localhost:9010\"";

    const value = defineWorkersConfig(async () => ({
      test: {
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => {
            const resolvedValue = {
              main: "./src/index.ts",
              miniflare: {
                bindings: {
                  THENABLE_SERVICE_URL: inject<string>("THENABLE_SERVICE_URL")
                }
              }
            };
            return {
              then(resolve: (resolved: typeof resolvedValue) => void) {
                resolve(resolvedValue);
                return Promise.resolve(resolvedValue);
              }
            } as unknown as PromiseLike<typeof resolvedValue>;
          }
        }
      }
    }));

    if (typeof value !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await value();
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("http://localhost:9010");

    delete process.env.RSTEST_INJECT_THENABLE_SERVICE_URL;
  });

  test("supports async top-level workers function in async config export", async () => {
    process.env.RSTEST_INJECT_TOP_LEVEL_ASYNC_VALUE = "\"top-level-async\"";

    const value = defineWorkersConfig(async () => ({
      workers: async ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/index.ts",
        miniflare: {
          bindings: {
            TOP_LEVEL_ASYNC_VALUE: inject<string>("TOP_LEVEL_ASYNC_VALUE")
          }
        }
      }),
      include: ["test/top-level-async/**/*.test.ts"]
    }));

    if (typeof value !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await value();
    expect(resolved.include).toEqual(["test/top-level-async/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("top-level-async");

    delete process.env.RSTEST_INJECT_TOP_LEVEL_ASYNC_VALUE;
  });

  test("supports async top-level thenable workers function in async config export", async () => {
    process.env.RSTEST_INJECT_TOP_LEVEL_THENABLE_VALUE = "\"top-level-thenable\"";

    const value = defineWorkersConfig(async () => ({
      workers: ({ inject }: WorkerPoolOptionsContext) => {
        const resolvedValue = {
          main: "./src/index.ts",
          miniflare: {
            bindings: {
              TOP_LEVEL_THENABLE_VALUE: inject<string>("TOP_LEVEL_THENABLE_VALUE")
            }
          }
        };
        return {
          then(resolve: (resolved: typeof resolvedValue) => void) {
            resolve(resolvedValue);
            return Promise.resolve(resolvedValue);
          }
        } as unknown as PromiseLike<typeof resolvedValue>;
      },
      include: ["test/top-level-thenable/**/*.test.ts"]
    }));

    if (typeof value !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await value();
    expect(resolved.include).toEqual(["test/top-level-thenable/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("top-level-thenable");

    delete process.env.RSTEST_INJECT_TOP_LEVEL_THENABLE_VALUE;
  });

  test("does not evaluate nested workers function in async config export when top-level async function exists", async () => {
    const value = defineWorkersConfig(async () => ({
      workers: async () => ({
        main: "./src/async-top-level-function-precedence.ts",
        miniflare: {
          bindings: {
            ASYNC_TOP_LEVEL_FUNCTION_PRECEDENCE: "async-top-level-function"
          }
        }
      }),
      test: {
        poolOptions: {
          workers: () => {
            throw new Error("nested async-config workers function should not execute");
          }
        }
      }
    }));

    if (typeof value !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await value();
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("async-top-level-function-precedence.ts");
    expect(String(defineValue)).toContain("async-top-level-function");
  });

  test("supports direct env fallback for async top-level workers function", async () => {
    process.env.TOP_LEVEL_ASYNC_FALLBACK_VALUE = "\"top-level-async-fallback\"";

    const value = defineWorkersConfig(async () => ({
      workers: async ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/index.ts",
        miniflare: {
          bindings: {
            TOP_LEVEL_ASYNC_FALLBACK_VALUE: inject<string>("TOP_LEVEL_ASYNC_FALLBACK_VALUE")
          }
        }
      })
    }));

    if (typeof value !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await value();
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("top-level-async-fallback");

    delete process.env.TOP_LEVEL_ASYNC_FALLBACK_VALUE;
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
      "Wrap your exported workers config in an async function."
    );
  });

  test("throws when thenable workers options are used in sync config export", () => {
    expect(() =>
      defineWorkersConfig({
        test: {
          poolOptions: {
            workers: ({ inject }: WorkerPoolOptionsContext) => {
              const value = {
                main: "./src/index.ts",
                miniflare: {
                  bindings: {
                    VALUE: inject<string>("VALUE")
                  }
                }
              };
              const thenable = {
                then(resolve: (resolved: typeof value) => void) {
                  resolve(value);
                  return Promise.resolve(value);
                }
              } as unknown as PromiseLike<typeof value>;
              return thenable;
            }
          }
        }
      })
    ).toThrow(
      "Async function-valued workers options require an async config export. " +
      "Wrap your exported workers config in an async function."
    );
  });

  test("throws actionable error when top-level workers options is not an object", () => {
    expect(() =>
      defineWorkersConfig({
        workers: "invalid-workers-options" as unknown as WorkersPoolOptions
      })
    ).toThrow(
      "Invalid workers options from workers: expected an object but received string."
    );
  });

  test("throws actionable error when nested workers options is not an object", () => {
    expect(() =>
      defineWorkersConfig({
        test: {
          poolOptions: {
            workers: 42 as unknown as WorkersPoolOptions
          }
        }
      })
    ).toThrow(
      "Invalid workers options from test.poolOptions.workers: expected an object but received number."
    );
  });

  test("throws actionable error when top-level workers options is null", () => {
    expect(() =>
      defineWorkersConfig({
        workers: null as unknown as WorkersPoolOptions
      })
    ).toThrow(
      "Invalid workers options from workers: expected an object but received null."
    );
  });

  test("throws actionable error when nested workers options is an array", () => {
    expect(() =>
      defineWorkersConfig({
        test: {
          poolOptions: {
            workers: [] as unknown as WorkersPoolOptions
          }
        }
      })
    ).toThrow(
      "Invalid workers options from test.poolOptions.workers: expected an object but received array."
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

  test("keeps falsey plugin entries while deduping in sync config path", () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const value = defineWorkersConfig({
      plugins: [false as unknown as any, existingPlugin],
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
    expect(plugins).toContain(false);
    const names = plugins
      .map((plugin) =>
        typeof plugin === "object" && plugin !== null && "name" in plugin
          ? String((plugin as { name?: unknown }).name)
          : ""
      )
      .filter(Boolean);
    expect(names.filter((name) => name === WORKERS_RSBUILD_PLUGIN_NAME)).toHaveLength(1);
  });

  test("does not inject duplicate workers plugin in async config path", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const configFactory = defineWorkersConfig(async () => ({
      plugins: [existingPlugin],
      workers: {
        main: "./src/index.ts"
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function");
    }

    const resolved = await configFactory();
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];

    expect(plugins.length).toBe(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("does not inject duplicate workers plugin in async config path when plugins is single value", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const configFactory = defineWorkersConfig(async () => ({
      plugins: existingPlugin as unknown as any,
      workers: {
        main: "./src/index.ts"
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function");
    }

    const resolved = await configFactory();
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins.length).toBe(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("keeps falsey plugin entries while deduping in async config path", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const configFactory = defineWorkersConfig(async () => ({
      plugins: [false as unknown as any, existingPlugin],
      workers: {
        main: "./src/index.ts"
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function");
    }

    const resolved = await configFactory();
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins).toContain(false);
    const names = plugins
      .map((plugin) =>
        typeof plugin === "object" && plugin !== null && "name" in plugin
          ? String((plugin as { name?: unknown }).name)
          : ""
      )
      .filter(Boolean);
    expect(names.filter((name) => name === WORKERS_RSBUILD_PLUGIN_NAME)).toHaveLength(1);
  });

  test("does not inject duplicate workers plugin when plugins is a single value", () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const value = defineWorkersConfig({
      plugins: existingPlugin as unknown as any,
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

  test("defineWorkersProject aliases defineWorkersConfig behavior", () => {
    const value = defineWorkersProject({
      workers: {
        main: "./src/index.ts"
      },
      include: ["test/**/*.test.ts"]
    });

    if (value instanceof Promise || typeof value === "function") {
      throw new Error("Expected sync config export");
    }

    expect(value.include).toEqual(["test/**/*.test.ts"]);
    const defineValue = value.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("index.ts");
  });

  test("defineWorkersProject forwards sync config function arguments", () => {
    const value = defineWorkersProject((...args: unknown[]) => {
      const context = args[0] as { mode?: string } | undefined;
      return {
      include: [context?.mode ?? "unknown"],
      workers: {
        main: "./src/project-sync-forwarding.ts"
      }
      };
    });

    if (typeof value !== "function") {
      throw new Error("Expected sync config function export");
    }

    const resolved = value({ mode: "test" });
    if (resolved instanceof Promise) {
      throw new Error("Expected sync config result");
    }

    expect(resolved.include).toEqual(["test"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-sync-forwarding.ts");
  });

  test("defineWorkersProject preserves this binding for sync config function exports", () => {
    const value = defineWorkersProject(function (this: { mode?: string }) {
      return {
        workers: {
          main: "./src/project-sync-this.ts",
          miniflare: {
            bindings: {
              PROJECT_MODE: this.mode ?? "unknown"
            }
          }
        }
      };
    });

    if (typeof value !== "function") {
      throw new Error("Expected sync config function export");
    }

    const resolved = value.call({ mode: "project-sync-this" });
    if (resolved instanceof Promise) {
      throw new Error("Expected sync config result");
    }

    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-sync-this");
    expect(String(defineValue)).toContain("project-sync-this.ts");
  });

  test("defineWorkersProject prefers top-level workers over test.poolOptions.workers", () => {
    const value = defineWorkersProject({
      workers: {
        main: "./src/project-top-level-worker.ts",
        miniflare: {
          bindings: {
            PROJECT_SELECTED_WORKER: "project-top-level"
          }
        }
      },
      test: {
        poolOptions: {
          workers: {
            main: "./src/project-nested-worker.ts",
            miniflare: {
              bindings: {
                PROJECT_SELECTED_WORKER: "project-nested"
              }
            }
          }
        }
      }
    });

    if (value instanceof Promise || typeof value === "function") {
      throw new Error("Expected sync config export");
    }

    const defineValue = value.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-top-level-worker.ts");
    expect(String(defineValue)).toContain("project-top-level");
    expect(String(defineValue)).not.toContain("project-nested-worker.ts");
  });

  test("defineWorkersProject does not evaluate nested workers function when top-level function exists", () => {
    const value = defineWorkersProject({
      workers: ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/project-top-level-function-worker.ts",
        miniflare: {
          bindings: {
            PROJECT_TOP_LEVEL_FUNCTION_VALUE:
              inject<string>("PROJECT_TOP_LEVEL_FUNCTION_VALUE") ?? "project-top-level-fn"
          }
        }
      }),
      test: {
        poolOptions: {
          workers: () => {
            throw new Error("project nested workers function should not execute");
          }
        }
      }
    });

    if (value instanceof Promise || typeof value === "function") {
      throw new Error("Expected sync config export");
    }

    const defineValue = value.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-top-level-function-worker.ts");
    expect(String(defineValue)).toContain("project-top-level-fn");
  });

  test("defineWorkersProject supports promise config exports", async () => {
    const value = defineWorkersProject(
      Promise.resolve({
        workers: {
          main: "./src/project-entry.ts"
        },
        include: ["test/project/**/*.test.ts"]
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    expect(resolved.include).toEqual(["test/project/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-entry.ts");
  });

  test("defineWorkersProject supports promise-like config exports", async () => {
    const promiseLikeValue = {
      workers: {
        main: "./src/project-promise-like-entry.ts"
      },
      include: ["test/project/promise-like/**/*.test.ts"]
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    expect(resolved.include).toEqual(["test/project/promise-like/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-like-entry.ts");
  });

  test("defineWorkersProject propagates rejection from promise-like config exports", async () => {
    const errorMessage = "project promise-like config export rejection";
    const value = defineWorkersProject({
      then(
        _onfulfilled?: ((resolved: WorkersUserConfig) => unknown) | null,
        onrejected?: ((reason: unknown) => unknown) | null
      ) {
        const error = new Error(errorMessage);
        if (typeof onrejected === "function") {
          onrejected(error);
        }
        return Promise.reject(error);
      }
    } as unknown as PromiseLike<WorkersUserConfig>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates thrown errors from promise-like config exports", async () => {
    const errorMessage = "project promise-like config export throw";
    const value = defineWorkersProject({
      then() {
        throw new Error(errorMessage);
      }
    } as unknown as PromiseLike<WorkersUserConfig>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject dedupes workers plugin for promise-like config exports", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const promiseLikeValue = {
      plugins: [existingPlugin],
      workers: {
        main: "./src/project-promise-like-entry.ts"
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins.length).toBe(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("defineWorkersProject dedupes workers plugin for promise-like config exports when plugins is single value", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const promiseLikeValue = {
      plugins: existingPlugin as unknown as any,
      workers: {
        main: "./src/project-promise-like-entry.ts"
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins.length).toBe(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("defineWorkersProject keeps falsey plugin entries while deduping in promise-like config exports", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const promiseLikeValue = {
      plugins: [false as unknown as any, existingPlugin],
      workers: {
        main: "./src/project-promise-like-entry.ts"
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins).toContain(false);
    const names = plugins
      .map((plugin) =>
        typeof plugin === "object" && plugin !== null && "name" in plugin
          ? String((plugin as { name?: unknown }).name)
          : ""
      )
      .filter(Boolean);
    expect(names.filter((name) => name === WORKERS_RSBUILD_PLUGIN_NAME)).toHaveLength(1);
  });

  test("defineWorkersProject prefers top-level workers in promise-like exports when nested workers are also set", async () => {
    const promiseLikeValue = {
      workers: {
        main: "./src/project-promise-like-top-level-precedence.ts",
        miniflare: {
          bindings: {
            PROJECT_PROMISE_LIKE_PRECEDENCE: "project-promise-like-top-level"
          }
        }
      },
      test: {
        poolOptions: {
          workers: {
            main: "./src/project-promise-like-nested-precedence.ts",
            miniflare: {
              bindings: {
                PROJECT_PROMISE_LIKE_PRECEDENCE: "project-promise-like-nested"
              }
            }
          }
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-like-top-level-precedence.ts");
    expect(String(defineValue)).not.toContain("project-promise-like-nested-precedence.ts");
  });

  test("defineWorkersProject throws actionable error for promise-like exports with invalid top-level workers options", async () => {
    const promiseLikeValue = {
      workers: "invalid-workers-options" as unknown as WorkersPoolOptions
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    await expect(value).rejects.toThrow(
      "Invalid workers options from workers: expected an object but received string."
    );
  });

  test("defineWorkersProject throws actionable error for promise-like exports with invalid nested workers options", async () => {
    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: false as unknown as WorkersPoolOptions
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    await expect(value).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers: expected an object but received boolean."
    );
  });

  test("defineWorkersProject throws actionable error for promise-like exports with invalid top-level null workers options", async () => {
    const promiseLikeValue = {
      workers: null as unknown as WorkersPoolOptions
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    await expect(value).rejects.toThrow(
      "Invalid workers options from workers: expected an object but received null."
    );
  });

  test("defineWorkersProject throws actionable error for promise-like exports with invalid nested array workers options", async () => {
    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: [] as unknown as WorkersPoolOptions
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    await expect(value).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers: expected an object but received array."
    );
  });

  test("defineWorkersProject supports promise-like exports with nested workers function", async () => {
    process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED = "\"project-promise-like-nested\"";

    const promiseLikeValue = {
      test: {
        include: ["test/project-promise-like-nested/**/*.test.ts"],
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/project-promise-like-nested-entry.ts",
            miniflare: {
              bindings: {
                PROJECT_PROMISE_LIKE_NESTED: inject<string>("PROJECT_PROMISE_LIKE_NESTED")
              }
            }
          })
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    expect(resolved.include).toEqual(["test/project-promise-like-nested/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-like-nested");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED;
  });

  test("defineWorkersProject propagates rejection from promise-like nested workers function", async () => {
    const errorMessage = "project promise-like nested workers rejection";
    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: () => Promise.reject(new Error(errorMessage))
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates actionable error from promise-like nested workers function invalid options", async () => {
    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: () => undefined as unknown as WorkersPoolOptions
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    await expect(value).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received undefined."
    );
  });

  test("defineWorkersProject propagates actionable error from promise-like nested workers function array return", async () => {
    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: () => [] as unknown as WorkersPoolOptions
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    await expect(value).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
    );
  });

  test("defineWorkersProject propagates thrown errors from promise-like nested workers function", async () => {
    const errorMessage = "project promise-like nested workers throw";
    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: () => {
            throw new Error(errorMessage);
          }
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates rejection from promise-like nested thenable workers function", async () => {
    const errorMessage = "project promise-like nested thenable workers rejection";
    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: () =>
            ({
              then(
                _onfulfilled: ((value: WorkersPoolOptions) => unknown) | null,
                onrejected?: ((reason: unknown) => unknown) | null
              ) {
                const error = new Error(errorMessage);
                if (typeof onrejected === "function") {
                  onrejected(error);
                }
                return Promise.reject(error);
              }
            }) as PromiseLike<WorkersPoolOptions>
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject supports direct env fallback for promise-like nested workers function", async () => {
    process.env.PROJECT_PROMISE_LIKE_NESTED_DIRECT_FALLBACK =
      "\"project-promise-like-nested-direct-fallback\"";

    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/project-promise-like-nested-direct-fallback-entry.ts",
            miniflare: {
              bindings: {
                PROJECT_PROMISE_LIKE_NESTED_DIRECT_FALLBACK: inject<string>(
                  "PROJECT_PROMISE_LIKE_NESTED_DIRECT_FALLBACK"
                )
              }
            }
          })
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-like-nested-direct-fallback");

    delete process.env.PROJECT_PROMISE_LIKE_NESTED_DIRECT_FALLBACK;
  });

  test("defineWorkersProject prefers scoped env over direct env for promise-like nested workers function", async () => {
    process.env.PROJECT_PROMISE_LIKE_NESTED_PRECEDENCE = "\"project-direct-value\"";
    process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED_PRECEDENCE = "\"project-scoped-value\"";

    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/project-promise-like-nested-precedence-env-entry.ts",
            miniflare: {
              bindings: {
                PROJECT_PROMISE_LIKE_NESTED_PRECEDENCE: inject<string>(
                  "PROJECT_PROMISE_LIKE_NESTED_PRECEDENCE"
                )
              }
            }
          })
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-scoped-value");
    expect(String(defineValue)).not.toContain("project-direct-value");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED_PRECEDENCE;
    delete process.env.PROJECT_PROMISE_LIKE_NESTED_PRECEDENCE;
  });

  test("defineWorkersProject supports promise-like exports with nested async workers function", async () => {
    process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED_ASYNC =
      "\"project-promise-like-nested-async\"";

    const promiseLikeValue = {
      test: {
        include: ["test/project-promise-like-nested-async/**/*.test.ts"],
        poolOptions: {
          workers: async ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/project-promise-like-nested-async-entry.ts",
            miniflare: {
              bindings: {
                PROJECT_PROMISE_LIKE_NESTED_ASYNC: inject<string>(
                  "PROJECT_PROMISE_LIKE_NESTED_ASYNC"
                )
              }
            }
          })
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    expect(resolved.include).toEqual(["test/project-promise-like-nested-async/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-like-nested-async");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED_ASYNC;
  });

  test("defineWorkersProject supports direct env fallback for promise-like nested async workers function", async () => {
    process.env.PROJECT_PROMISE_LIKE_NESTED_ASYNC_DIRECT_FALLBACK =
      "\"project-promise-like-nested-async-direct-fallback\"";

    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: async ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/project-promise-like-nested-async-direct-fallback-entry.ts",
            miniflare: {
              bindings: {
                PROJECT_PROMISE_LIKE_NESTED_ASYNC_DIRECT_FALLBACK: inject<string>(
                  "PROJECT_PROMISE_LIKE_NESTED_ASYNC_DIRECT_FALLBACK"
                )
              }
            }
          })
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-like-nested-async-direct-fallback");

    delete process.env.PROJECT_PROMISE_LIKE_NESTED_ASYNC_DIRECT_FALLBACK;
  });

  test("defineWorkersProject prefers scoped env over direct env for promise-like nested async workers function", async () => {
    process.env.PROJECT_PROMISE_LIKE_NESTED_ASYNC_SCOPED_PRECEDENCE =
      "\"project-nested-async-direct-value\"";
    process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED_ASYNC_SCOPED_PRECEDENCE =
      "\"project-nested-async-scoped-value\"";

    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: async ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/project-promise-like-nested-async-scoped-precedence-entry.ts",
            miniflare: {
              bindings: {
                PROJECT_PROMISE_LIKE_NESTED_ASYNC_SCOPED_PRECEDENCE: inject<string>(
                  "PROJECT_PROMISE_LIKE_NESTED_ASYNC_SCOPED_PRECEDENCE"
                )
              }
            }
          })
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-nested-async-scoped-value");
    expect(String(defineValue)).not.toContain("project-nested-async-direct-value");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED_ASYNC_SCOPED_PRECEDENCE;
    delete process.env.PROJECT_PROMISE_LIKE_NESTED_ASYNC_SCOPED_PRECEDENCE;
  });

  test("defineWorkersProject supports promise-like exports with nested thenable workers function", async () => {
    process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED_THENABLE =
      "\"project-promise-like-nested-thenable\"";

    const promiseLikeValue = {
      test: {
        include: ["test/project-promise-like-nested-thenable/**/*.test.ts"],
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => {
            const workersValue = {
              main: "./src/project-promise-like-nested-thenable-entry.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_LIKE_NESTED_THENABLE: inject<string>(
                    "PROJECT_PROMISE_LIKE_NESTED_THENABLE"
                  )
                }
              }
            };
            return {
              then(resolve: (value: typeof workersValue) => void) {
                resolve(workersValue);
                return Promise.resolve(workersValue);
              }
            } as unknown as PromiseLike<typeof workersValue>;
          }
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    expect(resolved.include).toEqual(["test/project-promise-like-nested-thenable/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-like-nested-thenable");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED_THENABLE;
  });

  test("defineWorkersProject supports direct env fallback for promise-like nested thenable workers function", async () => {
    process.env.PROJECT_PROMISE_LIKE_NESTED_THENABLE_DIRECT_FALLBACK =
      "\"project-promise-like-nested-thenable-direct-fallback\"";

    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => {
            const workersValue = {
              main: "./src/project-promise-like-nested-thenable-direct-fallback-entry.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_LIKE_NESTED_THENABLE_DIRECT_FALLBACK: inject<string>(
                    "PROJECT_PROMISE_LIKE_NESTED_THENABLE_DIRECT_FALLBACK"
                  )
                }
              }
            };
            return {
              then(resolve: (value: typeof workersValue) => void) {
                resolve(workersValue);
                return Promise.resolve(workersValue);
              }
            } as unknown as PromiseLike<typeof workersValue>;
          }
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-like-nested-thenable-direct-fallback");

    delete process.env.PROJECT_PROMISE_LIKE_NESTED_THENABLE_DIRECT_FALLBACK;
  });

  test("defineWorkersProject prefers scoped env over direct env for promise-like nested thenable workers function", async () => {
    process.env.PROJECT_PROMISE_LIKE_NESTED_THENABLE_SCOPED_PRECEDENCE =
      "\"project-nested-thenable-direct-value\"";
    process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED_THENABLE_SCOPED_PRECEDENCE =
      "\"project-nested-thenable-scoped-value\"";

    const promiseLikeValue = {
      test: {
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => {
            const workersValue = {
              main: "./src/project-promise-like-nested-thenable-scoped-precedence-entry.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_LIKE_NESTED_THENABLE_SCOPED_PRECEDENCE: inject<string>(
                    "PROJECT_PROMISE_LIKE_NESTED_THENABLE_SCOPED_PRECEDENCE"
                  )
                }
              }
            };
            return {
              then(resolve: (value: typeof workersValue) => void) {
                resolve(workersValue);
                return Promise.resolve(workersValue);
              }
            } as unknown as PromiseLike<typeof workersValue>;
          }
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-nested-thenable-scoped-value");
    expect(String(defineValue)).not.toContain("project-nested-thenable-direct-value");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED_THENABLE_SCOPED_PRECEDENCE;
    delete process.env.PROJECT_PROMISE_LIKE_NESTED_THENABLE_SCOPED_PRECEDENCE;
  });

  test("defineWorkersProject does not evaluate nested workers function in promise-like export when top-level function exists", async () => {
    const promiseLikeValue = {
      workers: () => ({
        main: "./src/project-promise-like-top-level-function-precedence.ts",
        miniflare: {
          bindings: {
            PROJECT_PROMISE_LIKE_TOP_LEVEL_FUNCTION_PRECEDENCE:
              "project-promise-like-top-level-function"
          }
        }
      }),
      test: {
        poolOptions: {
          workers: () => {
            throw new Error("project nested promise-like workers function should not execute");
          }
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-like-top-level-function-precedence.ts");
    expect(String(defineValue)).toContain("project-promise-like-top-level-function");
  });

  test("defineWorkersProject does not evaluate nested workers function in promise-like export when top-level async function exists", async () => {
    const promiseLikeValue = {
      workers: async () => ({
        main: "./src/project-promise-like-top-level-async-function-precedence.ts",
        miniflare: {
          bindings: {
            PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_FUNCTION_PRECEDENCE:
              "project-promise-like-top-level-async-function"
          }
        }
      }),
      test: {
        poolOptions: {
          workers: () => {
            throw new Error("project nested promise-like workers function should not execute");
          }
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain(
      "project-promise-like-top-level-async-function-precedence.ts"
    );
    expect(String(defineValue)).toContain("project-promise-like-top-level-async-function");
  });

  test("defineWorkersProject does not evaluate nested workers function in promise-like export when top-level thenable function exists", async () => {
    const promiseLikeValue = {
      workers: () => {
        const workersValue = {
          main: "./src/project-promise-like-top-level-thenable-function-precedence.ts",
          miniflare: {
            bindings: {
              PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_FUNCTION_PRECEDENCE:
                "project-promise-like-top-level-thenable-function"
            }
          }
        };
        return {
          then(resolve: (value: typeof workersValue) => void) {
            resolve(workersValue);
            return Promise.resolve(workersValue);
          }
        } as unknown as PromiseLike<typeof workersValue>;
      },
      test: {
        poolOptions: {
          workers: () => {
            throw new Error("project nested promise-like workers function should not execute");
          }
        }
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain(
      "project-promise-like-top-level-thenable-function-precedence.ts"
    );
    expect(String(defineValue)).toContain("project-promise-like-top-level-thenable-function");
  });

  test("defineWorkersProject supports promise-like exports with top-level workers function", async () => {
    process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_TOP_LEVEL = "\"project-promise-like-top-level\"";

    const promiseLikeValue = {
      workers: ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/project-promise-like-top-level-entry.ts",
        miniflare: {
          bindings: {
            PROJECT_PROMISE_LIKE_TOP_LEVEL: inject<string>("PROJECT_PROMISE_LIKE_TOP_LEVEL")
          }
        }
      }),
      include: ["test/project-promise-like-top-level/**/*.test.ts"]
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    expect(resolved.include).toEqual(["test/project-promise-like-top-level/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-like-top-level");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_TOP_LEVEL;
  });

  test("defineWorkersProject propagates rejection from promise-like top-level workers function", async () => {
    const errorMessage = "project promise-like top-level workers rejection";
    const promiseLikeValue = {
      workers: () => Promise.reject(new Error(errorMessage))
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates actionable error from promise-like top-level workers function invalid options", async () => {
    const promiseLikeValue = {
      workers: () => "invalid-workers-options" as unknown as WorkersPoolOptions
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    await expect(value).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received string."
    );
  });

  test("defineWorkersProject propagates actionable error from promise-like top-level workers function null return", async () => {
    const promiseLikeValue = {
      workers: () => null as unknown as WorkersPoolOptions
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    await expect(value).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received null."
    );
  });

  test("defineWorkersProject propagates thrown errors from promise-like top-level workers function", async () => {
    const errorMessage = "project promise-like top-level workers throw";
    const promiseLikeValue = {
      workers: () => {
        throw new Error(errorMessage);
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates rejection from promise-like top-level thenable workers function", async () => {
    const errorMessage = "project promise-like top-level thenable workers rejection";
    const promiseLikeValue = {
      workers: () => ({
        then(
          _resolve: (value: WorkersPoolOptions) => unknown,
          reject?: (reason: unknown) => unknown
        ) {
          const error = new Error(errorMessage);
          if (typeof reject === "function") {
            reject(error);
          }
          return Promise.reject(error);
        }
      }) as PromiseLike<WorkersPoolOptions>
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject supports direct env fallback for promise-like top-level workers function", async () => {
    process.env.PROJECT_PROMISE_LIKE_TOP_LEVEL_DIRECT_FALLBACK =
      "\"project-promise-like-top-level-direct-fallback\"";

    const promiseLikeValue = {
      workers: ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/project-promise-like-top-level-direct-fallback-entry.ts",
        miniflare: {
          bindings: {
            PROJECT_PROMISE_LIKE_TOP_LEVEL_DIRECT_FALLBACK: inject<string>(
              "PROJECT_PROMISE_LIKE_TOP_LEVEL_DIRECT_FALLBACK"
            )
          }
        }
      })
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-like-top-level-direct-fallback");

    delete process.env.PROJECT_PROMISE_LIKE_TOP_LEVEL_DIRECT_FALLBACK;
  });

  test("defineWorkersProject prefers scoped env over direct env for promise-like top-level workers function", async () => {
    process.env.PROJECT_PROMISE_LIKE_TOP_LEVEL_SCOPED_PRECEDENCE = "\"project-top-level-direct-value\"";
    process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_TOP_LEVEL_SCOPED_PRECEDENCE =
      "\"project-top-level-scoped-value\"";

    const promiseLikeValue = {
      workers: ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/project-promise-like-top-level-scoped-precedence-entry.ts",
        miniflare: {
          bindings: {
            PROJECT_PROMISE_LIKE_TOP_LEVEL_SCOPED_PRECEDENCE: inject<string>(
              "PROJECT_PROMISE_LIKE_TOP_LEVEL_SCOPED_PRECEDENCE"
            )
          }
        }
      })
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-top-level-scoped-value");
    expect(String(defineValue)).not.toContain("project-top-level-direct-value");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_TOP_LEVEL_SCOPED_PRECEDENCE;
    delete process.env.PROJECT_PROMISE_LIKE_TOP_LEVEL_SCOPED_PRECEDENCE;
  });

  test("defineWorkersProject supports direct env fallback for promise-like async top-level workers function", async () => {
    process.env.PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_DIRECT_FALLBACK =
      "\"project-promise-like-top-level-async-direct-fallback\"";

    const promiseLikeValue = {
      workers: async ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/project-promise-like-top-level-async-direct-fallback-entry.ts",
        miniflare: {
          bindings: {
            PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_DIRECT_FALLBACK: inject<string>(
              "PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_DIRECT_FALLBACK"
            )
          }
        }
      })
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-like-top-level-async-direct-fallback");

    delete process.env.PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_DIRECT_FALLBACK;
  });

  test("defineWorkersProject prefers scoped env over direct env for promise-like async top-level workers function", async () => {
    process.env.PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE =
      "\"project-top-level-async-direct-value\"";
    process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE =
      "\"project-top-level-async-scoped-value\"";

    const promiseLikeValue = {
      workers: async ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/project-promise-like-top-level-async-scoped-precedence-entry.ts",
        miniflare: {
          bindings: {
            PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE: inject<string>(
              "PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE"
            )
          }
        }
      })
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-top-level-async-scoped-value");
    expect(String(defineValue)).not.toContain("project-top-level-async-direct-value");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE;
    delete process.env.PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE;
  });

  test("defineWorkersProject supports promise-like exports with top-level thenable workers function", async () => {
    process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE =
      "\"project-promise-like-top-level-thenable\"";

    const promiseLikeValue = {
      workers: ({ inject }: WorkerPoolOptionsContext) => {
        const workersValue = {
          main: "./src/project-promise-like-top-level-thenable-entry.ts",
          miniflare: {
            bindings: {
              PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE: inject<string>(
                "PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE"
              )
            }
          }
        };
        return {
          then(resolve: (value: typeof workersValue) => void) {
            resolve(workersValue);
            return Promise.resolve(workersValue);
          }
        } as unknown as PromiseLike<typeof workersValue>;
      },
      include: ["test/project-promise-like-top-level-thenable/**/*.test.ts"]
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    expect(resolved.include).toEqual(["test/project-promise-like-top-level-thenable/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-like-top-level-thenable");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE;
  });

  test("defineWorkersProject supports direct env fallback for promise-like top-level thenable workers function", async () => {
    process.env.PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_DIRECT_FALLBACK =
      "\"project-promise-like-top-level-thenable-direct-fallback\"";

    const promiseLikeValue = {
      workers: ({ inject }: WorkerPoolOptionsContext) => {
        const workersValue = {
          main: "./src/project-promise-like-top-level-thenable-direct-fallback-entry.ts",
          miniflare: {
            bindings: {
              PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_DIRECT_FALLBACK: inject<string>(
                "PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_DIRECT_FALLBACK"
              )
            }
          }
        };
        return {
          then(resolve: (value: typeof workersValue) => void) {
            resolve(workersValue);
            return Promise.resolve(workersValue);
          }
        } as unknown as PromiseLike<typeof workersValue>;
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain(
      "project-promise-like-top-level-thenable-direct-fallback"
    );

    delete process.env.PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_DIRECT_FALLBACK;
  });

  test("defineWorkersProject prefers scoped env over direct env for promise-like top-level thenable workers function", async () => {
    process.env.PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE =
      "\"project-top-level-thenable-direct-value\"";
    process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE =
      "\"project-top-level-thenable-scoped-value\"";

    const promiseLikeValue = {
      workers: ({ inject }: WorkerPoolOptionsContext) => {
        const workersValue = {
          main: "./src/project-promise-like-top-level-thenable-scoped-precedence-entry.ts",
          miniflare: {
            bindings: {
              PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE: inject<string>(
                "PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE"
              )
            }
          }
        };
        return {
          then(resolve: (value: typeof workersValue) => void) {
            resolve(workersValue);
            return Promise.resolve(workersValue);
          }
        } as unknown as PromiseLike<typeof workersValue>;
      }
    };
    const value = defineWorkersProject({
      then(resolve: (resolved: typeof promiseLikeValue) => void) {
        resolve(promiseLikeValue);
        return Promise.resolve(promiseLikeValue);
      }
    } as unknown as PromiseLike<typeof promiseLikeValue>);

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise-like config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-top-level-thenable-scoped-value");
    expect(String(defineValue)).not.toContain("project-top-level-thenable-direct-value");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE;
    delete process.env.PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE;
  });

  test("defineWorkersProject dedupes workers plugin for promise config exports", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const value = defineWorkersProject(
      Promise.resolve({
        plugins: [existingPlugin],
        workers: {
          main: "./src/project-entry.ts"
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins.length).toBe(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("defineWorkersProject dedupes workers plugin for promise exports when plugins is single value", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const value = defineWorkersProject(
      Promise.resolve({
        plugins: existingPlugin as unknown as any,
        workers: {
          main: "./src/project-entry.ts"
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins.length).toBe(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("defineWorkersProject keeps non-workers plugins while deduping in promise exports", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };
    const otherPlugin = {
      name: "project-other-plugin",
      setup() {}
    };

    const value = defineWorkersProject(
      Promise.resolve({
        plugins: [otherPlugin, existingPlugin],
        workers: {
          main: "./src/project-entry.ts"
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    const names = plugins
      .map((plugin) =>
        typeof plugin === "object" && plugin !== null && "name" in plugin
          ? String((plugin as { name?: unknown }).name)
          : ""
      )
      .filter(Boolean);

    expect(names).toContain(WORKERS_RSBUILD_PLUGIN_NAME);
    expect(names).toContain("project-other-plugin");
    expect(names.filter((name) => name === WORKERS_RSBUILD_PLUGIN_NAME)).toHaveLength(1);
  });

  test("defineWorkersProject keeps falsey plugin entries while deduping in promise exports", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const value = defineWorkersProject(
      Promise.resolve({
        plugins: [false as unknown as any, existingPlugin],
        workers: {
          main: "./src/project-entry.ts"
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins).toContain(false);

    const names = plugins
      .map((plugin) =>
        typeof plugin === "object" && plugin !== null && "name" in plugin
          ? String((plugin as { name?: unknown }).name)
          : ""
      )
      .filter(Boolean);
    expect(names.filter((name) => name === WORKERS_RSBUILD_PLUGIN_NAME)).toHaveLength(1);
  });

  test("defineWorkersProject prefers top-level workers in promise exports", async () => {
    const value = defineWorkersProject(
      Promise.resolve({
        workers: {
          main: "./src/project-promise-top-level-precedence.ts",
          miniflare: {
            bindings: {
              PROJECT_PROMISE_PRECEDENCE: "project-promise-top-level"
            }
          }
        },
        test: {
          poolOptions: {
            workers: {
              main: "./src/project-promise-nested-precedence.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_PRECEDENCE: "project-promise-nested"
                }
              }
            }
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-top-level-precedence.ts");
    expect(String(defineValue)).toContain("project-promise-top-level");
    expect(String(defineValue)).not.toContain("project-promise-nested-precedence.ts");
  });

  test("defineWorkersProject throws actionable error for promise exports with invalid top-level workers options", async () => {
    const value = defineWorkersProject(
      Promise.resolve({
        workers: "invalid-workers-options" as unknown as WorkersPoolOptions
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(
      "Invalid workers options from workers: expected an object but received string."
    );
  });

  test("defineWorkersProject throws actionable error for promise exports with invalid nested workers options", async () => {
    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: false as unknown as WorkersPoolOptions
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers: expected an object but received boolean."
    );
  });

  test("defineWorkersProject throws actionable error for promise exports with invalid top-level null workers options", async () => {
    const value = defineWorkersProject(
      Promise.resolve({
        workers: null as unknown as WorkersPoolOptions
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(
      "Invalid workers options from workers: expected an object but received null."
    );
  });

  test("defineWorkersProject throws actionable error for promise exports with invalid nested array workers options", async () => {
    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: [] as unknown as WorkersPoolOptions
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers: expected an object but received array."
    );
  });

  test("defineWorkersProject does not evaluate nested workers function in promise export when top-level function exists", async () => {
    const value = defineWorkersProject(
      Promise.resolve({
        workers: () => ({
          main: "./src/project-promise-top-level-function-precedence.ts",
          miniflare: {
            bindings: {
              PROJECT_PROMISE_TOP_LEVEL_FUNCTION_PRECEDENCE: "project-promise-top-level-function"
            }
          }
        }),
        test: {
          poolOptions: {
            workers: () => {
              throw new Error("project nested promise workers function should not execute");
            }
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-top-level-function-precedence.ts");
    expect(String(defineValue)).toContain("project-promise-top-level-function");
  });

  test("defineWorkersProject does not evaluate nested workers function in promise export when top-level async function exists", async () => {
    const value = defineWorkersProject(
      Promise.resolve({
        workers: async () => ({
          main: "./src/project-promise-top-level-async-function-precedence.ts",
          miniflare: {
            bindings: {
              PROJECT_PROMISE_TOP_LEVEL_ASYNC_FUNCTION_PRECEDENCE:
                "project-promise-top-level-async-function"
            }
          }
        }),
        test: {
          poolOptions: {
            workers: () => {
              throw new Error("project nested promise workers function should not execute");
            }
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-top-level-async-function-precedence.ts");
    expect(String(defineValue)).toContain("project-promise-top-level-async-function");
  });

  test("defineWorkersProject does not evaluate nested workers function in promise export when top-level thenable function exists", async () => {
    const value = defineWorkersProject(
      Promise.resolve({
        workers: () => {
          const workersValue = {
            main: "./src/project-promise-top-level-thenable-function-precedence.ts",
            miniflare: {
              bindings: {
                PROJECT_PROMISE_TOP_LEVEL_THENABLE_FUNCTION_PRECEDENCE:
                  "project-promise-top-level-thenable-function"
              }
            }
          };
          return {
            then(resolve: (resolved: typeof workersValue) => void) {
              resolve(workersValue);
              return Promise.resolve(workersValue);
            }
          } as unknown as PromiseLike<typeof workersValue>;
        },
        test: {
          poolOptions: {
            workers: () => {
              throw new Error("project nested promise workers function should not execute");
            }
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain(
      "project-promise-top-level-thenable-function-precedence.ts"
    );
    expect(String(defineValue)).toContain("project-promise-top-level-thenable-function");
  });

  test("defineWorkersProject propagates rejection from promise nested workers function", async () => {
    const errorMessage = "project promise nested workers rejection";
    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () => Promise.reject(new Error(errorMessage))
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates rejection from promise nested async workers function", async () => {
    const errorMessage = "project promise nested async workers rejection";
    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: async () => {
              throw new Error(errorMessage);
            }
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates actionable error when promise nested workers function returns invalid options", async () => {
    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () => undefined as unknown as WorkersPoolOptions
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received undefined."
    );
  });

  test("defineWorkersProject propagates actionable error when promise nested workers function returns an array", async () => {
    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () => [] as unknown as WorkersPoolOptions
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
    );
  });

  test("defineWorkersProject propagates thrown errors from promise nested workers function", async () => {
    const errorMessage = "project promise nested workers throw";
    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () => {
              throw new Error(errorMessage);
            }
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates rejection from promise nested thenable workers function", async () => {
    const errorMessage = "project promise nested thenable workers rejection";
    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () =>
              ({
                then(
                  _onfulfilled?: ((resolved: WorkersPoolOptions) => unknown) | null,
                  onrejected?: ((reason: unknown) => unknown) | null
                ) {
                  const error = new Error(errorMessage);
                  if (typeof onrejected === "function") {
                    onrejected(error);
                  }
                  return Promise.reject(error);
                }
              }) as PromiseLike<WorkersPoolOptions>
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates thrown errors from promise nested thenable workers function", async () => {
    const errorMessage = "project promise nested thenable workers throw";
    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () =>
              ({
                then() {
                  throw new Error(errorMessage);
                }
              }) as PromiseLike<WorkersPoolOptions>
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates thrown errors from promise top-level workers function", async () => {
    const errorMessage = "project promise top-level workers throw";
    const value = defineWorkersProject(
      Promise.resolve({
        workers: () => {
          throw new Error(errorMessage);
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates rejection from promise top-level workers function", async () => {
    const errorMessage = "project promise top-level workers rejection";
    const value = defineWorkersProject(
      Promise.resolve({
        workers: () => Promise.reject(new Error(errorMessage))
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates actionable error when promise top-level workers function returns invalid options", async () => {
    const value = defineWorkersProject(
      Promise.resolve({
        workers: () => "invalid-workers-options" as unknown as WorkersPoolOptions
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received string."
    );
  });

  test("defineWorkersProject propagates actionable error when promise top-level workers function returns null", async () => {
    const value = defineWorkersProject(
      Promise.resolve({
        workers: () => null as unknown as WorkersPoolOptions
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received null."
    );
  });

  test("defineWorkersProject propagates rejection from promise top-level async workers function", async () => {
    const errorMessage = "project promise top-level async workers rejection";
    const value = defineWorkersProject(
      Promise.resolve({
        workers: async () => {
          throw new Error(errorMessage);
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates rejection from promise top-level thenable workers function", async () => {
    const errorMessage = "project promise top-level thenable workers rejection";
    const value = defineWorkersProject(
      Promise.resolve({
        workers: () =>
          ({
            then(
              _onfulfilled?: ((resolved: WorkersPoolOptions) => unknown) | null,
              onrejected?: ((reason: unknown) => unknown) | null
            ) {
              const error = new Error(errorMessage);
              if (typeof onrejected === "function") {
                onrejected(error);
              }
              return Promise.reject(error);
            }
          }) as PromiseLike<WorkersPoolOptions>
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates thrown errors from promise top-level thenable workers function", async () => {
    const errorMessage = "project promise top-level thenable workers throw";
    const value = defineWorkersProject(
      Promise.resolve({
        workers: () =>
          ({
            then() {
              throw new Error(errorMessage);
            }
          }) as PromiseLike<WorkersPoolOptions>
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    await expect(value).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject supports promise exports with nested test.poolOptions", async () => {
    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          include: ["test/project-nested/**/*.test.ts"],
          poolOptions: {
            workers: {
              main: "./src/project-nested-entry.ts"
            }
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    expect(resolved.include).toEqual(["test/project-nested/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-nested-entry.ts");
  });

  test("defineWorkersProject supports promise exports with nested async workers function", async () => {
    process.env.RSTEST_INJECT_PROJECT_PROMISE_NESTED_ASYNC = "\"project-promise-nested-async\"";

    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          include: ["test/project-promise-nested-async/**/*.test.ts"],
          poolOptions: {
            workers: async ({ inject }: WorkerPoolOptionsContext) => ({
              main: "./src/project-promise-nested-async-entry.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_NESTED_ASYNC: inject<string>(
                    "PROJECT_PROMISE_NESTED_ASYNC"
                  )
                }
              }
            })
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    expect(resolved.include).toEqual(["test/project-promise-nested-async/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-nested-async");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_NESTED_ASYNC;
  });

  test("defineWorkersProject supports promise exports with nested thenable workers function", async () => {
    process.env.RSTEST_INJECT_PROJECT_PROMISE_NESTED_THENABLE = "\"project-promise-nested-thenable\"";

    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          include: ["test/project-promise-nested-thenable/**/*.test.ts"],
          poolOptions: {
            workers: ({ inject }: WorkerPoolOptionsContext) => {
              const resolvedValue = {
                main: "./src/project-promise-nested-thenable-entry.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_NESTED_THENABLE: inject<string>(
                      "PROJECT_PROMISE_NESTED_THENABLE"
                    )
                  }
                }
              };
              return {
                then(resolve: (resolved: typeof resolvedValue) => void) {
                  resolve(resolvedValue);
                  return Promise.resolve(resolvedValue);
                }
              } as unknown as PromiseLike<typeof resolvedValue>;
            }
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    expect(resolved.include).toEqual(["test/project-promise-nested-thenable/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-nested-thenable");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_NESTED_THENABLE;
  });

  test("defineWorkersProject supports direct env fallback for promise nested workers function", async () => {
    process.env.PROJECT_PROMISE_NESTED_FALLBACK = "\"project-promise-nested-fallback\"";

    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: ({ inject }: WorkerPoolOptionsContext) => ({
              main: "./src/project-promise-nested-fallback-entry.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_NESTED_FALLBACK: inject<string>("PROJECT_PROMISE_NESTED_FALLBACK")
                }
              }
            })
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-nested-fallback");

    delete process.env.PROJECT_PROMISE_NESTED_FALLBACK;
  });

  test("defineWorkersProject prefers scoped env over direct env for promise nested workers function", async () => {
    process.env.PROJECT_PROMISE_NESTED_SCOPED_PRECEDENCE = "\"project-promise-nested-direct-value\"";
    process.env.RSTEST_INJECT_PROJECT_PROMISE_NESTED_SCOPED_PRECEDENCE =
      "\"project-promise-nested-scoped-value\"";

    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: ({ inject }: WorkerPoolOptionsContext) => ({
              main: "./src/project-promise-nested-scoped-precedence-entry.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_NESTED_SCOPED_PRECEDENCE: inject<string>(
                    "PROJECT_PROMISE_NESTED_SCOPED_PRECEDENCE"
                  )
                }
              }
            })
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-nested-scoped-value");
    expect(String(defineValue)).not.toContain("project-promise-nested-direct-value");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_NESTED_SCOPED_PRECEDENCE;
    delete process.env.PROJECT_PROMISE_NESTED_SCOPED_PRECEDENCE;
  });

  test("defineWorkersProject supports direct env fallback for promise nested async workers function", async () => {
    process.env.PROJECT_PROMISE_NESTED_ASYNC_FALLBACK =
      "\"project-promise-nested-async-fallback\"";

    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: async ({ inject }: WorkerPoolOptionsContext) => ({
              main: "./src/project-promise-nested-async-fallback-entry.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_NESTED_ASYNC_FALLBACK: inject<string>(
                    "PROJECT_PROMISE_NESTED_ASYNC_FALLBACK"
                  )
                }
              }
            })
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-nested-async-fallback");

    delete process.env.PROJECT_PROMISE_NESTED_ASYNC_FALLBACK;
  });

  test("defineWorkersProject prefers scoped env over direct env for promise nested async workers function", async () => {
    process.env.PROJECT_PROMISE_NESTED_ASYNC_SCOPED_PRECEDENCE =
      "\"project-promise-nested-async-direct-value\"";
    process.env.RSTEST_INJECT_PROJECT_PROMISE_NESTED_ASYNC_SCOPED_PRECEDENCE =
      "\"project-promise-nested-async-scoped-value\"";

    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: async ({ inject }: WorkerPoolOptionsContext) => ({
              main: "./src/project-promise-nested-async-scoped-precedence-entry.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_NESTED_ASYNC_SCOPED_PRECEDENCE: inject<string>(
                    "PROJECT_PROMISE_NESTED_ASYNC_SCOPED_PRECEDENCE"
                  )
                }
              }
            })
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-nested-async-scoped-value");
    expect(String(defineValue)).not.toContain("project-promise-nested-async-direct-value");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_NESTED_ASYNC_SCOPED_PRECEDENCE;
    delete process.env.PROJECT_PROMISE_NESTED_ASYNC_SCOPED_PRECEDENCE;
  });

  test("defineWorkersProject supports direct env fallback for promise nested thenable workers function", async () => {
    process.env.PROJECT_PROMISE_NESTED_THENABLE_FALLBACK =
      "\"project-promise-nested-thenable-fallback\"";

    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: ({ inject }: WorkerPoolOptionsContext) => {
              const resolvedValue = {
                main: "./src/project-promise-nested-thenable-fallback-entry.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_NESTED_THENABLE_FALLBACK: inject<string>(
                      "PROJECT_PROMISE_NESTED_THENABLE_FALLBACK"
                    )
                  }
                }
              };
              return {
                then(resolve: (resolved: typeof resolvedValue) => void) {
                  resolve(resolvedValue);
                  return Promise.resolve(resolvedValue);
                }
              } as unknown as PromiseLike<typeof resolvedValue>;
            }
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-nested-thenable-fallback");

    delete process.env.PROJECT_PROMISE_NESTED_THENABLE_FALLBACK;
  });

  test("defineWorkersProject prefers scoped env over direct env for promise nested thenable workers function", async () => {
    process.env.PROJECT_PROMISE_NESTED_THENABLE_SCOPED_PRECEDENCE =
      "\"project-promise-nested-thenable-direct-value\"";
    process.env.RSTEST_INJECT_PROJECT_PROMISE_NESTED_THENABLE_SCOPED_PRECEDENCE =
      "\"project-promise-nested-thenable-scoped-value\"";

    const value = defineWorkersProject(
      Promise.resolve({
        test: {
          poolOptions: {
            workers: ({ inject }: WorkerPoolOptionsContext) => {
              const resolvedValue = {
                main: "./src/project-promise-nested-thenable-scoped-precedence-entry.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_NESTED_THENABLE_SCOPED_PRECEDENCE: inject<string>(
                      "PROJECT_PROMISE_NESTED_THENABLE_SCOPED_PRECEDENCE"
                    )
                  }
                }
              };
              return {
                then(resolve: (resolved: typeof resolvedValue) => void) {
                  resolve(resolvedValue);
                  return Promise.resolve(resolvedValue);
                }
              } as unknown as PromiseLike<typeof resolvedValue>;
            }
          }
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-nested-thenable-scoped-value");
    expect(String(defineValue)).not.toContain("project-promise-nested-thenable-direct-value");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_NESTED_THENABLE_SCOPED_PRECEDENCE;
    delete process.env.PROJECT_PROMISE_NESTED_THENABLE_SCOPED_PRECEDENCE;
  });

  test("defineWorkersProject supports promise exports with top-level workers function", async () => {
    process.env.RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL = "\"project-promise-top-level\"";

    const value = defineWorkersProject(
      Promise.resolve({
        workers: ({ inject }: WorkerPoolOptionsContext) => ({
          main: "./src/project-promise-top-level-entry.ts",
          miniflare: {
            bindings: {
              PROJECT_PROMISE_TOP_LEVEL: inject<string>("PROJECT_PROMISE_TOP_LEVEL")
            }
          }
        }),
        include: ["test/project-promise-top-level/**/*.test.ts"]
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    expect(resolved.include).toEqual(["test/project-promise-top-level/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-top-level");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL;
  });

  test("defineWorkersProject supports promise exports with async top-level workers function", async () => {
    process.env.RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL_ASYNC = "\"project-promise-top-level-async\"";

    const value = defineWorkersProject(
      Promise.resolve({
        workers: async ({ inject }: WorkerPoolOptionsContext) => ({
          main: "./src/project-promise-top-level-async-entry.ts",
          miniflare: {
            bindings: {
              PROJECT_PROMISE_TOP_LEVEL_ASYNC: inject<string>("PROJECT_PROMISE_TOP_LEVEL_ASYNC")
            }
          }
        }),
        include: ["test/project-promise-top-level-async/**/*.test.ts"]
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    expect(resolved.include).toEqual(["test/project-promise-top-level-async/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-top-level-async");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL_ASYNC;
  });

  test("defineWorkersProject supports promise exports with top-level thenable workers function", async () => {
    process.env.RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL_THENABLE = "\"project-promise-top-level-thenable\"";

    const value = defineWorkersProject(
      Promise.resolve({
        workers: ({ inject }: WorkerPoolOptionsContext) => {
          const resolvedValue = {
            main: "./src/project-promise-top-level-thenable-entry.ts",
            miniflare: {
              bindings: {
                PROJECT_PROMISE_TOP_LEVEL_THENABLE: inject<string>(
                  "PROJECT_PROMISE_TOP_LEVEL_THENABLE"
                )
              }
            }
          };
          return {
            then(resolve: (resolved: typeof resolvedValue) => void) {
              resolve(resolvedValue);
              return Promise.resolve(resolvedValue);
            }
          } as unknown as PromiseLike<typeof resolvedValue>;
        },
        include: ["test/project-promise-top-level-thenable/**/*.test.ts"]
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    expect(resolved.include).toEqual(["test/project-promise-top-level-thenable/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-top-level-thenable");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL_THENABLE;
  });

  test("defineWorkersProject supports direct env fallback for promise top-level thenable workers function", async () => {
    process.env.PROJECT_PROMISE_TOP_LEVEL_THENABLE_FALLBACK =
      "\"project-promise-top-level-thenable-fallback\"";

    const value = defineWorkersProject(
      Promise.resolve({
        workers: ({ inject }: WorkerPoolOptionsContext) => {
          const resolvedValue = {
            main: "./src/project-promise-top-level-thenable-fallback-entry.ts",
            miniflare: {
              bindings: {
                PROJECT_PROMISE_TOP_LEVEL_THENABLE_FALLBACK: inject<string>(
                  "PROJECT_PROMISE_TOP_LEVEL_THENABLE_FALLBACK"
                )
              }
            }
          };
          return {
            then(resolve: (resolved: typeof resolvedValue) => void) {
              resolve(resolvedValue);
              return Promise.resolve(resolvedValue);
            }
          } as unknown as PromiseLike<typeof resolvedValue>;
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-top-level-thenable-fallback");

    delete process.env.PROJECT_PROMISE_TOP_LEVEL_THENABLE_FALLBACK;
  });

  test("defineWorkersProject prefers scoped env over direct env for promise top-level thenable workers function", async () => {
    process.env.PROJECT_PROMISE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE =
      "\"project-promise-top-level-thenable-direct-value\"";
    process.env.RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE =
      "\"project-promise-top-level-thenable-scoped-value\"";

    const value = defineWorkersProject(
      Promise.resolve({
        workers: ({ inject }: WorkerPoolOptionsContext) => {
          const resolvedValue = {
            main: "./src/project-promise-top-level-thenable-scoped-precedence-entry.ts",
            miniflare: {
              bindings: {
                PROJECT_PROMISE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE: inject<string>(
                  "PROJECT_PROMISE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE"
                )
              }
            }
          };
          return {
            then(resolve: (resolved: typeof resolvedValue) => void) {
              resolve(resolvedValue);
              return Promise.resolve(resolvedValue);
            }
          } as unknown as PromiseLike<typeof resolvedValue>;
        }
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-top-level-thenable-scoped-value");
    expect(String(defineValue)).not.toContain("project-promise-top-level-thenable-direct-value");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE;
    delete process.env.PROJECT_PROMISE_TOP_LEVEL_THENABLE_SCOPED_PRECEDENCE;
  });

  test("defineWorkersProject supports direct env fallback for promise async top-level workers function", async () => {
    process.env.PROJECT_PROMISE_TOP_LEVEL_ASYNC_FALLBACK =
      "\"project-promise-top-level-async-fallback\"";

    const value = defineWorkersProject(
      Promise.resolve({
        workers: async ({ inject }: WorkerPoolOptionsContext) => ({
          main: "./src/project-promise-top-level-async-fallback-entry.ts",
          miniflare: {
            bindings: {
              PROJECT_PROMISE_TOP_LEVEL_ASYNC_FALLBACK: inject<string>(
                "PROJECT_PROMISE_TOP_LEVEL_ASYNC_FALLBACK"
              )
            }
          }
        })
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-top-level-async-fallback");

    delete process.env.PROJECT_PROMISE_TOP_LEVEL_ASYNC_FALLBACK;
  });

  test("defineWorkersProject prefers scoped env over direct env for promise async top-level workers function", async () => {
    process.env.PROJECT_PROMISE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE =
      "\"project-promise-top-level-async-direct-value\"";
    process.env.RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE =
      "\"project-promise-top-level-async-scoped-value\"";

    const value = defineWorkersProject(
      Promise.resolve({
        workers: async ({ inject }: WorkerPoolOptionsContext) => ({
          main: "./src/project-promise-top-level-async-scoped-precedence-entry.ts",
          miniflare: {
            bindings: {
              PROJECT_PROMISE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE: inject<string>(
                "PROJECT_PROMISE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE"
              )
            }
          }
        })
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-top-level-async-scoped-value");
    expect(String(defineValue)).not.toContain("project-promise-top-level-async-direct-value");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE;
    delete process.env.PROJECT_PROMISE_TOP_LEVEL_ASYNC_SCOPED_PRECEDENCE;
  });

  test("defineWorkersProject supports direct env fallback for promise top-level workers function", async () => {
    process.env.PROJECT_PROMISE_TOP_LEVEL_DIRECT_FALLBACK =
      "\"project-promise-top-level-direct-fallback\"";

    const value = defineWorkersProject(
      Promise.resolve({
        workers: ({ inject }: WorkerPoolOptionsContext) => ({
          main: "./src/project-promise-top-level-direct-entry.ts",
          miniflare: {
            bindings: {
              PROJECT_PROMISE_TOP_LEVEL_DIRECT_FALLBACK: inject<string>(
                "PROJECT_PROMISE_TOP_LEVEL_DIRECT_FALLBACK"
              )
            }
          }
        })
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-top-level-direct-fallback");

    delete process.env.PROJECT_PROMISE_TOP_LEVEL_DIRECT_FALLBACK;
  });

  test("defineWorkersProject prefers scoped env over direct env for promise top-level workers function", async () => {
    process.env.PROJECT_PROMISE_TOP_LEVEL_SCOPED_PRECEDENCE =
      "\"project-promise-top-level-direct-value\"";
    process.env.RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL_SCOPED_PRECEDENCE =
      "\"project-promise-top-level-scoped-value\"";

    const value = defineWorkersProject(
      Promise.resolve({
        workers: ({ inject }: WorkerPoolOptionsContext) => ({
          main: "./src/project-promise-top-level-scoped-precedence-entry.ts",
          miniflare: {
            bindings: {
              PROJECT_PROMISE_TOP_LEVEL_SCOPED_PRECEDENCE: inject<string>(
                "PROJECT_PROMISE_TOP_LEVEL_SCOPED_PRECEDENCE"
              )
            }
          }
        })
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-top-level-scoped-value");
    expect(String(defineValue)).not.toContain("project-promise-top-level-direct-value");

    delete process.env.RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL_SCOPED_PRECEDENCE;
    delete process.env.PROJECT_PROMISE_TOP_LEVEL_SCOPED_PRECEDENCE;
  });

  test("defineWorkersProject supports async config and async workers options", async () => {
    process.env.RSTEST_INJECT_PROJECT_URL = "\"http://localhost:9555\"";

    const configFactory = defineWorkersProject(async () => ({
      test: {
        poolOptions: {
          workers: async ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/project-worker.ts",
            miniflare: {
              bindings: {
                PROJECT_URL: inject<string>("PROJECT_URL")
              }
            }
          })
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await configFactory();
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("http://localhost:9555");

    delete process.env.RSTEST_INJECT_PROJECT_URL;
  });

  test("defineWorkersProject supports thenable workers option function in async config export", async () => {
    process.env.RSTEST_INJECT_PROJECT_THENABLE_URL = "\"http://localhost:9666\"";

    const configFactory = defineWorkersProject(async () => ({
      test: {
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => {
            const resolvedValue = {
              main: "./src/project-worker.ts",
              miniflare: {
                bindings: {
                  PROJECT_THENABLE_URL: inject<string>("PROJECT_THENABLE_URL")
                }
              }
            };
            return {
              then(resolve: (resolved: typeof resolvedValue) => void) {
                resolve(resolvedValue);
                return Promise.resolve(resolvedValue);
              }
            } as unknown as PromiseLike<typeof resolvedValue>;
          }
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await configFactory();
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("http://localhost:9666");

    delete process.env.RSTEST_INJECT_PROJECT_THENABLE_URL;
  });

  test("defineWorkersProject forwards async config function arguments", async () => {
    const configFactory = defineWorkersProject(async (...args: unknown[]) => {
      const context = args[0] as { mode?: string } | undefined;
      return {
      workers: {
        main: "./src/project-async-forwarding.ts",
        miniflare: {
          bindings: {
            PROJECT_MODE: context?.mode ?? "unknown"
          }
        }
      }
      };
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await configFactory({ mode: "test" });
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("test");
    expect(String(defineValue)).toContain("project-async-forwarding.ts");
  });

  test("defineWorkersProject preserves this binding for async config function exports", async () => {
    const configFactory = defineWorkersProject(async function (this: { mode?: string }) {
      return {
        workers: {
          main: "./src/project-async-this.ts",
          miniflare: {
            bindings: {
              PROJECT_MODE: this.mode ?? "unknown"
            }
          }
        }
      };
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await configFactory.call({ mode: "async-this" });
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("async-this");
    expect(String(defineValue)).toContain("project-async-this.ts");
  });

  test("defineWorkersProject propagates rejection for async config function exports", async () => {
    const errorMessage = "project async config function rejection";
    const configFactory = defineWorkersProject(async () => {
      throw new Error(errorMessage);
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    await expect(configFactory()).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates rejection for async config function exports with invalid nested workers options", async () => {
    const configFactory = defineWorkersProject(async () => ({
      test: {
        poolOptions: {
          workers: [] as unknown as WorkersPoolOptions
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers: expected an object but received array."
    );
  });

  test("defineWorkersProject propagates rejection for async config function exports when nested workers function returns invalid options", async () => {
    const configFactory = defineWorkersProject(async () => ({
      test: {
        poolOptions: {
          workers: () => [] as unknown as WorkersPoolOptions
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
    );
  });

  test("defineWorkersProject propagates rejection for async config function exports when nested workers function returns string", async () => {
    const configFactory = defineWorkersProject(async () => ({
      test: {
        poolOptions: {
          workers: () => "invalid-workers-options" as unknown as WorkersPoolOptions
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
    );
  });

  test("defineWorkersProject propagates rejection for async config function exports when nested workers function returns boolean", async () => {
    const configFactory = defineWorkersProject(async () => ({
      test: {
        poolOptions: {
          workers: () => false as unknown as WorkersPoolOptions
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
    );
  });

  test("defineWorkersProject propagates rejection for async config function exports when top-level workers function returns invalid options", async () => {
    const configFactory = defineWorkersProject(async () => ({
      workers: () => null as unknown as WorkersPoolOptions
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received null."
    );
  });

  test("defineWorkersProject propagates rejection for async config function exports when top-level workers function returns undefined", async () => {
    const configFactory = defineWorkersProject(async () => ({
      workers: () => undefined as unknown as WorkersPoolOptions
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received undefined."
    );
  });

  test("defineWorkersProject propagates rejection for async config function exports when top-level workers function returns boolean", async () => {
    const configFactory = defineWorkersProject(async () => ({
      workers: () => false as unknown as WorkersPoolOptions
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received boolean."
    );
  });

  test("defineWorkersProject forwards arguments when config function returns a promise", async () => {
    const configFactory = defineWorkersProject((...args: unknown[]) => {
      const context = args[0] as { mode?: string } | undefined;
      return Promise.resolve({
        workers: {
          main: "./src/project-promise-forwarding.ts",
          miniflare: {
            bindings: {
              PROJECT_MODE: context?.mode ?? "unknown"
            }
          }
        }
      });
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    const resolved = await configFactory({ mode: "serve" });
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("serve");
    expect(String(defineValue)).toContain("project-promise-forwarding.ts");
  });

  test("defineWorkersProject propagates thrown errors for sync config function exports", async () => {
    const errorMessage = "project sync config function throw";
    const configFactory = defineWorkersProject(() => {
      throw new Error(errorMessage);
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    expect(() => configFactory()).toThrow(errorMessage);
  });

  test("defineWorkersProject throws actionable error for sync config function exports with invalid top-level workers options", () => {
    const configFactory = defineWorkersProject(() => ({
      workers: "invalid-workers-options" as unknown as WorkersPoolOptions
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    expect(() => configFactory()).toThrow(
      "Invalid workers options from workers: expected an object but received string."
    );
  });

  test("defineWorkersProject throws actionable error for sync config function exports when top-level workers function returns invalid options", () => {
    const configFactory = defineWorkersProject(() => ({
      workers: () => null as unknown as WorkersPoolOptions
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    expect(() => configFactory()).toThrow(
      "Invalid workers options from workers() return value: expected an object but received null."
    );
  });

  test("defineWorkersProject throws actionable error for sync config function exports when top-level workers function returns undefined", () => {
    const configFactory = defineWorkersProject(() => ({
      workers: () => undefined as unknown as WorkersPoolOptions
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    expect(() => configFactory()).toThrow(
      "Invalid workers options from workers() return value: expected an object but received undefined."
    );
  });

  test("defineWorkersProject throws actionable error for sync config function exports when top-level workers function returns boolean", () => {
    const configFactory = defineWorkersProject(() => ({
      workers: () => false as unknown as WorkersPoolOptions
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    expect(() => configFactory()).toThrow(
      "Invalid workers options from workers() return value: expected an object but received boolean."
    );
  });

  test("defineWorkersProject throws actionable error for sync config function exports when nested workers function returns invalid options", () => {
    const configFactory = defineWorkersProject(() => ({
      test: {
        poolOptions: {
          workers: () => [] as unknown as WorkersPoolOptions
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    expect(() => configFactory()).toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
    );
  });

  test("defineWorkersProject throws actionable error for sync config function exports when nested workers function returns string", () => {
    const configFactory = defineWorkersProject(() => ({
      test: {
        poolOptions: {
          workers: () => "invalid-workers-options" as unknown as WorkersPoolOptions
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    expect(() => configFactory()).toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
    );
  });

  test("defineWorkersProject throws actionable error for sync config function exports when nested workers function returns boolean", () => {
    const configFactory = defineWorkersProject(() => ({
      test: {
        poolOptions: {
          workers: () => false as unknown as WorkersPoolOptions
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    expect(() => configFactory()).toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
    );
  });

  test("defineWorkersProject propagates rejection for promise-returning config function exports", async () => {
    const errorMessage = "project promise config function rejection";
    const configFactory = defineWorkersProject(() => Promise.reject(new Error(errorMessage)));

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    await expect(configFactory()).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates rejection for promise-returning config function exports with invalid top-level workers options", async () => {
    const configFactory = defineWorkersProject(() =>
      Promise.resolve({
        workers: null as unknown as WorkersPoolOptions
      })
    );

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers: expected an object but received null."
    );
  });

  test("defineWorkersProject propagates rejection for promise-returning config function exports when top-level workers function returns invalid options", async () => {
    const configFactory = defineWorkersProject(() =>
      Promise.resolve({
        workers: () => null as unknown as WorkersPoolOptions
      })
    );

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received null."
    );
  });

  test("defineWorkersProject propagates rejection for promise-returning config function exports when top-level workers function returns undefined", async () => {
    const configFactory = defineWorkersProject(() =>
      Promise.resolve({
        workers: () => undefined as unknown as WorkersPoolOptions
      })
    );

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received undefined."
    );
  });

  test("defineWorkersProject propagates rejection for promise-returning config function exports when top-level workers function returns boolean", async () => {
    const configFactory = defineWorkersProject(() =>
      Promise.resolve({
        workers: () => false as unknown as WorkersPoolOptions
      })
    );

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received boolean."
    );
  });

  test("defineWorkersProject propagates rejection for promise-returning config function exports when nested workers function returns invalid options", async () => {
    const configFactory = defineWorkersProject(() =>
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () => [] as unknown as WorkersPoolOptions
          }
        }
      })
    );

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
    );
  });

  test("defineWorkersProject propagates rejection for promise-returning config function exports when nested workers function returns string", async () => {
    const configFactory = defineWorkersProject(() =>
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () => "invalid-workers-options" as unknown as WorkersPoolOptions
          }
        }
      })
    );

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
    );
  });

  test("defineWorkersProject propagates rejection for promise-returning config function exports when nested workers function returns boolean", async () => {
    const configFactory = defineWorkersProject(() =>
      Promise.resolve({
        test: {
          poolOptions: {
            workers: () => false as unknown as WorkersPoolOptions
          }
        }
      })
    );

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
    );
  });

  test("defineWorkersProject supports config functions returning thenables", async () => {
    const configFactory = defineWorkersProject((...args: unknown[]) => {
      const context = args[0] as { mode?: string } | undefined;
      const value = {
        workers: {
          main: "./src/project-thenable.ts",
          miniflare: {
            bindings: {
              PROJECT_MODE: context?.mode ?? "unknown"
            }
          }
        }
      };

      const thenable = {
        then(resolve: (config: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;

      return thenable;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    const resolved = await configFactory({ mode: "project-thenable" });
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-thenable");
    expect(String(defineValue)).toContain("project-thenable.ts");
  });

  test("defineWorkersProject propagates rejection for thenable-returning config function exports", async () => {
    const errorMessage = "project thenable config function rejection";
    const configFactory = defineWorkersProject(() => {
      const value = {
        workers: {
          main: "./src/project-thenable-config-rejection.ts"
        } satisfies WorkersPoolOptions
      };
      return {
        then(
          onfulfilled?:
            | ((resolved: typeof value) => unknown)
            | null,
          onrejected?: ((reason: unknown) => unknown) | null
        ) {
          return Promise.reject(new Error(errorMessage)).then(
            onfulfilled as ((value: never) => unknown) | undefined,
            onrejected as ((reason: unknown) => unknown) | undefined
          );
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    await expect(configFactory()).rejects.toThrow(errorMessage);
  });

  test("defineWorkersProject propagates rejection for thenable-returning config function exports with invalid nested workers options", async () => {
    const configFactory = defineWorkersProject(() => {
      const value = {
        test: {
          poolOptions: {
            workers: [] as unknown as WorkersPoolOptions
          }
        }
      };
      return {
        then(resolve: (resolved: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers: expected an object but received array."
    );
  });

  test("defineWorkersProject propagates rejection for thenable-returning config function exports when nested workers function returns invalid options", async () => {
    const configFactory = defineWorkersProject(() => {
      const value = {
        test: {
          poolOptions: {
            workers: () => [] as unknown as WorkersPoolOptions
          }
        }
      };
      return {
        then(resolve: (resolved: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
    );
  });

  test("defineWorkersProject propagates rejection for thenable-returning config function exports when nested workers function returns string", async () => {
    const configFactory = defineWorkersProject(() => {
      const value = {
        test: {
          poolOptions: {
            workers: () => "invalid-workers-options" as unknown as WorkersPoolOptions
          }
        }
      };
      return {
        then(resolve: (resolved: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
    );
  });

  test("defineWorkersProject propagates rejection for thenable-returning config function exports when nested workers function returns boolean", async () => {
    const configFactory = defineWorkersProject(() => {
      const value = {
        test: {
          poolOptions: {
            workers: () => false as unknown as WorkersPoolOptions
          }
        }
      };
      return {
        then(resolve: (resolved: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
    );
  });

  test("defineWorkersProject propagates rejection for thenable-returning config function exports when top-level workers function returns invalid options", async () => {
    const configFactory = defineWorkersProject(() => {
      const value = {
        workers: () => null as unknown as WorkersPoolOptions
      };
      return {
        then(resolve: (resolved: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received null."
    );
  });

  test("defineWorkersProject propagates rejection for thenable-returning config function exports when top-level workers function returns undefined", async () => {
    const configFactory = defineWorkersProject(() => {
      const value = {
        workers: () => undefined as unknown as WorkersPoolOptions
      };
      return {
        then(resolve: (resolved: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received undefined."
    );
  });

  test("defineWorkersProject propagates rejection for thenable-returning config function exports when top-level workers function returns boolean", async () => {
    const configFactory = defineWorkersProject(() => {
      const value = {
        workers: () => false as unknown as WorkersPoolOptions
      };
      return {
        then(resolve: (resolved: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    await expect(configFactory()).rejects.toThrow(
      "Invalid workers options from workers() return value: expected an object but received boolean."
    );
  });

  test("defineWorkersProject forwards arguments for thenable-returning config function exports", async () => {
    const configFactory = defineWorkersProject((...args: unknown[]) => {
      const context = args[0] as { mode?: string } | undefined;
      const value = {
        workers: {
          main: "./src/project-thenable-forwarding.ts",
          miniflare: {
            bindings: {
              PROJECT_MODE: context?.mode ?? "unknown"
            }
          }
        }
      };

      return {
        then(resolve: (config: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    const resolved = await configFactory({ mode: "project-thenable-forwarding" });
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-thenable-forwarding");
    expect(String(defineValue)).toContain("project-thenable-forwarding.ts");
  });

  test("defineWorkersProject preserves this binding for thenable-returning config function exports", async () => {
    const configFactory = defineWorkersProject(function (this: { mode?: string }) {
      const value = {
        workers: {
          main: "./src/project-thenable-this.ts",
          miniflare: {
            bindings: {
              PROJECT_MODE: this.mode ?? "unknown"
            }
          }
        }
      };

      return {
        then(resolve: (config: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    const resolved = await configFactory.call({ mode: "project-thenable-this" });
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-thenable-this");
    expect(String(defineValue)).toContain("project-thenable-this.ts");
  });

  test("defineWorkersProject dedupes workers plugin when config functions return thenables", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const configFactory = defineWorkersProject(() => {
      const value = {
        plugins: [existingPlugin],
        workers: {
          main: "./src/project-thenable.ts"
        }
      };
      return {
        then(resolve: (config: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    const resolved = await configFactory();
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins).toHaveLength(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("defineWorkersProject dedupes workers plugin for thenable config function exports when plugins is single value", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const configFactory = defineWorkersProject(() => {
      const value = {
        plugins: existingPlugin as unknown as any,
        workers: {
          main: "./src/project-thenable-single-plugin.ts"
        }
      };
      return {
        then(resolve: (config: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    const resolved = await configFactory();
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins).toHaveLength(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("defineWorkersProject keeps falsey plugin entries while deduping thenable config function exports", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const configFactory = defineWorkersProject(() => {
      const value = {
        plugins: [false as unknown as any, existingPlugin],
        workers: {
          main: "./src/project-thenable-falsey-plugin.ts"
        }
      };
      return {
        then(resolve: (config: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>;
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    const resolved = await configFactory();
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins).toContain(false);
    const names = plugins
      .map((plugin) =>
        typeof plugin === "object" && plugin !== null && "name" in plugin
          ? String((plugin as { name?: unknown }).name)
          : ""
      )
      .filter(Boolean);
    expect(names.filter((name) => name === WORKERS_RSBUILD_PLUGIN_NAME)).toHaveLength(1);
  });

  test("defineWorkersProject preserves this binding for promise-returning config function exports", async () => {
    const configFactory = defineWorkersProject(function (this: { mode?: string }) {
      return Promise.resolve({
        workers: {
          main: "./src/project-promise-this.ts",
          miniflare: {
            bindings: {
              PROJECT_MODE: this.mode ?? "unknown"
            }
          }
        }
      });
    });

    if (typeof configFactory !== "function") {
      throw new Error("Expected config function export");
    }

    const resolved = await configFactory.call({ mode: "project-promise-this" });
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-promise-this");
    expect(String(defineValue)).toContain("project-promise-this.ts");
  });

  test("defineWorkersProject deduplicates existing workers plugin", () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const value = defineWorkersProject({
      plugins: [existingPlugin],
      workers: {
        main: "./src/project-worker.ts"
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

  test("defineWorkersProject keeps falsey plugin entries while deduping in sync config path", () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const value = defineWorkersProject({
      plugins: [false as unknown as any, existingPlugin],
      workers: {
        main: "./src/project-worker.ts"
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
    expect(plugins).toContain(false);
    const names = plugins
      .map((plugin) =>
        typeof plugin === "object" && plugin !== null && "name" in plugin
          ? String((plugin as { name?: unknown }).name)
          : ""
      )
      .filter(Boolean);
    expect(names.filter((name) => name === WORKERS_RSBUILD_PLUGIN_NAME)).toHaveLength(1);
  });

  test("defineWorkersProject deduplicates workers plugin in async config path", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const configFactory = defineWorkersProject(async () => ({
      plugins: [existingPlugin],
      workers: {
        main: "./src/project-worker.ts"
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await configFactory();
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins.length).toBe(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("defineWorkersProject keeps falsey plugin entries while deduping in async config path", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const configFactory = defineWorkersProject(async () => ({
      plugins: [false as unknown as any, existingPlugin],
      workers: {
        main: "./src/project-worker.ts"
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await configFactory();
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins).toContain(false);
    const names = plugins
      .map((plugin) =>
        typeof plugin === "object" && plugin !== null && "name" in plugin
          ? String((plugin as { name?: unknown }).name)
          : ""
      )
      .filter(Boolean);
    expect(names.filter((name) => name === WORKERS_RSBUILD_PLUGIN_NAME)).toHaveLength(1);
  });

  test("defineWorkersProject deduplicates workers plugin in async config path when plugins is single value", async () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const configFactory = defineWorkersProject(async () => ({
      plugins: existingPlugin as unknown as any,
      workers: {
        main: "./src/project-worker.ts"
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await configFactory();
    const plugins = Array.isArray(resolved.plugins)
      ? resolved.plugins
      : resolved.plugins
        ? [resolved.plugins]
        : [];
    expect(plugins.length).toBe(1);
    expect((plugins[0] as { name?: string } | undefined)?.name).toBe(
      WORKERS_RSBUILD_PLUGIN_NAME
    );
  });

  test("defineWorkersProject deduplicates workers plugin when plugins is single value", () => {
    const existingPlugin = {
      name: WORKERS_RSBUILD_PLUGIN_NAME,
      setup() {}
    };

    const value = defineWorkersProject({
      plugins: existingPlugin as unknown as any,
      workers: {
        main: "./src/project-worker.ts"
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

  test("defineWorkersProject supports direct env fallback for inject()", async () => {
    process.env.PROJECT_FALLBACK_VALUE = "\"from-project-fallback\"";

    const configFactory = defineWorkersProject(async () => ({
      test: {
        poolOptions: {
          workers: async ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/project-worker.ts",
            miniflare: {
              bindings: {
                PROJECT_FALLBACK_VALUE: inject<string>("PROJECT_FALLBACK_VALUE")
              }
            }
          })
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await configFactory();
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("from-project-fallback");

    delete process.env.PROJECT_FALLBACK_VALUE;
  });

  test("defineWorkersProject supports sync function-valued workers options with inject()", () => {
    process.env.RSTEST_INJECT_PROJECT_SYNC_VALUE = "\"project-sync-value\"";

    const value = defineWorkersProject({
      test: {
        poolOptions: {
          workers: ({ inject }: WorkerPoolOptionsContext) => ({
            main: "./src/project-worker.ts",
            miniflare: {
              bindings: {
                PROJECT_SYNC_VALUE: inject<string>("PROJECT_SYNC_VALUE")
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
    expect(String(defineValue)).toContain("project-sync-value");

    delete process.env.RSTEST_INJECT_PROJECT_SYNC_VALUE;
  });

  test("defineWorkersProject supports top-level workers function with inject()", () => {
    process.env.RSTEST_INJECT_PROJECT_TOP_LEVEL_VALUE = "\"project-top-level-value\"";

    const value = defineWorkersProject({
      workers: ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/project-top-level-worker.ts",
        miniflare: {
          bindings: {
            PROJECT_TOP_LEVEL_VALUE: inject<string>("PROJECT_TOP_LEVEL_VALUE")
          }
        }
      }),
      include: ["test/project-top-level/**/*.test.ts"]
    });

    if (value instanceof Promise || typeof value === "function") {
      throw new Error("Expected sync config export");
    }

    expect(value.include).toEqual(["test/project-top-level/**/*.test.ts"]);
    const defineValue = value.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-top-level-value");

    delete process.env.RSTEST_INJECT_PROJECT_TOP_LEVEL_VALUE;
  });

  test("defineWorkersProject resolves relative workers.main in promise top-level workers function", async () => {
    const value = defineWorkersProject(
      Promise.resolve({
        workers: () => ({
          main: "./fixtures/project-worker-main.ts"
        })
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    const parsed = JSON.parse(JSON.parse(String(defineValue))) as { main?: string };
    expect(parsed.main).toBe(
      path.resolve(process.cwd(), "test", "fixtures", "project-worker-main.ts")
    );
  });

  test("defineWorkersProject resolves relative wrangler.configPath from caller directory", () => {
    const value = defineWorkersProject({
      workers: ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/project-top-level-worker.ts",
        wrangler: {
          configPath: inject<string>("PROJECT_WRANGLER_CONFIG_PATH") ?? "./fixtures/project-wrangler.jsonc"
        }
      })
    });

    if (value instanceof Promise || typeof value === "function") {
      throw new Error("Expected sync config export");
    }

    const defineValue = value.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    const parsed = JSON.parse(JSON.parse(String(defineValue))) as {
      wrangler?: { configPath?: string };
    };
    expect(parsed.wrangler?.configPath).toBe(
      path.resolve(process.cwd(), "test", "fixtures", "project-wrangler.jsonc")
    );
  });

  test("defineWorkersProject resolves relative wrangler.configPath in promise top-level workers function", async () => {
    const value = defineWorkersProject(
      Promise.resolve({
        workers: () => ({
          main: "./src/project-promise-worker.ts",
          wrangler: {
            configPath: "./fixtures/project-promise-wrangler.jsonc"
          }
        })
      })
    );

    if (!(value instanceof Promise)) {
      throw new Error("Expected promise config export");
    }

    const resolved = await value;
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    const parsed = JSON.parse(JSON.parse(String(defineValue))) as {
      wrangler?: { configPath?: string };
    };
    expect(parsed.wrangler?.configPath).toBe(
      path.resolve(process.cwd(), "test", "fixtures", "project-promise-wrangler.jsonc")
    );
  });

  test("defineWorkersProject supports async top-level workers function in async config export", async () => {
    process.env.RSTEST_INJECT_PROJECT_TOP_LEVEL_ASYNC = "\"project-top-level-async\"";

    const configFactory = defineWorkersProject(async () => ({
      include: ["test/project-top-level-async/**/*.test.ts"],
      workers: async ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/project-top-level-async-worker.ts",
        miniflare: {
          bindings: {
            PROJECT_TOP_LEVEL_ASYNC: inject<string>("PROJECT_TOP_LEVEL_ASYNC")
          }
        }
      })
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await configFactory();
    expect(resolved.include).toEqual(["test/project-top-level-async/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-top-level-async");

    delete process.env.RSTEST_INJECT_PROJECT_TOP_LEVEL_ASYNC;
  });

  test("defineWorkersProject supports async top-level thenable workers function in async config export", async () => {
    process.env.RSTEST_INJECT_PROJECT_TOP_LEVEL_THENABLE = "\"project-top-level-thenable\"";

    const value = defineWorkersProject(async () => ({
      include: ["test/project/top-level-thenable/**/*.test.ts"],
      workers: ({ inject }: WorkerPoolOptionsContext) => {
        const resolvedValue = {
          main: "./src/project-worker.ts",
          miniflare: {
            bindings: {
              PROJECT_TOP_LEVEL_THENABLE: inject<string>("PROJECT_TOP_LEVEL_THENABLE")
            }
          }
        };
        return {
          then(resolve: (resolved: typeof resolvedValue) => void) {
            resolve(resolvedValue);
            return Promise.resolve(resolvedValue);
          }
        } as unknown as PromiseLike<typeof resolvedValue>;
      }
    }));

    if (typeof value !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await value();
    expect(resolved.include).toEqual(["test/project/top-level-thenable/**/*.test.ts"]);
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-top-level-thenable");

    delete process.env.RSTEST_INJECT_PROJECT_TOP_LEVEL_THENABLE;
  });

  test("defineWorkersProject does not evaluate nested workers function in async config export when top-level async function exists", async () => {
    const configFactory = defineWorkersProject(async () => ({
      workers: async () => ({
        main: "./src/project-async-top-level-function-precedence.ts",
        miniflare: {
          bindings: {
            PROJECT_ASYNC_TOP_LEVEL_FUNCTION_PRECEDENCE: "project-async-top-level-function"
          }
        }
      }),
      test: {
        poolOptions: {
          workers: () => {
            throw new Error("project nested async-config workers function should not execute");
          }
        }
      }
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await configFactory();
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-async-top-level-function-precedence.ts");
    expect(String(defineValue)).toContain("project-async-top-level-function");
  });

  test("defineWorkersProject supports direct env fallback for async top-level workers function", async () => {
    process.env.PROJECT_TOP_LEVEL_ASYNC_FALLBACK = "\"project-top-level-async-fallback\"";

    const configFactory = defineWorkersProject(async () => ({
      workers: async ({ inject }: WorkerPoolOptionsContext) => ({
        main: "./src/project-top-level-async-worker.ts",
        miniflare: {
          bindings: {
            PROJECT_TOP_LEVEL_ASYNC_FALLBACK: inject<string>("PROJECT_TOP_LEVEL_ASYNC_FALLBACK")
          }
        }
      })
    }));

    if (typeof configFactory !== "function") {
      throw new Error("Expected async config function export");
    }

    const resolved = await configFactory();
    const defineValue = resolved.source?.define?.__RSTEST_POOL_WORKERS_OPTIONS_JSON__;
    expect(typeof defineValue).toBe("string");
    expect(String(defineValue)).toContain("project-top-level-async-fallback");

    delete process.env.PROJECT_TOP_LEVEL_ASYNC_FALLBACK;
  });

  test("defineWorkersProject throws when async workers options are used in sync config export", () => {
    expect(() =>
      defineWorkersProject({
        test: {
          poolOptions: {
            workers: async ({ inject }: WorkerPoolOptionsContext) => ({
              main: "./src/project-worker.ts",
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
      "Wrap your exported workers config in an async function."
    );
  });

  test("defineWorkersProject throws actionable error when top-level workers options is not an object", () => {
    expect(() =>
      defineWorkersProject({
        workers: "invalid-workers-options" as unknown as WorkersPoolOptions
      })
    ).toThrow(
      "Invalid workers options from workers: expected an object but received string."
    );
  });

  test("defineWorkersProject throws actionable error when nested workers options is not an object", () => {
    expect(() =>
      defineWorkersProject({
        test: {
          poolOptions: {
            workers: false as unknown as WorkersPoolOptions
          }
        }
      })
    ).toThrow(
      "Invalid workers options from test.poolOptions.workers: expected an object but received boolean."
    );
  });

  test("defineWorkersProject throws actionable error when top-level workers options is null", () => {
    expect(() =>
      defineWorkersProject({
        workers: null as unknown as WorkersPoolOptions
      })
    ).toThrow(
      "Invalid workers options from workers: expected an object but received null."
    );
  });

  test("defineWorkersProject throws actionable error when nested workers options is an array", () => {
    expect(() =>
      defineWorkersProject({
        test: {
          poolOptions: {
            workers: [] as unknown as WorkersPoolOptions
          }
        }
      })
    ).toThrow(
      "Invalid workers options from test.poolOptions.workers: expected an object but received array."
    );
  });
});
