import fs from "node:fs/promises";
import os from "node:os";
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
    expect(options.remoteBindings).toBe(true);
    expect(options.additionalExports).toEqual({});
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

  test("accepts additional worker export hints in options", async () => {
    const options = await resolveRuntimeOptions({
      additionalExports: {
        WorkerFoo: "WorkerEntrypoint",
        DurableBar: "DurableObject"
      },
      remoteBindings: false,
      miniflare: {}
    });

    expect(options.remoteBindings).toBe(false);
    expect(options.additionalExports).toEqual({
      WorkerFoo: "WorkerEntrypoint",
      DurableBar: "DurableObject"
    });
  });

  test("bundles TypeScript entrypoint into in-memory script", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-options-"));
    const mainPath = path.join(tempRoot, "worker.ts");
    const depPath = path.join(tempRoot, "dep.ts");

    await fs.writeFile(depPath, `export const greeting = "hello";\n`);
    await fs.writeFile(
      mainPath,
      `
        import { greeting } from "./dep";
        export default {
          fetch() {
            return new Response(greeting + " from ts");
          }
        };
      `
    );

    const options = await resolveRuntimeOptions(
      {
        main: mainPath,
        miniflare: {}
      },
      tempRoot
    );

    expect(options.miniflare.modules).toBe(true);
    expect(typeof options.miniflare.script).toBe("string");
    expect(String(options.miniflare.script)).toContain("from ts");
    expect(options.miniflare.scriptPath).toBeUndefined();

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test("bundles TSX entrypoint into in-memory script", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-options-tsx-"));
    const mainPath = path.join(tempRoot, "worker.tsx");
    const depPath = path.join(tempRoot, "dep.ts");

    await fs.writeFile(depPath, `export const suffix = "tsx";\n`);
    await fs.writeFile(
      mainPath,
      `
        import { suffix } from "./dep";
        export default {
          fetch() {
            return new Response("from-" + suffix);
          }
        };
      `
    );

    const options = await resolveRuntimeOptions(
      {
        main: mainPath,
        miniflare: {}
      },
      tempRoot
    );

    expect(options.miniflare.modules).toBe(true);
    expect(typeof options.miniflare.script).toBe("string");
    expect(String(options.miniflare.script)).toContain("from-");
    expect(options.miniflare.scriptPath).toBeUndefined();

    await fs.rm(tempRoot, { recursive: true, force: true });
  });
});
