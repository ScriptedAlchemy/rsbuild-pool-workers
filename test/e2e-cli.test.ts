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

  test("supports fetchMock for outbound requests in fixture tests", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./fetch-mock.test.ts"],
            poolOptions: {
              workers: {
                main: "./worker.ts"
              }
            }
          }
        });
      `,
      "worker.ts": `
        export default {
          async fetch() {
            const response = await fetch("http://example.com/data");
            return new Response(await response.text());
          }
        };
      `,
      "fetch-mock.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF, fetchMock } from "cloudflare:test";

        test("intercepts outbound fetch", async () => {
          fetchMock.activate();
          fetchMock.disableNetConnect();
          fetchMock
            .get("http://example.com")
            .intercept({ path: "/data", method: "GET" })
            .reply(200, "from-mock");

          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("from-mock");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("fetch-mock.test.ts");
    });
  });

  test("supports runInDurableObject for RPC-callable methods", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./do-rpc.test.ts"],
            poolOptions: {
              workers: {
                main: "./worker.ts",
                miniflare: {
                  durableObjects: {
                    COUNTER: "Counter"
                  }
                }
              }
            }
          }
        });
      `,
      "worker.ts": `
        import { DurableObject } from "cloudflare:workers";

        export class Counter extends DurableObject {
          async incrementAndGet() {
            const value = Number((await this.ctx.storage.get("count")) ?? 0) + 1;
            await this.ctx.storage.put("count", value);
            return value;
          }
        }

        export default {
          fetch() {
            return new Response("ok");
          }
        };
      `,
      "do-rpc.test.ts": `
        import { test, expect } from "@rstest/core";
        import { env, runInDurableObject } from "cloudflare:test";

        test("runs RPC-callable durable object methods", async () => {
          const namespace = env.COUNTER as {
            idFromName(name: string): unknown;
            get(id: unknown): unknown;
          };
          const id = namespace.idFromName("singleton");
          const stub = namespace.get(id);

          const first = await runInDurableObject<{ incrementAndGet: () => Promise<number> }, number>(
            stub as any,
            async (instance) => instance.incrementAndGet()
          );
          const second = await runInDurableObject<{ incrementAndGet: () => Promise<number> }, number>(
            stub as any,
            async (instance) => instance.incrementAndGet()
          );

          expect(first).toBe(1);
          expect(second).toBe(2);
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("do-rpc.test.ts");
    });
  });

  test("supports cloudflare:test-internal runtime alias", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./internal-module.test.ts"],
            poolOptions: {
              workers: {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    VALUE: "internal-ok"
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
            return new Response(String(env.VALUE));
          }
        };
      `,
      "internal-module.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF, env } from "cloudflare:test-internal";

        test("internal alias resolves correctly", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("internal-ok");
          expect(env.VALUE).toBe("internal-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("internal-module.test.ts");
    });
  });

  test("keeps cloudflare:test env bindings read-only", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./env-readonly.test.ts"],
            poolOptions: {
              workers: {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    TOKEN: "abc123"
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
            return new Response(String(env.TOKEN));
          }
        };
      `,
      "env-readonly.test.ts": `
        import { test, expect } from "@rstest/core";
        import { env } from "cloudflare:test";

        test("env is immutable", () => {
          expect(env.TOKEN).toBe("abc123");
          expect(() => {
            (env as Record<string, unknown>).TOKEN = "override";
          }).toThrow("Cannot assign to read only property on cloudflare:test env.");
          expect(() => {
            delete (env as Record<string, unknown>).TOKEN;
          }).toThrow("Cannot delete properties from cloudflare:test env.");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("env-readonly.test.ts");
    });
  });
});
