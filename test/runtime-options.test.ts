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

  test("preserves explicit compatibilityDate after whitespace normalization", async () => {
    const options = await resolveRuntimeOptions(
      {
        main: "./src/worker.ts",
        miniflare: {
          compatibilityDate: " 2023-10-10 "
        }
      },
      "/repo/example"
    );

    expect(options.miniflare.compatibilityDate).toBe("2023-10-10");
  });

  test("throws when incompatible export_commonjs_namespace flag is present", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityFlags: ["export_commonjs_namespace"]
          }
        },
        "/repo/example"
      )
    ).rejects.toThrow(
      'workers.miniflare.compatibilityFlags must not contain "export_commonjs_namespace".'
    );
  });

  test("rejects incompatible export_commonjs_namespace flag after whitespace normalization", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityFlags: [" export_commonjs_namespace "]
          }
        },
        "/repo/example"
      )
    ).rejects.toThrow(
      'workers.miniflare.compatibilityFlags must not contain "export_commonjs_namespace".'
    );
  });

  test("requires export_commonjs_default when compatibilityDate is older than default-on date", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityDate: "2022-10-30",
            compatibilityFlags: []
          }
        },
        "/repo/example"
      )
    ).rejects.toThrow(
      'workers.miniflare.compatibilityFlags must contain "export_commonjs_default"'
    );
  });

  test("applies old-date required-flag check after compatibilityDate whitespace normalization", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityDate: " 2022-10-30 ",
            compatibilityFlags: []
          }
        },
        "/repo/example"
      )
    ).rejects.toThrow(
      'workers.miniflare.compatibilityFlags must contain "export_commonjs_default"'
    );
  });

  test("accepts old compatibilityDate when export_commonjs_default flag is explicitly present", async () => {
    const options = await resolveRuntimeOptions(
      {
        main: "./src/worker.ts",
        miniflare: {
          compatibilityDate: "2022-10-30",
          compatibilityFlags: ["export_commonjs_default"]
        }
      },
      "/repo/example"
    );

    expect(options.miniflare.compatibilityDate).toBe("2022-10-30");
    expect(options.miniflare.compatibilityFlags).toEqual(["export_commonjs_default"]);
  });

  test("accepts old compatibilityDate when required flag is present after whitespace normalization", async () => {
    const options = await resolveRuntimeOptions(
      {
        main: "./src/worker.ts",
        miniflare: {
          compatibilityDate: "2022-10-30",
          compatibilityFlags: [" export_commonjs_default "]
        }
      },
      "/repo/example"
    );

    expect(options.miniflare.compatibilityDate).toBe("2022-10-30");
    expect(options.miniflare.compatibilityFlags).toEqual(["export_commonjs_default"]);
  });

  test("normalizes compatibilityFlags into a defensive copy", async () => {
    const flags = ["export_commonjs_default"];
    const options = await resolveRuntimeOptions(
      {
        main: "./src/worker.ts",
        miniflare: {
          compatibilityDate: "2022-10-30",
          compatibilityFlags: flags
        }
      },
      "/repo/example"
    );

    expect(options.miniflare.compatibilityFlags).toEqual(["export_commonjs_default"]);
    expect(options.miniflare.compatibilityFlags).not.toBe(flags);
  });

  test("does not mutate input compatibilityFlags arrays during normalization", async () => {
    const inputFlags = [" export_commonjs_default ", " alpha-flag "];
    await resolveRuntimeOptions(
      {
        main: "./src/worker.ts",
        miniflare: {
          compatibilityDate: "2024-01-01",
          compatibilityFlags: inputFlags
        }
      },
      "/repo/example"
    );

    expect(inputFlags).toEqual([" export_commonjs_default ", " alpha-flag "]);
  });

  test("deduplicates compatibilityFlags entries during normalization", async () => {
    const options = await resolveRuntimeOptions(
      {
        main: "./src/worker.ts",
        miniflare: {
          compatibilityDate: "2024-01-01",
          compatibilityFlags: [
            "export_commonjs_default",
            "export_commonjs_default"
          ]
        }
      },
      "/repo/example"
    );

    expect(options.miniflare.compatibilityFlags).toEqual(["export_commonjs_default"]);
  });

  test("deduplicates compatibilityFlags while preserving first-seen order", async () => {
    const options = await resolveRuntimeOptions(
      {
        main: "./src/worker.ts",
        miniflare: {
          compatibilityDate: "2024-01-01",
          compatibilityFlags: [
            " export_commonjs_default ",
            " alpha-flag ",
            "export_commonjs_default",
            "alpha-flag"
          ]
        }
      },
      "/repo/example"
    );

    expect(options.miniflare.compatibilityFlags).toEqual([
      "export_commonjs_default",
      "alpha-flag"
    ]);
  });

  test("throws actionable error when compatibilityFlags contains empty entries", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityDate: "2024-01-01",
            compatibilityFlags: ["export_commonjs_default", "  "]
          }
        },
        "/repo/example"
      )
    ).rejects.toThrow(
      "workers.miniflare.compatibilityFlags must not contain empty entries."
    );
  });

  test("normalizes missing compatibilityFlags to an empty array", async () => {
    const options = await resolveRuntimeOptions(
      {
        main: "./src/worker.ts",
        miniflare: {
          compatibilityDate: "2024-01-01"
        }
      },
      "/repo/example"
    );

    expect(options.miniflare.compatibilityFlags).toEqual([]);
  });

  test("throws actionable error for invalid compatibilityDate format", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityDate: "not-a-date",
            compatibilityFlags: []
          }
        },
        "/repo/example"
      )
    ).rejects.toThrow('Invalid compatibilityDate "not-a-date".');
  });

  test("throws actionable error for whitespace-only compatibilityDate", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityDate: "   ",
            compatibilityFlags: ["export_commonjs_default"]
          }
        },
        "/repo/example"
      )
    ).rejects.toThrow('Invalid compatibilityDate "   ".');
  });

  test("throws actionable error for non-ISO compatibilityDate format", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityDate: "2024/01/01",
            compatibilityFlags: ["export_commonjs_default"]
          }
        },
        "/repo/example"
      )
    ).rejects.toThrow('Invalid compatibilityDate "2024/01/01".');
  });

  test("throws actionable error for impossible calendar compatibilityDate", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityDate: "2024-02-30",
            compatibilityFlags: ["export_commonjs_default"]
          }
        },
        "/repo/example"
      )
    ).rejects.toThrow('Invalid compatibilityDate "2024-02-30".');
  });

  test("accepts valid leap-day compatibilityDate", async () => {
    const options = await resolveRuntimeOptions(
      {
        main: "./src/worker.ts",
        miniflare: {
          compatibilityDate: "2024-02-29",
          compatibilityFlags: ["export_commonjs_default"]
        }
      },
      "/repo/example"
    );

    expect(options.miniflare.compatibilityDate).toBe("2024-02-29");
  });

  test("throws actionable error when compatibilityFlags is not an array", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityFlags: "export_commonjs_default"
          }
        } as never,
        "/repo/example"
      )
    ).rejects.toThrow(
      "workers.miniflare.compatibilityFlags must be an array of strings."
    );
  });

  test("includes received type in compatibilityFlags non-array diagnostics", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityFlags: "export_commonjs_default"
          }
        } as never,
        "/repo/example"
      )
    ).rejects.toThrow(
      "Received: string."
    );
  });

  test("reports object received type for compatibilityFlags non-array diagnostics", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityFlags: {}
          }
        } as never,
        "/repo/example"
      )
    ).rejects.toThrow(
      "Received: object."
    );
  });

  test("reports null received type for compatibilityFlags non-array diagnostics", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityFlags: null
          }
        } as never,
        "/repo/example"
      )
    ).rejects.toThrow(
      "Received: null."
    );
  });

  test("throws actionable error when compatibilityFlags contains non-string values", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityFlags: ["export_commonjs_default", 1]
          }
        } as never,
        "/repo/example"
      )
    ).rejects.toThrow(
      "workers.miniflare.compatibilityFlags must be an array of strings."
    );
  });

  test("includes entry type in compatibilityFlags non-string diagnostics", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityFlags: ["export_commonjs_default", 1]
          }
        } as never,
        "/repo/example"
      )
    ).rejects.toThrow(
      "Received entry type: number."
    );
  });

  test("reports null entry type in compatibilityFlags non-string diagnostics", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityFlags: ["export_commonjs_default", null]
          }
        } as never,
        "/repo/example"
      )
    ).rejects.toThrow(
      "Received entry type: null."
    );
  });

  test("throws actionable error when compatibilityDate is not a string", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityDate: 20240101,
            compatibilityFlags: ["export_commonjs_default"]
          }
        } as never,
        "/repo/example"
      )
    ).rejects.toThrow(
      "workers.miniflare.compatibilityDate must be a string in YYYY-MM-DD format."
    );
  });

  test("includes received type in compatibilityDate non-string diagnostics", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityDate: 20240101,
            compatibilityFlags: ["export_commonjs_default"]
          }
        } as never,
        "/repo/example"
      )
    ).rejects.toThrow(
      "Received: number."
    );
  });

  test("reports null received type in compatibilityDate non-string diagnostics", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityDate: null,
            compatibilityFlags: ["export_commonjs_default"]
          }
        } as never,
        "/repo/example"
      )
    ).rejects.toThrow(
      "Received: null."
    );
  });

  test("reports array received type in compatibilityDate non-string diagnostics", async () => {
    await expect(
      resolveRuntimeOptions(
        {
          main: "./src/worker.ts",
          miniflare: {
            compatibilityDate: [],
            compatibilityFlags: ["export_commonjs_default"]
          }
        } as never,
        "/repo/example"
      )
    ).rejects.toThrow(
      "Received: array."
    );
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

  test("preserves explicit scriptPath config", async () => {
    const options = await resolveRuntimeOptions(
      {
        main: "./ignored.ts",
        miniflare: {
          scriptPath: "/custom/worker.js"
        }
      },
      process.cwd()
    );

    expect(options.miniflare.scriptPath).toBe("/custom/worker.js");
    expect(options.miniflare.script).toBeUndefined();
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

  test("bundles MTS entrypoint into in-memory script", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-options-mts-"));
    const mainPath = path.join(tempRoot, "worker.mts");
    const depPath = path.join(tempRoot, "dep.mts");

    await fs.writeFile(depPath, `export const suffix = "mts";\n`);
    await fs.writeFile(
      mainPath,
      `
        import { suffix } from "./dep.mts";
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

  test("bundles CTS entrypoint into in-memory script", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-options-cts-"));
    const mainPath = path.join(tempRoot, "worker.cts");

    await fs.writeFile(
      mainPath,
      `
        const suffix = "cts";
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

  test("falls back to scriptPath when TypeScript entrypoint file is missing", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-options-missing-"));
    const missingMainPath = path.join(tempRoot, "worker.ts");

    const options = await resolveRuntimeOptions(
      {
        main: missingMainPath,
        miniflare: {}
      },
      tempRoot
    );

    expect(options.miniflare.modules).toBe(true);
    expect(options.miniflare.script).toBeUndefined();
    expect(options.miniflare.scriptPath).toBe(missingMainPath);

    await fs.rm(tempRoot, { recursive: true, force: true });
  });
});
