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

  test("supports SELF.fetch relative string inputs end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./relative-input.test.ts"],
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
      "relative-input.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("relative string input is normalized", async () => {
          const res = await SELF.fetch("/e2e-relative-input");
          expect(await res.text()).toBe("/e2e-relative-input");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("relative-input.test.ts");
    });
  });

  test("supports SELF.fetch bare path string inputs end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./bare-path-input.test.ts"],
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
      "bare-path-input.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("bare path input is normalized", async () => {
          const res = await SELF.fetch("e2e-bare-input");
          expect(await res.text()).toBe("/e2e-bare-input");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("bare-path-input.test.ts");
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

  test("supports SELF.fetch Request header forwarding end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./request-headers.test.ts"],
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
            return new Response(request.headers.get("x-test-header") ?? "missing");
          }
        };
      `,
      "request-headers.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("Request headers are forwarded", async () => {
          const req = new Request("http://localhost/", {
            headers: {
              "x-test-header": "e2e-header-value"
            }
          });
          const res = await SELF.fetch(req);
          expect(await res.text()).toBe("e2e-header-value");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("request-headers.test.ts");
    });
  });

  test("supports SELF.fetch Request header overrides end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./request-header-override.test.ts"],
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
            return new Response(request.headers.get("x-test-header") ?? "missing");
          }
        };
      `,
      "request-header-override.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("Request init headers override original headers", async () => {
          const req = new Request("http://localhost/", {
            headers: {
              "x-test-header": "original-header"
            }
          });
          const res = await SELF.fetch(req, {
            headers: {
              "x-test-header": "override-header"
            }
          });
          expect(await res.text()).toBe("override-header");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("request-header-override.test.ts");
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

  test("resets fetchMock between fixture tests", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./fetch-mock-reset.test.ts"],
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
      "fetch-mock-reset.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF, fetchMock } from "cloudflare:test";

        test("first test leaves a pending interceptor", async () => {
          fetchMock.activate();
          fetchMock.disableNetConnect();
          fetchMock
            .get("http://example.com")
            .intercept({ path: "/unused", method: "GET" })
            .reply(200, "unused");

          expect(fetchMock.pendingInterceptors().length).toBe(1);
        });

        test("second test starts with a reset fetchMock", async () => {
          fetchMock.activate();
          expect(fetchMock.pendingInterceptors().length).toBe(0);

          fetchMock.disableNetConnect();
          fetchMock
            .get("http://example.com")
            .intercept({ path: "/data", method: "GET" })
            .reply(200, "after-reset");

          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("after-reset");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("fetch-mock-reset.test.ts");
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

  test("supports cloudflare:test-internal fetchMock alias", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./internal-fetch-mock.test.ts"],
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
            const response = await fetch("http://example.com/internal-data");
            return new Response(await response.text());
          }
        };
      `,
      "internal-fetch-mock.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF, fetchMock } from "cloudflare:test-internal";

        test("fetchMock works via internal alias", async () => {
          fetchMock.activate();
          fetchMock.disableNetConnect();
          fetchMock
            .get("http://example.com")
            .intercept({ path: "/internal-data", method: "GET" })
            .reply(200, "internal-mock-ok");

          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("internal-mock-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("internal-fetch-mock.test.ts");
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

  test("supports cloudflare:test-internal scheduled dispatch alias", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./internal-scheduled.test.ts"],
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
      "internal-scheduled.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test-internal";

        test("scheduled dispatch works via internal alias", async () => {
          await SELF.scheduled({
            cron: "15 * * * *",
            scheduledTime: 1700000000001
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

          expect(afterText).toBe("15 * * * *|1700000000001");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("internal-scheduled.test.ts");
    });
  });

  test("supports cloudflare:test-internal listDurableObjectIds alias", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./internal-do-list.test.ts"],
            poolOptions: {
              workers: {
                main: "./worker.ts",
                miniflare: {
                  durableObjects: {
                    COUNTER: "Counter"
                  },
                  durableObjectsPersist: "./.mf/do-internal"
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
      "internal-do-list.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF, env, listDurableObjectIds } from "cloudflare:test-internal";

        test("lists durable object ids via internal alias", async () => {
          const createdOne = await (await SELF.fetch("http://localhost/")).text();
          const createdTwo = await (await SELF.fetch("http://localhost/")).text();

          let idStrings: string[] = [];
          for (let i = 0; i < 10; i++) {
            const ids = await listDurableObjectIds(env.COUNTER as any);
            idStrings = ids.map((id) => String(id.toString()));
            if (idStrings.includes(createdOne) && idStrings.includes(createdTwo)) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }

          expect(idStrings).toContain(createdOne);
          expect(idStrings).toContain(createdTwo);
          expect(idStrings).toEqual([...idStrings].sort((a, b) => a.localeCompare(b)));
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("internal-do-list.test.ts");
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

        test("enumerates created object ids in deterministic order", async () => {
          const createdOne = await (await SELF.fetch("http://localhost/")).text();
          const createdTwo = await (await SELF.fetch("http://localhost/")).text();
          let idStrings: string[] = [];
          for (let i = 0; i < 10; i++) {
            const ids = await listDurableObjectIds(env.COUNTER as any);
            idStrings = ids.map((id) => String(id.toString()));
            if (idStrings.includes(createdOne) && idStrings.includes(createdTwo)) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(idStrings).toContain(createdOne);
          expect(idStrings).toContain(createdTwo);
          expect(idStrings).toEqual([...idStrings].sort((a, b) => a.localeCompare(b)));
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

  test("supports top-level workers function with inject() end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          include: ["./inject-top-level-workers.test.ts"],
          workers: ({ inject }) => ({
            main: "./worker.ts",
            miniflare: {
              bindings: {
                TOP_LEVEL_GREETING: inject("TOP_LEVEL_GREETING")
              }
            }
          })
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.TOP_LEVEL_GREETING));
          }
        };
      `,
      "inject-top-level-workers.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("top-level workers function inject value is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("hello-top-level-inject");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("inject-top-level-workers.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_TOP_LEVEL_GREETING: "\"hello-top-level-inject\""
        }
      }
    );
  });

  test("supports defineWorkersConfig top-level workers object end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          include: ["./top-level-workers-object.test.ts"],
          workers: {
            main: "./worker.ts",
            miniflare: {
              bindings: {
                TOP_LEVEL_OBJECT_GREETING: "hello-top-level-object"
              }
            }
          }
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.TOP_LEVEL_OBJECT_GREETING));
          }
        };
      `,
      "top-level-workers-object.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("top-level workers object is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("hello-top-level-object");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("top-level-workers-object.test.ts");
    });
  });

  test("supports sync config export with falsey plugin entries and preinstalled workers plugin end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersConfig({
          plugins: [false as any, workersRsbuildPlugin()],
          include: ["./sync-falsey-plugin.test.ts"],
          workers: {
            main: "./worker.ts",
            miniflare: {
              bindings: {
                SYNC_FALSEY_PLUGIN_VALUE: "sync-falsey-plugin-ok"
              }
            }
          }
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.SYNC_FALSEY_PLUGIN_VALUE));
          }
        };
      `,
      "sync-falsey-plugin.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("sync config with falsey + preinstalled workers plugin works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("sync-falsey-plugin-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("sync-falsey-plugin.test.ts");
    });
  });

  test("supports sync config export with preinstalled workers plugin as single value end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersConfig({
          plugins: workersRsbuildPlugin(),
          include: ["./sync-single-plugin.test.ts"],
          workers: {
            main: "./worker.ts",
            miniflare: {
              bindings: {
                SYNC_SINGLE_PLUGIN_VALUE: "sync-single-plugin-ok"
              }
            }
          }
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.SYNC_SINGLE_PLUGIN_VALUE));
          }
        };
      `,
      "sync-single-plugin.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("sync config with single preinstalled workers plugin works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("sync-single-plugin-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("sync-single-plugin.test.ts");
    });
  });

  test("prefers defineWorkersConfig top-level workers over nested workers end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          include: ["./workers-precedence.test.ts"],
          workers: {
            main: "./worker-top-level.ts",
            miniflare: {
              bindings: {
                WORKERS_PRECEDENCE: "top-level-selected"
              }
            }
          },
          test: {
            poolOptions: {
              workers: {
                main: "./worker-nested.ts",
                miniflare: {
                  bindings: {
                    WORKERS_PRECEDENCE: "nested-selected"
                  }
                }
              }
            }
          }
        });
      `,
      "worker-top-level.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.WORKERS_PRECEDENCE));
          }
        };
      `,
      "worker-nested.ts": `
        export default {
          fetch() {
            return new Response("nested-should-not-run");
          }
        };
      `,
      "workers-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("top-level workers value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("top-level-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("workers-precedence.test.ts");
    });
  });

  test("does not evaluate nested workers function when defineWorkersConfig top-level function is set end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          include: ["./workers-function-precedence.test.ts"],
          workers: () => ({
            main: "./worker-top-level.ts",
            miniflare: {
              bindings: {
                WORKERS_FUNCTION_PRECEDENCE: "top-level-function-selected"
              }
            }
          }),
          test: {
            poolOptions: {
              workers: () => {
                throw new Error("nested workers function should not execute");
              }
            }
          }
        });
      `,
      "worker-top-level.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.WORKERS_FUNCTION_PRECEDENCE));
          }
        };
      `,
      "workers-function-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("top-level workers function value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("top-level-function-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("workers-function-precedence.test.ts");
    });
  });

  test("supports top-level workers function inject() direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          include: ["./inject-top-level-direct-env.test.ts"],
          workers: ({ inject }) => ({
            main: "./worker.ts",
            miniflare: {
              bindings: {
                TOP_LEVEL_DIRECT_ENV: inject("TOP_LEVEL_DIRECT_ENV")
              }
            }
          })
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.TOP_LEVEL_DIRECT_ENV));
          }
        };
      `,
      "inject-top-level-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("top-level workers direct-env fallback value is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("hello-top-level-direct-env");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("inject-top-level-direct-env.test.ts");
      },
      {
        env: {
          TOP_LEVEL_DIRECT_ENV: "hello-top-level-direct-env"
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

  test("supports async config with thenable workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          test: {
            include: ["./async-thenable-workers-options.test.ts"],
            poolOptions: {
              workers: ({ inject }) => {
                const value = {
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      GREETING: inject("ASYNC_THENABLE_GREETING")
                    }
                  }
                };
                return {
                  then(resolve) {
                    resolve(value);
                    return Promise.resolve(value);
                  }
                };
              }
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
      "async-thenable-workers-options.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("thenable workers options are resolved before runtime starts", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("hello-from-async-thenable-inject");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("async-thenable-workers-options.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_ASYNC_THENABLE_GREETING: "\"hello-from-async-thenable-inject\""
        }
      }
    );
  });

  test("supports async config export with falsey plugin entries and preinstalled workers plugin end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersConfig(async () => ({
          plugins: [false as any, workersRsbuildPlugin()],
          include: ["./async-falsey-plugin.test.ts"],
          workers: {
            main: "./worker.ts",
            miniflare: {
              bindings: {
                ASYNC_FALSEY_PLUGIN_VALUE: "async-falsey-plugin-ok"
              }
            }
          }
        }));
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.ASYNC_FALSEY_PLUGIN_VALUE));
          }
        };
      `,
      "async-falsey-plugin.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("async config with falsey + preinstalled workers plugin works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("async-falsey-plugin-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("async-falsey-plugin.test.ts");
    });
  });

  test("supports async config export with preinstalled workers plugin as single value end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersConfig(async () => ({
          plugins: workersRsbuildPlugin(),
          include: ["./async-single-plugin.test.ts"],
          workers: {
            main: "./worker.ts",
            miniflare: {
              bindings: {
                ASYNC_SINGLE_PLUGIN_VALUE: "async-single-plugin-ok"
              }
            }
          }
        }));
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.ASYNC_SINGLE_PLUGIN_VALUE));
          }
        };
      `,
      "async-single-plugin.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("async config with single preinstalled workers plugin works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("async-single-plugin-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("async-single-plugin.test.ts");
    });
  });

  test("supports async config with top-level async workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          include: ["./async-top-level-workers.test.ts"],
          workers: async ({ inject }) => ({
            main: "./worker.ts",
            miniflare: {
              bindings: {
                TOP_LEVEL_ASYNC_GREETING: inject("TOP_LEVEL_ASYNC_GREETING")
              }
            }
          })
        }));
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.TOP_LEVEL_ASYNC_GREETING));
          }
        };
      `,
      "async-top-level-workers.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("top-level async workers function is resolved", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("hello-from-top-level-async");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("async-top-level-workers.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_TOP_LEVEL_ASYNC_GREETING: "\"hello-from-top-level-async\""
        }
      }
    );
  });

  test("supports async config with top-level thenable workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          include: ["./async-top-level-thenable-workers.test.ts"],
          workers: ({ inject }) => {
            const value = {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  TOP_LEVEL_THENABLE_GREETING: inject("TOP_LEVEL_THENABLE_GREETING")
                }
              }
            };
            return {
              then(resolve) {
                resolve(value);
                return Promise.resolve(value);
              }
            };
          }
        }));
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.TOP_LEVEL_THENABLE_GREETING));
          }
        };
      `,
      "async-top-level-thenable-workers.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("top-level thenable workers function is resolved", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("hello-from-top-level-thenable");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("async-top-level-thenable-workers.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_TOP_LEVEL_THENABLE_GREETING: "\"hello-from-top-level-thenable\""
        }
      }
    );
  });

  test("supports config function exports returning thenables end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => {
          const value = {
            include: ["./config-function-thenable.test.ts"],
            workers: {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  THENABLE_CONFIG_VALUE: "thenable-config-ok"
                }
              }
            }
          };
          return {
            then(resolve) {
              resolve(value);
              return Promise.resolve(value);
            }
          } as PromiseLike<typeof value>;
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.THENABLE_CONFIG_VALUE));
          }
        };
      `,
      "config-function-thenable.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("thenable config function export is resolved", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("thenable-config-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("config-function-thenable.test.ts");
    });
  });

  test("supports config function thenable exports with preinstalled workers plugin end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersConfig(() => {
          const value = {
            plugins: [workersRsbuildPlugin()],
            include: ["./config-function-thenable-preinstalled.test.ts"],
            workers: {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  THENABLE_CONFIG_PREINSTALLED_VALUE: "thenable-config-preinstalled-ok"
                }
              }
            }
          };
          return {
            then(resolve) {
              resolve(value);
              return Promise.resolve(value);
            }
          } as PromiseLike<typeof value>;
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.THENABLE_CONFIG_PREINSTALLED_VALUE));
          }
        };
      `,
      "config-function-thenable-preinstalled.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("thenable config function export with preinstalled plugin is resolved", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("thenable-config-preinstalled-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("config-function-thenable-preinstalled.test.ts");
    });
  });

  test("does not evaluate nested workers function in async config export when top-level async function is set end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          include: ["./async-function-precedence.test.ts"],
          workers: async () => ({
            main: "./worker.ts",
            miniflare: {
              bindings: {
                ASYNC_FUNCTION_PRECEDENCE: "async-top-level-function-selected"
              }
            }
          }),
          test: {
            poolOptions: {
              workers: () => {
                throw new Error("nested async workers function should not execute");
              }
            }
          }
        }));
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.ASYNC_FUNCTION_PRECEDENCE));
          }
        };
      `,
      "async-function-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("async top-level workers function value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("async-top-level-function-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("async-function-precedence.test.ts");
    });
  });

  test("supports async top-level workers function direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          include: ["./async-top-level-workers-direct-env.test.ts"],
          workers: async ({ inject }) => ({
            main: "./worker.ts",
            miniflare: {
              bindings: {
                TOP_LEVEL_ASYNC_DIRECT_ENV: inject("TOP_LEVEL_ASYNC_DIRECT_ENV")
              }
            }
          })
        }));
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.TOP_LEVEL_ASYNC_DIRECT_ENV));
          }
        };
      `,
      "async-top-level-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("top-level async workers direct env fallback is resolved", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("hello-from-top-level-async-direct-env");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("async-top-level-workers-direct-env.test.ts");
      },
      {
        env: {
          TOP_LEVEL_ASYNC_DIRECT_ENV: "hello-from-top-level-async-direct-env"
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

  test("supports promise-like config exports end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-config.test.ts"],
              workers: {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROMISE_LIKE_VALUE: "promise-like-config-ok"
                  }
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_LIKE_VALUE));
          }
        };
      `,
      "promise-like-config.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like config export resolves workers wiring", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-config-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-like-config.test.ts");
    });
  });

  test("supports promise-like config exports with top-level workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-workers-fn.test.ts"],
              workers: ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROMISE_LIKE_TOP_LEVEL_WORKERS_FN: inject("PROMISE_LIKE_TOP_LEVEL_WORKERS_FN")
                  }
                }
              })
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_LIKE_TOP_LEVEL_WORKERS_FN));
          }
        };
      `,
      "promise-like-top-level-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like top-level workers function is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-top-level-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-top-level-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_LIKE_TOP_LEVEL_WORKERS_FN:
            "\"promise-like-top-level-workers-fn-ok\""
        }
      }
    );
  });

  test("supports promise-like config exports with nested workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-workers-fn.test.ts"],
                poolOptions: {
                  workers: ({ inject }) => ({
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROMISE_LIKE_NESTED_WORKERS_FN: inject("PROMISE_LIKE_NESTED_WORKERS_FN")
                      }
                    }
                  })
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_LIKE_NESTED_WORKERS_FN));
          }
        };
      `,
      "promise-like-nested-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like nested workers function is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-nested-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-nested-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_LIKE_NESTED_WORKERS_FN:
            "\"promise-like-nested-workers-fn-ok\""
        }
      }
    );
  });

  test("supports promise-like config exports with nested async workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-async-workers-fn.test.ts"],
                poolOptions: {
                  workers: async ({ inject }) => ({
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROMISE_LIKE_NESTED_ASYNC_WORKERS_FN: inject("PROMISE_LIKE_NESTED_ASYNC_WORKERS_FN")
                      }
                    }
                  })
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_LIKE_NESTED_ASYNC_WORKERS_FN));
          }
        };
      `,
      "promise-like-nested-async-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like nested async workers function is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-nested-async-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-nested-async-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_LIKE_NESTED_ASYNC_WORKERS_FN:
            "\"promise-like-nested-async-workers-fn-ok\""
        }
      }
    );
  });

  test("supports promise-like config exports with nested thenable workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-thenable-workers-fn.test.ts"],
                poolOptions: {
                  workers: ({ inject }) => {
                    const workersValue = {
                      main: "./worker.ts",
                      miniflare: {
                        bindings: {
                          PROMISE_LIKE_NESTED_THENABLE_WORKERS_FN: inject("PROMISE_LIKE_NESTED_THENABLE_WORKERS_FN")
                        }
                      }
                    };
                    return {
                      then(nextResolve) {
                        nextResolve(workersValue);
                        return Promise.resolve(workersValue);
                      }
                    };
                  }
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_LIKE_NESTED_THENABLE_WORKERS_FN));
          }
        };
      `,
      "promise-like-nested-thenable-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like nested thenable workers function is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-nested-thenable-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-nested-thenable-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_LIKE_NESTED_THENABLE_WORKERS_FN:
            "\"promise-like-nested-thenable-workers-fn-ok\""
        }
      }
    );
  });

  test("supports promise-like config exports with top-level thenable workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-thenable-workers-fn.test.ts"],
              workers: ({ inject }) => {
                const workersValue = {
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_FN: inject("PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_FN")
                    }
                  }
                };
                return {
                  then(nextResolve) {
                    nextResolve(workersValue);
                    return Promise.resolve(workersValue);
                  }
                };
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_FN));
          }
        };
      `,
      "promise-like-top-level-thenable-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like top-level thenable workers function is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-top-level-thenable-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-top-level-thenable-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_FN:
            "\"promise-like-top-level-thenable-workers-fn-ok\""
        }
      }
    );
  });

  test("supports promise-like config exports with preinstalled workers plugin end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              plugins: [workersRsbuildPlugin()],
              include: ["./promise-like-preinstalled.test.ts"],
              workers: {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROMISE_LIKE_PREINSTALLED_VALUE: "promise-like-preinstalled-ok"
                  }
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_LIKE_PREINSTALLED_VALUE));
          }
        };
      `,
      "promise-like-preinstalled.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like preinstalled config export resolves workers wiring", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-preinstalled-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-like-preinstalled.test.ts");
    });
  });

  test("supports promise-like config exports with single preinstalled workers plugin value end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              plugins: workersRsbuildPlugin(),
              include: ["./promise-like-single-preinstalled.test.ts"],
              workers: {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROMISE_LIKE_SINGLE_PREINSTALLED_VALUE: "promise-like-single-preinstalled-ok"
                  }
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_LIKE_SINGLE_PREINSTALLED_VALUE));
          }
        };
      `,
      "promise-like-single-preinstalled.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like single preinstalled config export resolves workers wiring", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-single-preinstalled-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-like-single-preinstalled.test.ts");
    });
  });

  test("supports promise-like config exports with falsey plugin entries and preinstalled workers plugin end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              plugins: [false as any, workersRsbuildPlugin()],
              include: ["./promise-like-falsey-preinstalled.test.ts"],
              workers: {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROMISE_LIKE_FALSEY_PREINSTALLED_VALUE: "promise-like-falsey-preinstalled-ok"
                  }
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_LIKE_FALSEY_PREINSTALLED_VALUE));
          }
        };
      `,
      "promise-like-falsey-preinstalled.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like falsey preinstalled config export resolves workers wiring", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-falsey-preinstalled-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-like-falsey-preinstalled.test.ts");
    });
  });

  test("prefers top-level workers in promise-like config exports end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-precedence.test.ts"],
              workers: () => ({
                main: "./worker-top-level.ts",
                miniflare: {
                  bindings: {
                    PROMISE_LIKE_PRECEDENCE_VALUE: "promise-like-top-level-function-selected"
                  }
                }
              }),
              test: {
                poolOptions: {
                  workers: () => {
                    throw new Error("promise-like nested workers function should not execute");
                  }
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker-top-level.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_LIKE_PRECEDENCE_VALUE));
          }
        };
      `,
      "promise-like-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like top-level workers function value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-top-level-function-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-like-precedence.test.ts");
    });
  });

  test("supports promise config export with preinstalled workers plugin end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            plugins: [workersRsbuildPlugin()],
            include: ["./promise-preinstalled-plugin.test.ts"],
            workers: {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROMISE_PREINSTALLED_PLUGIN: "promise-preinstalled-plugin-ok"
                }
              }
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_PREINSTALLED_PLUGIN));
          }
        };
      `,
      "promise-preinstalled-plugin.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise config with preinstalled workers plugin works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-preinstalled-plugin-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-preinstalled-plugin.test.ts");
    });
  });

  test("supports promise config export with preinstalled workers plugin as single value end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            plugins: workersRsbuildPlugin(),
            include: ["./promise-preinstalled-plugin-single.test.ts"],
            workers: {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROMISE_PREINSTALLED_PLUGIN_SINGLE: "promise-preinstalled-plugin-single-ok"
                }
              }
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_PREINSTALLED_PLUGIN_SINGLE));
          }
        };
      `,
      "promise-preinstalled-plugin-single.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise config with single preinstalled workers plugin works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-preinstalled-plugin-single-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-preinstalled-plugin-single.test.ts");
    });
  });

  test("supports promise config export with falsey plugin entries and preinstalled workers plugin end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            plugins: [false as any, workersRsbuildPlugin()],
            include: ["./promise-preinstalled-plugin-falsey.test.ts"],
            workers: {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROMISE_PREINSTALLED_PLUGIN_FALSEY: "promise-preinstalled-plugin-falsey-ok"
                }
              }
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_PREINSTALLED_PLUGIN_FALSEY));
          }
        };
      `,
      "promise-preinstalled-plugin-falsey.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise config with falsey + preinstalled workers plugin works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-preinstalled-plugin-falsey-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-preinstalled-plugin-falsey.test.ts");
    });
  });

  test("prefers top-level workers in promise config exports end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-precedence.test.ts"],
            workers: {
              main: "./worker-top-level.ts",
              miniflare: {
                bindings: {
                  PROMISE_PRECEDENCE_VALUE: "promise-top-level-selected"
                }
              }
            },
            test: {
              poolOptions: {
                workers: {
                  main: "./worker-nested.ts",
                  miniflare: {
                    bindings: {
                      PROMISE_PRECEDENCE_VALUE: "promise-nested-selected"
                    }
                  }
                }
              }
            }
          })
        );
      `,
      "worker-top-level.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_PRECEDENCE_VALUE));
          }
        };
      `,
      "worker-nested.ts": `
        export default {
          fetch() {
            return new Response("promise-nested-should-not-run");
          }
        };
      `,
      "promise-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise top-level workers value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-top-level-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-precedence.test.ts");
    });
  });

  test("does not evaluate nested workers function in promise config export when top-level function is set end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-function-precedence.test.ts"],
            workers: () => ({
              main: "./worker-top-level.ts",
              miniflare: {
                bindings: {
                  PROMISE_FUNCTION_PRECEDENCE_VALUE: "promise-top-level-function-selected"
                }
              }
            }),
            test: {
              poolOptions: {
                workers: () => {
                  throw new Error("nested promise workers function should not execute");
                }
              }
            }
          })
        );
      `,
      "worker-top-level.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_FUNCTION_PRECEDENCE_VALUE));
          }
        };
      `,
      "promise-function-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise top-level workers function value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-top-level-function-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-function-precedence.test.ts");
    });
  });

  test("supports promise config export with nested workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-workers-fn.test.ts"],
              poolOptions: {
                workers: ({ inject }) => ({
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROMISE_NESTED_WORKERS_FN: inject("PROMISE_NESTED_WORKERS_FN")
                    }
                  }
                })
              }
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_NESTED_WORKERS_FN));
          }
        };
      `,
      "promise-nested-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise nested workers function wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-nested-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-nested-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_NESTED_WORKERS_FN: "\"promise-nested-workers-fn-ok\""
        }
      }
    );
  });

  test("supports promise config export with nested async workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-async-workers-fn.test.ts"],
              poolOptions: {
                workers: async ({ inject }) => ({
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROMISE_NESTED_ASYNC_WORKERS_FN: inject("PROMISE_NESTED_ASYNC_WORKERS_FN")
                    }
                  }
                })
              }
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_NESTED_ASYNC_WORKERS_FN));
          }
        };
      `,
      "promise-nested-async-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise nested async workers function wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-nested-async-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-nested-async-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_NESTED_ASYNC_WORKERS_FN:
            "\"promise-nested-async-workers-fn-ok\""
        }
      }
    );
  });

  test("supports promise config export with nested thenable workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-thenable-workers-fn.test.ts"],
              poolOptions: {
                workers: ({ inject }) => {
                  const value = {
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROMISE_NESTED_THENABLE_WORKERS_FN: inject("PROMISE_NESTED_THENABLE_WORKERS_FN")
                      }
                    }
                  };
                  return {
                    then(resolve) {
                      resolve(value);
                      return Promise.resolve(value);
                    }
                  };
                }
              }
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_NESTED_THENABLE_WORKERS_FN));
          }
        };
      `,
      "promise-nested-thenable-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise nested thenable workers function wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-nested-thenable-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-nested-thenable-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_NESTED_THENABLE_WORKERS_FN:
            "\"promise-nested-thenable-workers-fn-ok\""
        }
      }
    );
  });

  test("supports promise config export nested async workers function direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-async-workers-direct-env.test.ts"],
              poolOptions: {
                workers: async ({ inject }) => ({
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROMISE_NESTED_ASYNC_WORKERS_DIRECT_ENV: inject("PROMISE_NESTED_ASYNC_WORKERS_DIRECT_ENV")
                    }
                  }
                })
              }
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_NESTED_ASYNC_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "promise-nested-async-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise nested async workers direct-env fallback wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-nested-async-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-nested-async-workers-direct-env.test.ts");
      },
      {
        env: {
          PROMISE_NESTED_ASYNC_WORKERS_DIRECT_ENV: "promise-nested-async-workers-direct-env-ok"
        }
      }
    );
  });

  test("supports promise config export nested workers function direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-workers-fn-direct-env.test.ts"],
              poolOptions: {
                workers: ({ inject }) => ({
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROMISE_NESTED_WORKERS_FN_DIRECT_ENV: inject("PROMISE_NESTED_WORKERS_FN_DIRECT_ENV")
                    }
                  }
                })
              }
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_NESTED_WORKERS_FN_DIRECT_ENV));
          }
        };
      `,
      "promise-nested-workers-fn-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise nested workers direct-env fallback wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-nested-workers-fn-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-nested-workers-fn-direct-env.test.ts");
      },
      {
        env: {
          PROMISE_NESTED_WORKERS_FN_DIRECT_ENV: "promise-nested-workers-fn-direct-env-ok"
        }
      }
    );
  });

  test("supports promise config export with top-level workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-workers-fn.test.ts"],
            workers: ({ inject }) => ({
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROMISE_TOP_LEVEL_WORKERS_FN: inject("PROMISE_TOP_LEVEL_WORKERS_FN")
                }
              }
            })
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_TOP_LEVEL_WORKERS_FN));
          }
        };
      `,
      "promise-top-level-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise top-level workers function is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-top-level-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-top-level-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_TOP_LEVEL_WORKERS_FN: "\"promise-top-level-workers-fn-ok\""
        }
      }
    );
  });

  test("supports promise config export with async top-level workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-workers-fn-async.test.ts"],
            workers: async ({ inject }) => ({
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC: inject("PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC")
                }
              }
            })
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC));
          }
        };
      `,
      "promise-top-level-workers-fn-async.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise async top-level workers function is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-top-level-workers-fn-async-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-top-level-workers-fn-async.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC:
            "\"promise-top-level-workers-fn-async-ok\""
        }
      }
    );
  });

  test("supports promise config export with top-level thenable workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-workers-fn-thenable.test.ts"],
            workers: ({ inject }) => {
              const value = {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE: inject("PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE")
                  }
                }
              };
              return {
                then(resolve) {
                  resolve(value);
                  return Promise.resolve(value);
                }
              };
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE));
          }
        };
      `,
      "promise-top-level-workers-fn-thenable.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise top-level thenable workers function is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-top-level-workers-fn-thenable-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-top-level-workers-fn-thenable.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE:
            "\"promise-top-level-workers-fn-thenable-ok\""
        }
      }
    );
  });

  test("supports promise config export async top-level workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-workers-fn-async-direct-env.test.ts"],
            workers: async ({ inject }) => ({
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_DIRECT_ENV: inject("PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_DIRECT_ENV")
                }
              }
            })
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_DIRECT_ENV));
          }
        };
      `,
      "promise-top-level-workers-fn-async-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise async top-level workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-top-level-workers-fn-async-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-top-level-workers-fn-async-direct-env.test.ts");
      },
      {
        env: {
          PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_DIRECT_ENV:
            "promise-top-level-workers-fn-async-direct-env-ok"
        }
      }
    );
  });

  test("supports promise config export top-level workers function direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-workers-fn-direct-env.test.ts"],
            workers: ({ inject }) => ({
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROMISE_TOP_LEVEL_WORKERS_FN_DIRECT_ENV: inject("PROMISE_TOP_LEVEL_WORKERS_FN_DIRECT_ENV")
                }
              }
            })
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_TOP_LEVEL_WORKERS_FN_DIRECT_ENV));
          }
        };
      `,
      "promise-top-level-workers-fn-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise top-level workers function direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-top-level-workers-fn-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-top-level-workers-fn-direct-env.test.ts");
      },
      {
        env: {
          PROMISE_TOP_LEVEL_WORKERS_FN_DIRECT_ENV: "promise-top-level-workers-fn-direct-env-ok"
        }
      }
    );
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

  test("supports defineWorkersProject sync export with falsey plugin entries and preinstalled workers plugin end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersProject({
          plugins: [false as any, workersRsbuildPlugin()],
          include: ["./project-sync-falsey-plugin.test.ts"],
          workers: {
            main: "./worker.ts",
            miniflare: {
              bindings: {
                PROJECT_SYNC_FALSEY_PLUGIN_VALUE: "project-sync-falsey-plugin-ok"
              }
            }
          }
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_SYNC_FALSEY_PLUGIN_VALUE));
          }
        };
      `,
      "project-sync-falsey-plugin.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project sync config with falsey + preinstalled workers plugin works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-sync-falsey-plugin-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-sync-falsey-plugin.test.ts");
    });
  });

  test("supports defineWorkersProject sync export with preinstalled workers plugin as single value end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersProject({
          plugins: workersRsbuildPlugin(),
          include: ["./project-sync-single-plugin.test.ts"],
          workers: {
            main: "./worker.ts",
            miniflare: {
              bindings: {
                PROJECT_SYNC_SINGLE_PLUGIN_VALUE: "project-sync-single-plugin-ok"
              }
            }
          }
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_SYNC_SINGLE_PLUGIN_VALUE));
          }
        };
      `,
      "project-sync-single-plugin.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project sync config with single preinstalled workers plugin works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-sync-single-plugin-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-sync-single-plugin.test.ts");
    });
  });

  test("supports defineWorkersProject promise export end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise.test.ts"],
            workers: {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_VALUE: "project-promise-ok"
                }
              }
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_VALUE));
          }
        };
      `,
      "project-promise.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("defineWorkersProject promise export wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise.test.ts");
    });
  });

  test("supports defineWorkersProject promise-like export end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like.test.ts"],
              workers: {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_LIKE_VALUE: "project-promise-like-ok"
                  }
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_LIKE_VALUE));
          }
        };
      `,
      "project-promise-like.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("defineWorkersProject promise-like export wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-like.test.ts");
    });
  });

  test("supports defineWorkersProject promise-like export with top-level workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-workers-fn.test.ts"],
              workers: ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_LIKE_TOP_LEVEL_WORKERS_FN: inject("PROJECT_PROMISE_LIKE_TOP_LEVEL_WORKERS_FN")
                  }
                }
              })
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_LIKE_TOP_LEVEL_WORKERS_FN));
          }
        };
      `,
      "project-promise-like-top-level-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like top-level workers function is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-top-level-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-top-level-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_LIKE_TOP_LEVEL_WORKERS_FN:
            "\"project-promise-like-top-level-workers-fn-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise-like export with nested workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-workers-fn.test.ts"],
                poolOptions: {
                  workers: ({ inject }) => ({
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROJECT_PROMISE_LIKE_NESTED_WORKERS_FN: inject("PROJECT_PROMISE_LIKE_NESTED_WORKERS_FN")
                      }
                    }
                  })
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_LIKE_NESTED_WORKERS_FN));
          }
        };
      `,
      "project-promise-like-nested-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like nested workers function is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-nested-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-nested-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED_WORKERS_FN:
            "\"project-promise-like-nested-workers-fn-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise-like export with nested async workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-async-workers-fn.test.ts"],
                poolOptions: {
                  workers: async ({ inject }) => ({
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROJECT_PROMISE_LIKE_NESTED_ASYNC_WORKERS_FN: inject("PROJECT_PROMISE_LIKE_NESTED_ASYNC_WORKERS_FN")
                      }
                    }
                  })
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_LIKE_NESTED_ASYNC_WORKERS_FN));
          }
        };
      `,
      "project-promise-like-nested-async-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like nested async workers function is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-nested-async-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-nested-async-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED_ASYNC_WORKERS_FN:
            "\"project-promise-like-nested-async-workers-fn-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise-like export with nested thenable workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-thenable-workers-fn.test.ts"],
                poolOptions: {
                  workers: ({ inject }) => {
                    const workersValue = {
                      main: "./worker.ts",
                      miniflare: {
                        bindings: {
                          PROJECT_PROMISE_LIKE_NESTED_THENABLE_WORKERS_FN: inject("PROJECT_PROMISE_LIKE_NESTED_THENABLE_WORKERS_FN")
                        }
                      }
                    };
                    return {
                      then(nextResolve) {
                        nextResolve(workersValue);
                        return Promise.resolve(workersValue);
                      }
                    };
                  }
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_LIKE_NESTED_THENABLE_WORKERS_FN));
          }
        };
      `,
      "project-promise-like-nested-thenable-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like nested thenable workers function is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-nested-thenable-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-nested-thenable-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED_THENABLE_WORKERS_FN:
            "\"project-promise-like-nested-thenable-workers-fn-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise-like export with top-level thenable workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-thenable-workers-fn.test.ts"],
              workers: ({ inject }) => {
                const workersValue = {
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_FN: inject("PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_FN")
                    }
                  }
                };
                return {
                  then(nextResolve) {
                    nextResolve(workersValue);
                    return Promise.resolve(workersValue);
                  }
                };
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_FN));
          }
        };
      `,
      "project-promise-like-top-level-thenable-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like top-level thenable workers function is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-top-level-thenable-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-top-level-thenable-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_FN:
            "\"project-promise-like-top-level-thenable-workers-fn-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise-like export with preinstalled workers plugin end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              plugins: [workersRsbuildPlugin()],
              include: ["./project-promise-like-preinstalled.test.ts"],
              workers: {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_LIKE_PREINSTALLED_VALUE: "project-promise-like-preinstalled-ok"
                  }
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_LIKE_PREINSTALLED_VALUE));
          }
        };
      `,
      "project-promise-like-preinstalled.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("defineWorkersProject promise-like preinstalled export wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-preinstalled-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-like-preinstalled.test.ts");
    });
  });

  test("supports defineWorkersProject promise-like export with single preinstalled workers plugin value end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              plugins: workersRsbuildPlugin(),
              include: ["./project-promise-like-single-preinstalled.test.ts"],
              workers: {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_LIKE_SINGLE_PREINSTALLED_VALUE: "project-promise-like-single-preinstalled-ok"
                  }
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_LIKE_SINGLE_PREINSTALLED_VALUE));
          }
        };
      `,
      "project-promise-like-single-preinstalled.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("defineWorkersProject promise-like single preinstalled export wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-single-preinstalled-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-like-single-preinstalled.test.ts");
    });
  });

  test("supports defineWorkersProject promise-like export with falsey plugin entries and preinstalled workers plugin end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              plugins: [false as any, workersRsbuildPlugin()],
              include: ["./project-promise-like-falsey-preinstalled.test.ts"],
              workers: {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_LIKE_FALSEY_PREINSTALLED_VALUE: "project-promise-like-falsey-preinstalled-ok"
                  }
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_LIKE_FALSEY_PREINSTALLED_VALUE));
          }
        };
      `,
      "project-promise-like-falsey-preinstalled.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("defineWorkersProject promise-like falsey preinstalled export wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-falsey-preinstalled-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-like-falsey-preinstalled.test.ts");
    });
  });

  test("prefers top-level workers in defineWorkersProject promise-like exports end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-precedence.test.ts"],
              workers: () => ({
                main: "./worker-top-level.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_LIKE_PRECEDENCE_VALUE: "project-promise-like-top-level-function-selected"
                  }
                }
              }),
              test: {
                poolOptions: {
                  workers: () => {
                    throw new Error("project promise-like nested workers function should not execute");
                  }
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker-top-level.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_LIKE_PRECEDENCE_VALUE));
          }
        };
      `,
      "project-promise-like-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like top-level workers function value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-top-level-function-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-like-precedence.test.ts");
    });
  });

  test("supports defineWorkersProject config function exports returning thenables end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => {
          const value = {
            include: ["./project-config-function-thenable.test.ts"],
            workers: {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROJECT_THENABLE_CONFIG_VALUE: "project-thenable-config-ok"
                }
              }
            }
          };
          return {
            then(resolve) {
              resolve(value);
              return Promise.resolve(value);
            }
          } as PromiseLike<typeof value>;
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_THENABLE_CONFIG_VALUE));
          }
        };
      `,
      "project-config-function-thenable.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project thenable config function export is resolved", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-thenable-config-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-config-function-thenable.test.ts");
    });
  });

  test("supports defineWorkersProject config function thenable exports with preinstalled workers plugin end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersProject(() => {
          const value = {
            plugins: [workersRsbuildPlugin()],
            include: ["./project-config-function-thenable-preinstalled.test.ts"],
            workers: {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROJECT_THENABLE_CONFIG_PREINSTALLED_VALUE: "project-thenable-config-preinstalled-ok"
                }
              }
            }
          };
          return {
            then(resolve) {
              resolve(value);
              return Promise.resolve(value);
            }
          } as PromiseLike<typeof value>;
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_THENABLE_CONFIG_PREINSTALLED_VALUE));
          }
        };
      `,
      "project-config-function-thenable-preinstalled.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project thenable config function export with preinstalled plugin is resolved", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-thenable-config-preinstalled-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-config-function-thenable-preinstalled.test.ts");
    });
  });

  test("supports defineWorkersProject promise export with preinstalled workers plugin end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            plugins: [workersRsbuildPlugin()],
            include: ["./project-promise-preinstalled-plugin.test.ts"],
            workers: {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_PREINSTALLED_PLUGIN: "project-promise-preinstalled-plugin-ok"
                }
              }
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_PREINSTALLED_PLUGIN));
          }
        };
      `,
      "project-promise-preinstalled-plugin.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise config with preinstalled workers plugin works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-preinstalled-plugin-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-preinstalled-plugin.test.ts");
    });
  });

  test("supports defineWorkersProject promise export with preinstalled workers plugin as single value end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            plugins: workersRsbuildPlugin(),
            include: ["./project-promise-preinstalled-plugin-single.test.ts"],
            workers: {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_PREINSTALLED_PLUGIN_SINGLE: "project-promise-preinstalled-plugin-single-ok"
                }
              }
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_PREINSTALLED_PLUGIN_SINGLE));
          }
        };
      `,
      "project-promise-preinstalled-plugin-single.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise config with single preinstalled workers plugin works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-preinstalled-plugin-single-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-preinstalled-plugin-single.test.ts");
    });
  });

  test("supports defineWorkersProject promise export with falsey plugin entries and preinstalled workers plugin end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            plugins: [false as any, workersRsbuildPlugin()],
            include: ["./project-promise-preinstalled-plugin-falsey.test.ts"],
            workers: {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_PREINSTALLED_PLUGIN_FALSEY: "project-promise-preinstalled-plugin-falsey-ok"
                }
              }
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_PREINSTALLED_PLUGIN_FALSEY));
          }
        };
      `,
      "project-promise-preinstalled-plugin-falsey.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise config with falsey + preinstalled workers plugin works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-preinstalled-plugin-falsey-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-preinstalled-plugin-falsey.test.ts");
    });
  });

  test("prefers top-level workers in defineWorkersProject promise export end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-precedence.test.ts"],
            workers: {
              main: "./worker-top-level.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_PRECEDENCE_VALUE: "project-promise-top-level-selected"
                }
              }
            },
            test: {
              poolOptions: {
                workers: {
                  main: "./worker-nested.ts",
                  miniflare: {
                    bindings: {
                      PROJECT_PROMISE_PRECEDENCE_VALUE: "project-promise-nested-selected"
                    }
                  }
                }
              }
            }
          })
        );
      `,
      "worker-top-level.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_PRECEDENCE_VALUE));
          }
        };
      `,
      "worker-nested.ts": `
        export default {
          fetch() {
            return new Response("project-promise-nested-should-not-run");
          }
        };
      `,
      "project-promise-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise top-level workers value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-top-level-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-precedence.test.ts");
    });
  });

  test("does not evaluate nested workers function in defineWorkersProject promise export when top-level function is set end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-function-precedence.test.ts"],
            workers: () => ({
              main: "./worker-top-level.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_FUNCTION_PRECEDENCE_VALUE: "project-promise-top-level-function-selected"
                }
              }
            }),
            test: {
              poolOptions: {
                workers: () => {
                  throw new Error("project nested promise workers function should not execute");
                }
              }
            }
          })
        );
      `,
      "worker-top-level.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_FUNCTION_PRECEDENCE_VALUE));
          }
        };
      `,
      "project-promise-function-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise top-level workers function value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-top-level-function-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-function-precedence.test.ts");
    });
  });

  test("supports defineWorkersProject promise export with top-level workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-workers-fn.test.ts"],
            workers: ({ inject }) => ({
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN: inject("PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN")
                }
              }
            })
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN));
          }
        };
      `,
      "project-promise-top-level-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise top-level workers function is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-top-level-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-top-level-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN:
            "\"project-promise-top-level-workers-fn-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise export with async top-level workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-workers-fn-async.test.ts"],
            workers: async ({ inject }) => ({
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC: inject("PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC")
                }
              }
            })
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC));
          }
        };
      `,
      "project-promise-top-level-workers-fn-async.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise async top-level workers function is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-top-level-workers-fn-async-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-top-level-workers-fn-async.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC:
            "\"project-promise-top-level-workers-fn-async-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise export with top-level thenable workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-workers-fn-thenable.test.ts"],
            workers: ({ inject }) => {
              const value = {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE: inject("PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE")
                  }
                }
              };
              return {
                then(resolve) {
                  resolve(value);
                  return Promise.resolve(value);
                }
              };
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE));
          }
        };
      `,
      "project-promise-top-level-workers-fn-thenable.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise top-level thenable workers function is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-top-level-workers-fn-thenable-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-top-level-workers-fn-thenable.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE:
            "\"project-promise-top-level-workers-fn-thenable-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise export async top-level workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-workers-fn-async-direct-env.test.ts"],
            workers: async ({ inject }) => ({
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_DIRECT_ENV: inject("PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_DIRECT_ENV")
                }
              }
            })
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_DIRECT_ENV));
          }
        };
      `,
      "project-promise-top-level-workers-fn-async-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise async top-level workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-top-level-workers-fn-async-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-top-level-workers-fn-async-direct-env.test.ts");
      },
      {
        env: {
          PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_DIRECT_ENV:
            "project-promise-top-level-workers-fn-async-direct-env-ok"
        }
      }
    );
  });

  test("supports defineWorkersProject promise export top-level workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-workers-fn-direct-env.test.ts"],
            workers: ({ inject }) => ({
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_DIRECT_ENV: inject("PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_DIRECT_ENV")
                }
              }
            })
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_DIRECT_ENV));
          }
        };
      `,
      "project-promise-top-level-workers-fn-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise top-level workers function direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-top-level-workers-fn-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-top-level-workers-fn-direct-env.test.ts");
      },
      {
        env: {
          PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_DIRECT_ENV:
            "project-promise-top-level-workers-fn-direct-env-ok"
        }
      }
    );
  });

  test("supports defineWorkersProject promise export with nested test.poolOptions", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested.test.ts"],
              poolOptions: {
                workers: {
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROJECT_PROMISE_NESTED_VALUE: "project-promise-nested-ok"
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
            return new Response(String(env.PROJECT_PROMISE_NESTED_VALUE));
          }
        };
      `,
      "project-promise-nested.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("defineWorkersProject promise nested workers wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-nested-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-nested.test.ts");
    });
  });

  test("supports defineWorkersProject promise export with nested async workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-async-workers-fn.test.ts"],
              poolOptions: {
                workers: async ({ inject }) => ({
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROJECT_PROMISE_NESTED_ASYNC_WORKERS_FN: inject("PROJECT_PROMISE_NESTED_ASYNC_WORKERS_FN")
                    }
                  }
                })
              }
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_NESTED_ASYNC_WORKERS_FN));
          }
        };
      `,
      "project-promise-nested-async-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise nested async workers function wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-nested-async-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-nested-async-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_NESTED_ASYNC_WORKERS_FN:
            "\"project-promise-nested-async-workers-fn-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise export with nested thenable workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-thenable-workers-fn.test.ts"],
              poolOptions: {
                workers: ({ inject }) => {
                  const value = {
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROJECT_PROMISE_NESTED_THENABLE_WORKERS_FN: inject("PROJECT_PROMISE_NESTED_THENABLE_WORKERS_FN")
                      }
                    }
                  };
                  return {
                    then(resolve) {
                      resolve(value);
                      return Promise.resolve(value);
                    }
                  };
                }
              }
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_NESTED_THENABLE_WORKERS_FN));
          }
        };
      `,
      "project-promise-nested-thenable-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise nested thenable workers function wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-nested-thenable-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-nested-thenable-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_NESTED_THENABLE_WORKERS_FN:
            "\"project-promise-nested-thenable-workers-fn-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise nested async workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-async-workers-direct-env.test.ts"],
              poolOptions: {
                workers: async ({ inject }) => ({
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROJECT_PROMISE_NESTED_ASYNC_WORKERS_DIRECT_ENV: inject("PROJECT_PROMISE_NESTED_ASYNC_WORKERS_DIRECT_ENV")
                    }
                  }
                })
              }
            }
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_NESTED_ASYNC_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "project-promise-nested-async-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise nested async workers direct-env fallback wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-nested-async-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-nested-async-workers-direct-env.test.ts");
      },
      {
        env: {
          PROJECT_PROMISE_NESTED_ASYNC_WORKERS_DIRECT_ENV:
            "project-promise-nested-async-workers-direct-env-ok"
        }
      }
    );
  });

  test("supports defineWorkersProject async workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          test: {
            include: ["./project-async-workers.test.ts"],
            poolOptions: {
              workers: async ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROJECT_ASYNC_VALUE: inject("PROJECT_ASYNC_VALUE")
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
            return new Response(String(env.PROJECT_ASYNC_VALUE));
          }
        };
      `,
      "project-async-workers.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("defineWorkersProject async workers options wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-async-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-async-workers.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_ASYNC_VALUE: "\"project-async-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject async thenable workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          test: {
            include: ["./project-async-thenable-workers.test.ts"],
            poolOptions: {
              workers: ({ inject }) => {
                const value = {
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROJECT_ASYNC_THENABLE_VALUE: inject("PROJECT_ASYNC_THENABLE_VALUE")
                    }
                  }
                };
                return {
                  then(resolve) {
                    resolve(value);
                    return Promise.resolve(value);
                  }
                };
              }
            }
          }
        }));
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_ASYNC_THENABLE_VALUE));
          }
        };
      `,
      "project-async-thenable-workers.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("defineWorkersProject async thenable workers options wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-async-thenable-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-async-thenable-workers.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_ASYNC_THENABLE_VALUE: "\"project-async-thenable-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject async export with falsey plugin entries and preinstalled workers plugin end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersProject(async () => ({
          plugins: [false as any, workersRsbuildPlugin()],
          include: ["./project-async-falsey-plugin.test.ts"],
          workers: {
            main: "./worker.ts",
            miniflare: {
              bindings: {
                PROJECT_ASYNC_FALSEY_PLUGIN_VALUE: "project-async-falsey-plugin-ok"
              }
            }
          }
        }));
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_ASYNC_FALSEY_PLUGIN_VALUE));
          }
        };
      `,
      "project-async-falsey-plugin.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project async config with falsey + preinstalled workers plugin works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-async-falsey-plugin-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-async-falsey-plugin.test.ts");
    });
  });

  test("supports defineWorkersProject async export with preinstalled workers plugin as single value end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersProject(async () => ({
          plugins: workersRsbuildPlugin(),
          include: ["./project-async-single-plugin.test.ts"],
          workers: {
            main: "./worker.ts",
            miniflare: {
              bindings: {
                PROJECT_ASYNC_SINGLE_PLUGIN_VALUE: "project-async-single-plugin-ok"
              }
            }
          }
        }));
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_ASYNC_SINGLE_PLUGIN_VALUE));
          }
        };
      `,
      "project-async-single-plugin.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project async config with single preinstalled workers plugin works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-async-single-plugin-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-async-single-plugin.test.ts");
    });
  });

  test("supports defineWorkersProject inject() direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          test: {
            include: ["./project-direct-fallback.test.ts"],
            poolOptions: {
              workers: async ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROJECT_DIRECT_VALUE: inject("PROJECT_DIRECT_VALUE")
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
            return new Response(String(env.PROJECT_DIRECT_VALUE));
          }
        };
      `,
      "project-direct-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("direct env fallback works through defineWorkersProject", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-direct-fallback-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-direct-fallback.test.ts");
      },
      {
        env: {
          PROJECT_DIRECT_VALUE: "project-direct-fallback-ok"
        }
      }
    );
  });

  test("supports defineWorkersProject sync workers function with inject() end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          test: {
            include: ["./project-sync-workers.test.ts"],
            poolOptions: {
              workers: ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROJECT_SYNC_GREETING: inject("PROJECT_SYNC_GREETING")
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
            return new Response(String(env.PROJECT_SYNC_GREETING));
          }
        };
      `,
      "project-sync-workers.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("sync workers function inject value is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-sync-inject-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-sync-workers.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_SYNC_GREETING: "\"project-sync-inject-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject top-level workers function with inject() end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          include: ["./project-top-level-workers-fn.test.ts"],
          workers: ({ inject }) => ({
            main: "./worker.ts",
            miniflare: {
              bindings: {
                PROJECT_TOP_LEVEL_FN_VALUE: inject("PROJECT_TOP_LEVEL_FN_VALUE")
              }
            }
          })
        });
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_TOP_LEVEL_FN_VALUE));
          }
        };
      `,
      "project-top-level-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("top-level workers function inject value is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-top-level-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-top-level-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_TOP_LEVEL_FN_VALUE: "\"project-top-level-workers-fn-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject async config with top-level async workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          include: ["./project-top-level-async-workers-fn.test.ts"],
          workers: async ({ inject }) => ({
            main: "./worker.ts",
            miniflare: {
              bindings: {
                PROJECT_TOP_LEVEL_ASYNC_FN_VALUE: inject("PROJECT_TOP_LEVEL_ASYNC_FN_VALUE")
              }
            }
          })
        }));
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_TOP_LEVEL_ASYNC_FN_VALUE));
          }
        };
      `,
      "project-top-level-async-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("top-level async workers function inject value is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-top-level-async-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-top-level-async-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_TOP_LEVEL_ASYNC_FN_VALUE: "\"project-top-level-async-workers-fn-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject async config with top-level thenable workers function end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          include: ["./project-top-level-thenable-workers-fn.test.ts"],
          workers: ({ inject }) => {
            const value = {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROJECT_TOP_LEVEL_THENABLE_FN_VALUE: inject("PROJECT_TOP_LEVEL_THENABLE_FN_VALUE")
                }
              }
            };
            return {
              then(resolve) {
                resolve(value);
                return Promise.resolve(value);
              }
            };
          }
        }));
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_TOP_LEVEL_THENABLE_FN_VALUE));
          }
        };
      `,
      "project-top-level-thenable-workers-fn.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project top-level thenable workers function inject value is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-top-level-thenable-workers-fn-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-top-level-thenable-workers-fn.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_TOP_LEVEL_THENABLE_FN_VALUE:
            "\"project-top-level-thenable-workers-fn-ok\""
        }
      }
    );
  });

  test("does not evaluate nested workers function in defineWorkersProject async config export when top-level async function is set end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          include: ["./project-async-function-precedence.test.ts"],
          workers: async () => ({
            main: "./worker.ts",
            miniflare: {
              bindings: {
                PROJECT_ASYNC_FUNCTION_PRECEDENCE: "project-async-top-level-function-selected"
              }
            }
          }),
          test: {
            poolOptions: {
              workers: () => {
                throw new Error("project nested async workers function should not execute");
              }
            }
          }
        }));
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_ASYNC_FUNCTION_PRECEDENCE));
          }
        };
      `,
      "project-async-function-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project async top-level workers function value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-async-top-level-function-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-async-function-precedence.test.ts");
    });
  });

  test("supports defineWorkersProject async top-level workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          include: ["./project-top-level-async-workers-direct-env.test.ts"],
          workers: async ({ inject }) => ({
            main: "./worker.ts",
            miniflare: {
              bindings: {
                PROJECT_TOP_LEVEL_ASYNC_DIRECT_ENV: inject("PROJECT_TOP_LEVEL_ASYNC_DIRECT_ENV")
              }
            }
          })
        }));
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_TOP_LEVEL_ASYNC_DIRECT_ENV));
          }
        };
      `,
      "project-top-level-async-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("top-level async workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-top-level-async-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-top-level-async-workers-direct-env.test.ts");
      },
      {
        env: {
          PROJECT_TOP_LEVEL_ASYNC_DIRECT_ENV: "project-top-level-async-workers-direct-env-ok"
        }
      }
    );
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

  test("prefers defineWorkersProject top-level workers over nested workers end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          include: ["./project-workers-precedence.test.ts"],
          workers: {
            main: "./worker-top-level.ts",
            miniflare: {
              bindings: {
                PROJECT_WORKERS_PRECEDENCE: "project-top-level-selected"
              }
            }
          },
          test: {
            poolOptions: {
              workers: {
                main: "./worker-nested.ts",
                miniflare: {
                  bindings: {
                    PROJECT_WORKERS_PRECEDENCE: "project-nested-selected"
                  }
                }
              }
            }
          }
        });
      `,
      "worker-top-level.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_WORKERS_PRECEDENCE));
          }
        };
      `,
      "worker-nested.ts": `
        export default {
          fetch() {
            return new Response("project-nested-should-not-run");
          }
        };
      `,
      "project-workers-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project top-level workers value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-top-level-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-workers-precedence.test.ts");
    });
  });

  test("does not evaluate nested workers function when defineWorkersProject top-level function is set end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          include: ["./project-workers-function-precedence.test.ts"],
          workers: () => ({
            main: "./worker-top-level.ts",
            miniflare: {
              bindings: {
                PROJECT_WORKERS_FUNCTION_PRECEDENCE: "project-top-level-function-selected"
              }
            }
          }),
          test: {
            poolOptions: {
              workers: () => {
                throw new Error("project nested workers function should not execute");
              }
            }
          }
        });
      `,
      "worker-top-level.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_WORKERS_FUNCTION_PRECEDENCE));
          }
        };
      `,
      "project-workers-function-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project top-level workers function value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-top-level-function-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-workers-function-precedence.test.ts");
    });
  });
});
