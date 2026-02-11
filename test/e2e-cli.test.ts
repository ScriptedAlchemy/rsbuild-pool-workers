import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "@rstest/core";

const execFileAsync = promisify(execFile);

describe("rstest CLI integration", () => {
  async function runFixture(
    files: Record<string, string>,
    assertions: (result: { stdout: string; stderr: string }) => void
  ): Promise<void> {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-e2e-"));
    const packageRoot = process.cwd();

    try {
      for (const [relativePath, contents] of Object.entries(files)) {
        const filePath = path.join(tempRoot, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, contents.trimStart(), "utf8");
      }

      let stdout = "";
      let stderr = "";
      try {
        const rstestBin = path.join(packageRoot, "node_modules", ".bin", "rstest");
        const result = await execFileAsync(
          rstestBin,
          ["run", "--root", tempRoot],
          {
            cwd: tempRoot,
            env: {
              ...process.env
            },
            maxBuffer: 1024 * 1024 * 5
          }
        );
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error) {
        const details =
          error && typeof error === "object"
            ? String((error as { stdout?: string }).stdout ?? "") +
              String((error as { stderr?: string }).stderr ?? "")
            : String(error);
        throw new Error(`Subprocess rstest run failed:\n${details}`);
      }

      assertions({ stdout, stderr });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  test("runs cloudflare:test through defineWorkersConfig end-to-end", async () => {
    const packageRoot = process.cwd();

    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./sample.test.ts"],
            poolOptions: {
              workers: {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    MY_BINDING: 123
                  }
                }
              }
            }
          }
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request: Request, env: Record<string, unknown>) {
            return new Response("ok:" + String(env.MY_BINDING));
          }
        };
      `,
      "sample.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF, env } from "cloudflare:test";

        test("smoke", async () => {
          const response = await SELF.fetch("http://localhost/");
          expect(await response.text()).toBe("ok:123");
          expect(env.MY_BINDING).toBe(123);
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("sample.test.ts");
    });
  });

  test("respects isolatedStorage=false and preserves storage across tests", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./persist.test.ts"],
            poolOptions: {
              workers: {
                main: "./worker.ts",
                isolatedStorage: false,
                miniflare: {
                  kvNamespaces: ["COUNTER"],
                  kvPersist: "./.mf/kv"
                }
              }
            }
          }
        });
      `,
      "worker.ts": `
        export default {
          async fetch(request, env) {
            if (request.url.endsWith("/inc")) {
              const current = Number(await env.COUNTER.get("value") || "0") + 1;
              await env.COUNTER.put("value", String(current));
              return new Response(String(current));
            }
            return new Response(await env.COUNTER.get("value") || "0");
          }
        };
      `,
      "persist.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("first increments", async () => {
          const res = await SELF.fetch("http://localhost/inc");
          expect(await res.text()).toBe("1");
        });

        test("second sees persisted value", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("1");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("persist.test.ts");
    });
  });
});
