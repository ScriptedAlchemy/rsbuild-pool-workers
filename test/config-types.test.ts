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
});
