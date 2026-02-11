import path from "node:path";
import { describe, expect, test } from "@rstest/core";
import { defineWorkersConfig, defineWorkersProject } from "../src/config/index";
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
      "Wrap your `defineWorkersConfig(...)` call in an async config function."
    );
  });
});
