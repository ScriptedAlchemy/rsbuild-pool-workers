import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "@rstest/core";

const execFileAsync = promisify(execFile);

describe("rstest CLI integration", () => {
  test("runs cloudflare:test through defineWorkersConfig end-to-end", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-e2e-"));
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
          fetch(_request, env) {
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

    expect(stderr).toBe("");
    expect(stdout).toContain('"status": "pass"');
    expect(stdout).toContain("sample.test.ts");

    await fs.rm(tempRoot, { recursive: true, force: true });
  });
});
