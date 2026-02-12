import { describe, expect, test } from "@rstest/core";
import type { RstestConfig } from "@rstest/core";
import { mapAnyConfigExport } from "../src/config/types";

describe("mapAnyConfigExport", () => {
  test("maps object config exports", () => {
    const mapped = mapAnyConfigExport(
      (value) => ({
        ...value,
        include: [...(value.include ?? []), "mapped-object.test.ts"]
      }),
      {
        include: ["original-object.test.ts"]
      } satisfies RstestConfig
    );

    if (mapped instanceof Promise || typeof mapped === "function") {
      throw new Error("Expected mapped object export");
    }

    expect(mapped.include).toEqual(["original-object.test.ts", "mapped-object.test.ts"]);
  });

  test("throws when mapper throws for object config exports", () => {
    const errorMessage = "mapper object throw";

    expect(() =>
      mapAnyConfigExport(
        () => {
          throw new Error(errorMessage);
        },
        {
          include: ["original-object.test.ts"]
        } satisfies RstestConfig
      )
    ).toThrow(errorMessage);
  });

  test("maps promise config exports", async () => {
    const mapped = mapAnyConfigExport(
      (value) => ({
        ...value,
        include: [...(value.include ?? []), "mapped-promise.test.ts"]
      }),
      Promise.resolve({
        include: ["original-promise.test.ts"]
      } satisfies RstestConfig)
    );

    if (!(mapped instanceof Promise)) {
      throw new Error("Expected mapped promise export");
    }

    const resolved = await mapped;
    expect(resolved.include).toEqual(["original-promise.test.ts", "mapped-promise.test.ts"]);
  });

  test("propagates mapper throws for promise config exports", async () => {
    const errorMessage = "mapper promise throw";
    const mapped = mapAnyConfigExport(
      () => {
        throw new Error(errorMessage);
      },
      Promise.resolve({
        include: ["base-promise.test.ts"]
      } satisfies RstestConfig)
    );

    if (!(mapped instanceof Promise)) {
      throw new Error("Expected mapped promise export");
    }

    await expect(mapped).rejects.toThrow(errorMessage);
  });

  test("propagates rejection for promise config exports", async () => {
    const errorMessage = "promise export rejection";
    const mapped = mapAnyConfigExport(
      (value) => ({
        ...value,
        include: [...(value.include ?? []), "mapped-should-not-run.test.ts"]
      }),
      Promise.reject(new Error(errorMessage)) as Promise<RstestConfig>
    );

    if (!(mapped instanceof Promise)) {
      throw new Error("Expected mapped rejected promise export");
    }

    await expect(mapped).rejects.toThrow(errorMessage);
  });

  test("maps promise-like config exports", async () => {
    const value = {
      include: ["original-promise-like.test.ts"]
    } satisfies RstestConfig;
    const mapped = mapAnyConfigExport(
      (config) => ({
        ...config,
        include: [...(config.include ?? []), "mapped-promise-like.test.ts"]
      }),
      {
        then(resolve: (resolved: typeof value) => void) {
          resolve(value);
          return Promise.resolve(value);
        }
      } as unknown as PromiseLike<typeof value>
    );

    if (!(mapped instanceof Promise)) {
      throw new Error("Expected mapped promise-like export");
    }

    const resolved = await mapped;
    expect(resolved.include).toEqual([
      "original-promise-like.test.ts",
      "mapped-promise-like.test.ts"
    ]);
  });

  test("propagates mapper throws for promise-like config exports", async () => {
    const errorMessage = "mapper promise-like throw";
    const mapped = mapAnyConfigExport(
      () => {
        throw new Error(errorMessage);
      },
      Promise.resolve({
        include: ["base-promise-like.test.ts"]
      } satisfies RstestConfig) as PromiseLike<RstestConfig>
    );

    if (!(mapped instanceof Promise)) {
      throw new Error("Expected mapped promise-like export");
    }

    await expect(mapped).rejects.toThrow(errorMessage);
  });

  test("propagates rejection for promise-like config exports", async () => {
    const errorMessage = "mapped promise-like rejection";
    const mapped = mapAnyConfigExport(
      (config) => ({
        ...config,
        include: [...(config.include ?? []), "mapped-should-not-run.test.ts"]
      }),
      {
        then(
          _onfulfilled?: ((value: RstestConfig) => unknown) | null,
          onrejected?: ((reason: unknown) => unknown) | null
        ) {
          const error = new Error(errorMessage);
          if (typeof onrejected === "function") {
            onrejected(error);
          }
          return Promise.reject(error);
        }
      } as PromiseLike<RstestConfig>
    );

    if (!(mapped instanceof Promise)) {
      throw new Error("Expected mapped rejected promise-like export");
    }

    await expect(mapped).rejects.toThrow(errorMessage);
  });

  test("forwards config function export arguments through mapper", async () => {
    const mapped = mapAnyConfigExport(
      (value) => ({
        ...value,
        include: [...(value.include ?? []), "mapped-function.test.ts"]
      }),
      (...args: unknown[]) => {
        const context = args[0] as { mode?: string } | undefined;
        const suffix = typeof args[1] === "string" ? args[1] : "none";
        return {
          include: [`${context?.mode ?? "unknown"}-${suffix}`]
        } satisfies RstestConfig;
      }
    );

    if (typeof mapped !== "function") {
      throw new Error("Expected mapped function export");
    }

    const resolved = await mapped({ mode: "test" }, "cli");
    expect(resolved.include).toEqual(["test-cli", "mapped-function.test.ts"]);
  });

  test("preserves this binding for mapped config function exports", async () => {
    const mapped = mapAnyConfigExport(
      (value) => ({
        ...value,
        include: [...(value.include ?? []), "mapped-this.test.ts"]
      }),
      function (this: { mode?: string }) {
        return {
          include: [this.mode ?? "unknown"]
        } satisfies RstestConfig;
      }
    );

    if (typeof mapped !== "function") {
      throw new Error("Expected mapped function export");
    }

    const resolved = await mapped.call({ mode: "this-mode" });
    expect(resolved.include).toEqual(["this-mode", "mapped-this.test.ts"]);
  });

  test("forwards async config function export arguments through mapper", async () => {
    const mapped = mapAnyConfigExport(
      (value) => ({
        ...value,
        include: [...(value.include ?? []), "mapped-async-function.test.ts"]
      }),
      async (...args: unknown[]) => {
        const context = args[0] as { mode?: string } | undefined;
        const suffix = typeof args[1] === "string" ? args[1] : "none";
        return {
          include: [`${context?.mode ?? "unknown"}-${suffix}`]
        } satisfies RstestConfig;
      }
    );

    if (typeof mapped !== "function") {
      throw new Error("Expected mapped async function export");
    }

    const resolved = await mapped({ mode: "serve" }, "watch");
    expect(resolved.include).toEqual(["serve-watch", "mapped-async-function.test.ts"]);
  });

  test("preserves this and arguments for promise-returning mapped config functions", async () => {
    const mapped = mapAnyConfigExport(
      (value) => ({
        ...value,
        include: [...(value.include ?? []), "mapped-promise-function.test.ts"]
      }),
      function (this: { mode?: string }, ...args: unknown[]) {
        const suffix = typeof args[0] === "string" ? args[0] : "none";
        return Promise.resolve({
          include: [`${this.mode ?? "unknown"}-${suffix}`]
        } satisfies RstestConfig);
      }
    );

    if (typeof mapped !== "function") {
      throw new Error("Expected mapped promise-returning function export");
    }

    const resolved = await mapped.call({ mode: "ctx" }, "arg");
    expect(resolved.include).toEqual(["ctx-arg", "mapped-promise-function.test.ts"]);
  });

  test("preserves this and arguments for thenable-returning mapped config functions", async () => {
    const mapped = mapAnyConfigExport(
      (value) => ({
        ...value,
        include: [...(value.include ?? []), "mapped-thenable-function.test.ts"]
      }),
      function (this: { mode?: string }, ...args: unknown[]) {
        const suffix = typeof args[0] === "string" ? args[0] : "none";
        const value = {
          include: [`${this.mode ?? "unknown"}-${suffix}`]
        } satisfies RstestConfig;
        return {
          then(resolve: (resolved: typeof value) => void) {
            resolve(value);
            return Promise.resolve(value);
          }
        } as unknown as PromiseLike<typeof value>;
      }
    );

    if (typeof mapped !== "function") {
      throw new Error("Expected mapped thenable-returning function export");
    }

    const resolved = await mapped.call({ mode: "thenable-ctx" }, "thenable-arg");
    expect(resolved.include).toEqual(["thenable-ctx-thenable-arg", "mapped-thenable-function.test.ts"]);
  });

  test("propagates mapper throws for mapped config function exports", async () => {
    const errorMessage = "mapper function throw";
    const mapped = mapAnyConfigExport(
      () => {
        throw new Error(errorMessage);
      },
      function (this: { mode?: string }) {
        return {
          include: [this.mode ?? "unknown"]
        } satisfies RstestConfig;
      }
    );

    if (typeof mapped !== "function") {
      throw new Error("Expected mapped function export");
    }

    await expect(mapped.call({ mode: "mapped-throw" })).rejects.toThrow(errorMessage);
  });

  test("propagates mapper throws for promise-returning mapped config functions", async () => {
    const errorMessage = "mapper promise function throw";
    const mapped = mapAnyConfigExport(
      () => {
        throw new Error(errorMessage);
      },
      function (this: { mode?: string }, ...args: unknown[]) {
        const suffix = typeof args[0] === "string" ? args[0] : "none";
        return Promise.resolve({
          include: [`${this.mode ?? "unknown"}-${suffix}`]
        } satisfies RstestConfig);
      }
    );

    if (typeof mapped !== "function") {
      throw new Error("Expected mapped promise-returning function export");
    }

    await expect(mapped.call({ mode: "ctx" }, "arg")).rejects.toThrow(errorMessage);
  });

  test("propagates mapper throws for async mapped config function exports", async () => {
    const errorMessage = "mapper async function throw";
    const mapped = mapAnyConfigExport(
      () => {
        throw new Error(errorMessage);
      },
      async (...args: unknown[]) => {
        const context = args[0] as { mode?: string } | undefined;
        const suffix = typeof args[1] === "string" ? args[1] : "none";
        return {
          include: [`${context?.mode ?? "unknown"}-${suffix}`]
        } satisfies RstestConfig;
      }
    );

    if (typeof mapped !== "function") {
      throw new Error("Expected mapped async function export");
    }

    await expect(mapped({ mode: "serve" }, "watch")).rejects.toThrow(errorMessage);
  });

  test("propagates mapper throws for thenable-returning mapped config functions", async () => {
    const errorMessage = "mapper thenable function throw";
    const mapped = mapAnyConfigExport(
      () => {
        throw new Error(errorMessage);
      },
      function (this: { mode?: string }, ...args: unknown[]) {
        const suffix = typeof args[0] === "string" ? args[0] : "none";
        const value = {
          include: [`${this.mode ?? "unknown"}-${suffix}`]
        } satisfies RstestConfig;
        return {
          then(resolve: (resolved: typeof value) => void) {
            resolve(value);
            return Promise.resolve(value);
          }
        } as unknown as PromiseLike<typeof value>;
      }
    );

    if (typeof mapped !== "function") {
      throw new Error("Expected mapped thenable-returning function export");
    }

    await expect(mapped.call({ mode: "thenable-ctx" }, "thenable-arg")).rejects.toThrow(
      errorMessage
    );
  });

  test("propagates rejection for thenable-returning mapped config functions", async () => {
    const errorMessage = "mapped thenable function rejection";
    const mapped = mapAnyConfigExport(
      (value) => ({
        ...value,
        include: [...(value.include ?? []), "mapped-should-not-run.test.ts"]
      }),
      function () {
        return {
          then(
            _onfulfilled?: ((value: RstestConfig) => unknown) | null,
            onrejected?: ((reason: unknown) => unknown) | null
          ) {
            const error = new Error(errorMessage);
            if (typeof onrejected === "function") {
              onrejected(error);
            }
            return Promise.reject(error);
          }
        } as PromiseLike<RstestConfig>;
      }
    );

    if (typeof mapped !== "function") {
      throw new Error("Expected mapped thenable function export");
    }

    await expect(mapped()).rejects.toThrow(errorMessage);
  });

  test("propagates rejection for promise-returning mapped config functions", async () => {
    const errorMessage = "mapped promise function rejection";
    const mapped = mapAnyConfigExport(
      (value) => ({
        ...value,
        include: [...(value.include ?? []), "mapped-should-not-run.test.ts"]
      }),
      function () {
        return Promise.reject(new Error(errorMessage)) as Promise<RstestConfig>;
      }
    );

    if (typeof mapped !== "function") {
      throw new Error("Expected mapped promise-returning function export");
    }

    await expect(mapped()).rejects.toThrow(errorMessage);
  });

  test("propagates thrown errors from mapped config function exports", () => {
    const errorMessage = "mapped function throw";
    const mapped = mapAnyConfigExport(
      (value) => ({
        ...value,
        include: [...(value.include ?? []), "mapped-should-not-run.test.ts"]
      }),
      function () {
        throw new Error(errorMessage);
      }
    );

    if (typeof mapped !== "function") {
      throw new Error("Expected mapped function export");
    }

    expect(() => mapped()).toThrow(errorMessage);
  });

  test("propagates rejection from async mapped config function exports", async () => {
    const errorMessage = "mapped async function rejection";
    const mapped = mapAnyConfigExport(
      (value) => ({
        ...value,
        include: [...(value.include ?? []), "mapped-should-not-run.test.ts"]
      }),
      async function () {
        throw new Error(errorMessage);
      }
    );

    if (typeof mapped !== "function") {
      throw new Error("Expected mapped async function export");
    }

    await expect(mapped()).rejects.toThrow(errorMessage);
  });
});
