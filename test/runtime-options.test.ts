import path from "node:path";
import { describe, expect, test } from "@rstest/core";
import { resolveRuntimeOptions } from "../src/runtime/options";

describe("resolveRuntimeOptions", () => {
  test("resolves relative main path and fills miniflare defaults", async () => {
    const root = "/repo/example";
    const options = await resolveRuntimeOptions(
      {
        main: "./src/worker.ts",
        miniflare: {}
      },
      root
    );

    expect(options.main).toBe(path.resolve(root, "./src/worker.ts"));
    expect(options.miniflare.scriptPath).toBe(path.resolve(root, "./src/worker.ts"));
    expect(options.miniflare.modules).toBe(true);
    expect(options.miniflare.compatibilityDate).toBe("2024-01-01");
  });

  test("preserves explicit script config", async () => {
    const options = await resolveRuntimeOptions(
      {
        main: "./ignored.ts",
        miniflare: {
          script: "export default { fetch(){ return new Response('ok') } }"
        }
      },
      process.cwd()
    );

    expect(options.miniflare.script).toContain("fetch");
    expect(options.miniflare.scriptPath).toBeUndefined();
  });
});
