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
    assertions: (result: { stdout: string; stderr: string }) => void,
    options?: { env?: Record<string, string | undefined> }
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
              ...process.env,
              ...(options?.env ?? {})
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

  test("supports SELF.fetch Request inputs end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./request-input.test.ts"],
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
          async fetch(request) {
            const body = await request.text();
            return new Response(request.method + ":" + body);
          }
        };
      `,
      "request-input.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("Request input keeps method/body", async () => {
          const req = new Request("http://localhost/", {
            method: "POST",
            body: "fixture-payload"
          });
          const res = await SELF.fetch(req);
          expect(await res.text()).toBe("POST:fixture-payload");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("request-input.test.ts");
    });
  });

  test("supports SELF.fetch URL inputs end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./url-input.test.ts"],
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
          fetch(request) {
            return new Response(new URL(request.url).pathname);
          }
        };
      `,
      "url-input.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("URL input is dispatched correctly", async () => {
          const res = await SELF.fetch(new URL("http://localhost/e2e-url-input"));
          expect(await res.text()).toBe("/e2e-url-input");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("url-input.test.ts");
    });
  });

  test("supports SELF.fetch Request init overrides end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./request-override.test.ts"],
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
          async fetch(request) {
            const body = await request.text();
            return new Response(request.method + ":" + body);
          }
        };
      `,
      "request-override.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("Request init overrides are respected", async () => {
          const req = new Request("http://localhost/", {
            method: "POST",
            body: "original"
          });
          const res = await SELF.fetch(req, {
            method: "PUT",
            body: "override"
          });
          expect(await res.text()).toBe("PUT:override");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("request-override.test.ts");
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

  test("supports SELF.scheduled through cloudflare:test", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./scheduled.test.ts"],
            poolOptions: {
              workers: {
                main: "./worker.ts",
                miniflare: {
                  kvNamespaces: ["CLOCK"]
                }
              }
            }
          }
        });
      `,
      "worker.ts": `
        export default {
          async scheduled(controller, env, ctx) {
            const payload = String(controller.cron) + "|" + String(controller.scheduledTime);
            ctx.waitUntil(env.CLOCK.put("last", payload));
          },
          async fetch(_request, env) {
            return new Response((await env.CLOCK.get("last")) ?? "none");
          }
        };
      `,
      "scheduled.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("dispatches scheduled events", async () => {
          const before = await SELF.fetch("http://localhost/");
          expect(await before.text()).toBe("none");

          await SELF.scheduled({
            cron: "0 * * * *",
            scheduledTime: 1700000001234
          });

          let afterText = "none";
          for (let i = 0; i < 10; i++) {
            const res = await SELF.fetch("http://localhost/");
            afterText = await res.text();
            if (afterText !== "none") {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(afterText).toBe("0 * * * *|1700000001234");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("scheduled.test.ts");
    });
  });

  test("supports SELF.scheduled defaults when options are omitted", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./scheduled-defaults.test.ts"],
            poolOptions: {
              workers: {
                main: "./worker.ts",
                miniflare: {
                  kvNamespaces: ["CLOCK"]
                }
              }
            }
          }
        });
      `,
      "worker.ts": `
        export default {
          async scheduled(controller, env, ctx) {
            const payload = JSON.stringify({
              cron: String(controller.cron),
              scheduledTime: Number(controller.scheduledTime)
            });
            ctx.waitUntil(env.CLOCK.put("meta", payload));
          },
          async fetch(_request, env) {
            return new Response((await env.CLOCK.get("meta")) ?? "none");
          }
        };
      `,
      "scheduled-defaults.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("dispatches with default schedule options", async () => {
          await SELF.scheduled();

          let afterText = "none";
          for (let i = 0; i < 10; i++) {
            const res = await SELF.fetch("http://localhost/");
            afterText = await res.text();
            if (afterText !== "none") {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }

          expect(afterText).not.toBe("none");
          const parsed = JSON.parse(afterText) as {
            cron: string;
            scheduledTime: number;
          };
          expect(parsed.cron).toBe("");
          expect(Number.isFinite(parsed.scheduledTime)).toBe(true);
          expect(parsed.scheduledTime).toBeGreaterThan(0);
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("scheduled-defaults.test.ts");
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

  test("supports cloudflare:test-internal for durable object helpers", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./internal-do-helper.test.ts"],
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
            const value = Number((await this.ctx.storage.get("value")) ?? 0) + 1;
            await this.ctx.storage.put("value", value);
            return value;
          }
        }

        export default {
          fetch() {
            return new Response("ok");
          }
        };
      `,
      "internal-do-helper.test.ts": `
        import { test, expect } from "@rstest/core";
        import { env, runInDurableObject } from "cloudflare:test-internal";

        test("internal alias exposes runInDurableObject", async () => {
          const namespace = env.COUNTER as {
            idFromName(name: string): unknown;
            get(id: unknown): unknown;
          };
          const stub = namespace.get(namespace.idFromName("singleton"));

          const one = await runInDurableObject<{ incrementAndGet: () => Promise<number> }, number>(
            stub as any,
            (instance) => instance.incrementAndGet()
          );
          const two = await runInDurableObject<{ incrementAndGet: () => Promise<number> }, number>(
            stub as any,
            (instance) => instance.incrementAndGet()
          );

          expect(one).toBe(1);
          expect(two).toBe(2);
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("internal-do-helper.test.ts");
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
          expect(() => {
            Object.defineProperty(env, "TOKEN", { value: "override" });
          }).toThrow("Cannot redefine properties on cloudflare:test env.");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("env-readonly.test.ts");
    });
  });

  test("surfaces actionable error when runInDurableObject state is accessed", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./do-state-access.test.ts"],
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
          async ping() {
            return "pong";
          }
        }

        export default {
          fetch() {
            return new Response("ok");
          }
        };
      `,
      "do-state-access.test.ts": `
        import { test, expect } from "@rstest/core";
        import { env, runInDurableObject } from "cloudflare:test";

        test("state access throws explicit guidance", async () => {
          const namespace = env.COUNTER as {
            idFromName(name: string): unknown;
            get(id: unknown): unknown;
          };
          const stub = namespace.get(namespace.idFromName("singleton"));

          await expect(
            runInDurableObject(stub as any, async (_instance, state) => {
              return String((state as any).storage);
            })
          ).rejects.toThrow("DurableObjectState access is not yet available in Rstest mode");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("do-state-access.test.ts");
    });
  });

  test("lists Durable Object IDs via cloudflare:test helper", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./do-list-ids.test.ts"],
            poolOptions: {
              workers: {
                main: "./worker.ts",
                miniflare: {
                  durableObjects: {
                    COUNTER: "Counter"
                  },
                  durableObjectsPersist: "./.mf/do"
                }
              }
            }
          }
        });
      `,
      "worker.ts": `
        import { DurableObject } from "cloudflare:workers";

        export class Counter extends DurableObject {
          async fetch() {
            return new Response("ok");
          }
        }

        export default {
          async fetch(_request, env) {
            const id = env.COUNTER.newUniqueId();
            await env.COUNTER.get(id).fetch("http://localhost/");
            return new Response(id.toString());
          }
        };
      `,
      "do-list-ids.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF, env, listDurableObjectIds } from "cloudflare:test";

        test("enumerates created object ids", async () => {
          const created = await (await SELF.fetch("http://localhost/")).text();
          let idStrings: string[] = [];
          for (let i = 0; i < 10; i++) {
            const ids = await listDurableObjectIds(env.COUNTER as any);
            idStrings = ids.map((id) => String(id.toString()));
            if (idStrings.includes(created)) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(idStrings).toContain(created);
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("do-list-ids.test.ts");
    });
  });

  test("reports clear error for invalid listDurableObjectIds namespace", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./do-list-invalid.test.ts"],
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
          fetch() {
            return new Response("ok");
          }
        };
      `,
      "do-list-invalid.test.ts": `
        import { test, expect } from "@rstest/core";
        import { listDurableObjectIds } from "cloudflare:test";

        test("throws type error", async () => {
          await expect(
            listDurableObjectIds({} as any)
          ).rejects.toThrow(
            "Failed to execute 'listDurableObjectIds': parameter 1 is not of type 'DurableObjectNamespace'."
          );
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("do-list-invalid.test.ts");
    });
  });

  test("supports function-valued workers options with inject() end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./inject-workers-options.test.ts"],
            poolOptions: {
              workers: ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    GREETING: inject("GREETING")
                  }
                }
              })
            }
          }
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.GREETING));
          }
        };
      `,
      "inject-workers-options.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("inject() value is wired into worker bindings", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("hello-from-inject");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("inject-workers-options.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_GREETING: "\"hello-from-inject\""
        }
      }
    );
  });

  test("isolates per-fixture env overrides for inject() values", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./scoped-inject.test.ts"],
            poolOptions: {
              workers: ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    SCOPED_VALUE: inject("SCOPED_VALUE")
                  }
                }
              })
            }
          }
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.SCOPED_VALUE));
          }
        };
      `,
      "scoped-inject.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("inject value is fixture-scoped", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe(process.env.EXPECTED_VALUE);
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("scoped-inject.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_SCOPED_VALUE: "\"scoped-one\"",
          EXPECTED_VALUE: "scoped-one"
        }
      }
    );

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("scoped-inject.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_SCOPED_VALUE: "\"scoped-two\"",
          EXPECTED_VALUE: "scoped-two"
        }
      }
    );
  });

  test("supports inject() direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./inject-direct-env.test.ts"],
            poolOptions: {
              workers: ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    GREETING: inject("DIRECT_GREETING")
                  }
                }
              })
            }
          }
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.GREETING));
          }
        };
      `,
      "inject-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("inject() reads from direct env fallback", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("hello-from-direct-env");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("inject-direct-env.test.ts");
      },
      {
        env: {
          DIRECT_GREETING: "hello-from-direct-env"
        }
      }
    );
  });

  test("supports async config with async workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          test: {
            include: ["./async-workers-options.test.ts"],
            poolOptions: {
              workers: async ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    GREETING: inject("ASYNC_GREETING")
                  }
                }
              })
            }
          }
        }));
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.GREETING));
          }
        };
      `,
      "async-workers-options.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("async workers options are resolved before runtime starts", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("hello-from-async-inject");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("async-workers-options.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_ASYNC_GREETING: "\"hello-from-async-inject\""
        }
      }
    );
  });

  test("supports promise-based config exports end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-config.test.ts"],
              poolOptions: {
                workers: {
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROMISE_VALUE: "promise-config-ok"
                    }
                  }
                }
              }
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_VALUE));
          }
        };
      `,
      "promise-config.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise config export resolves workers wiring", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-config-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-config.test.ts");
    });
  });

  test("supports defineWorkersProject alias end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          test: {
            include: ["./project-alias.test.ts"],
            poolOptions: {
              workers: {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    ALIAS_VALUE: "project-alias-ok"
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
            return new Response(String(env.ALIAS_VALUE));
          }
        };
      `,
      "project-alias.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("defineWorkersProject config wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-alias-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-alias.test.ts");
    });
  });

  test("supports defineWorkersProject top-level workers option end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          include: ["./project-top-level.test.ts"],
          workers: {
            main: "./worker.ts",
            miniflare: {
              bindings: {
                TOP_LEVEL_ALIAS_VALUE: "project-top-level-ok"
              }
            }
          }
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.TOP_LEVEL_ALIAS_VALUE));
          }
        };
      `,
      "project-top-level.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("defineWorkersProject top-level workers wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-top-level-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-top-level.test.ts");
    });
  });
});
