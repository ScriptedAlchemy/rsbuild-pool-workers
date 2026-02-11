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
});
