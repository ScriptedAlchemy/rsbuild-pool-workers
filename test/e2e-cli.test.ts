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

  async function runFixtureExpectFailure(
    files: Record<string, string>,
    assertions: (result: { stdout: string; stderr: string }) => void,
    options?: { env?: Record<string, string | undefined> }
  ): Promise<void> {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-e2e-fail-"));
    const packageRoot = process.cwd();

    try {
      for (const [relativePath, contents] of Object.entries(files)) {
        const filePath = path.join(tempRoot, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, contents.trimStart(), "utf8");
      }

      const rstestBin = path.join(packageRoot, "node_modules", ".bin", "rstest");
      try {
        await execFileAsync(
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
        throw new Error("Expected fixture run to fail, but it succeeded");
      } catch (error) {
        if (error instanceof Error && error.message === "Expected fixture run to fail, but it succeeded") {
          throw error;
        }

        const stdout =
          error && typeof error === "object"
            ? String((error as { stdout?: string }).stdout ?? "")
            : "";
        const stderr =
          error && typeof error === "object"
            ? String((error as { stderr?: string }).stderr ?? "")
            : String(error);

        assertions({ stdout, stderr });
      }
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

  test("singleWorker false recreates worker isolate between test cases end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./single-worker-false.test.ts"],
            poolOptions: {
              workers: {
                main: "./worker.ts",
                singleWorker: false
              }
            }
          }
        });
      `,
      "worker.ts": `
        let count = 0;
        export default {
          fetch() {
            count += 1;
            return new Response(String(count));
          }
        };
      `,
      "single-worker-false.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("first case starts at one", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("1");
        });

        test("second case also starts at one", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("1");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("single-worker-false.test.ts");
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

  test("supports runInDurableObject state-like storage helpers on synthetic stubs", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./do-state-storage-helpers.test.ts"],
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
          async fetch() {
            return new Response("ok");
          }
        }

        export default {
          fetch() {
            return new Response("ok");
          }
        };
      `,
      "do-state-storage-helpers.test.ts": `
        import { test, expect } from "@rstest/core";
        import { env, runInDurableObject } from "cloudflare:test";

        test("callbacks receive exposed state-like storage helpers", async () => {
          const namespace = env.COUNTER as {
            idFromName(name: string): unknown;
          };
          const id = namespace.idFromName("singleton");
          const calls: string[] = [];
          let storedValue: unknown;

          class WorkerRpc {
            id: unknown;
            ctx: unknown;
            constructor(stubId: unknown, state: unknown) {
              this.id = stubId;
              this.ctx = state;
            }
            async fetch() {
              return new Response("ok");
            }
          }

          const state = {
            storage: {
              async put(key: string, value: unknown) {
                calls.push("put:" + key);
                storedValue = value;
              },
              async get<T = unknown>(key: string): Promise<T | undefined> {
                calls.push("get:" + key);
                return storedValue as T | undefined;
              },
              async list<T = unknown>() {
                calls.push("list");
                return new Map<string, T>([["entry", storedValue as T]]);
              }
            },
            async blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T> {
              calls.push("blockConcurrencyWhile");
              return closure();
            }
          };

          const stub = new WorkerRpc(id, state);
          const result = await runInDurableObject(stub as any, async (_instance, receivedState) => {
            if ("__kind" in receivedState) {
              throw new Error("expected exposed state-like object");
            }

            return receivedState.blockConcurrencyWhile?.(async () => {
              await receivedState.storage.put?.("count", 123);
              const loaded = await receivedState.storage.get?.<number>("count");
              const listed = await receivedState.storage.list?.<number>();
              return {
                loaded,
                listed: listed ? Array.from(listed.values()) : []
              };
            });
          });

          expect(result).toEqual({
            loaded: 123,
            listed: [123]
          });
          expect(calls).toEqual([
            "blockConcurrencyWhile",
            "put:count",
            "get:count",
            "list"
          ]);
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("do-state-storage-helpers.test.ts");
    });
  });

  test("supports runInDurableObject transaction-like helpers on synthetic stubs", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./do-state-transaction-helpers.test.ts"],
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
          async fetch() {
            return new Response("ok");
          }
        }

        export default {
          fetch() {
            return new Response("ok");
          }
        };
      `,
      "do-state-transaction-helpers.test.ts": `
        import { test, expect } from "@rstest/core";
        import { env, runInDurableObject } from "cloudflare:test";

        test("callbacks can use exposed transaction-like storage helpers", async () => {
          const namespace = env.COUNTER as {
            idFromName(name: string): unknown;
          };
          const id = namespace.idFromName("singleton");
          const operations: string[] = [];

          class WorkerRpc {
            id: unknown;
            ctx: unknown;
            constructor(stubId: unknown, state: unknown) {
              this.id = stubId;
              this.ctx = state;
            }
            async fetch() {
              return new Response("ok");
            }
          }

          const state = {
            storage: {
              async transaction<T>(closure: (txn: any) => Promise<T>): Promise<T> {
                operations.push("transaction");
                const txn = {
                  async put(key: string, value: unknown) {
                    operations.push("txn.put:" + key + ":" + String(value));
                  },
                  async get<TValue = unknown>(key: string): Promise<TValue> {
                    operations.push("txn.get:" + key);
                    return ("txn-value-" + key) as TValue;
                  },
                  rollback() {
                    operations.push("txn.rollback");
                  }
                };
                return closure(txn);
              },
              transactionSync<T>(closure: () => T): T {
                operations.push("transactionSync");
                return closure();
              },
              async getCurrentBookmark(): Promise<string> {
                operations.push("getCurrentBookmark");
                return "bookmark-1";
              },
              async getBookmarkForTime(_timestamp: number | Date): Promise<string> {
                operations.push("getBookmarkForTime");
                return "bookmark-2";
              },
              async onNextSessionRestoreBookmark(_bookmark: string): Promise<string> {
                operations.push("onNextSessionRestoreBookmark");
                return "bookmark-3";
              }
            }
          };

          const stub = new WorkerRpc(id, state);
          const result = await runInDurableObject(stub as any, async (_instance, receivedState) => {
            if ("__kind" in receivedState) {
              throw new Error("expected exposed state-like object");
            }

            const txnResult = await receivedState.storage.transaction?.(async (txn) => {
              await txn.put?.("count", 5);
              await txn.get?.("count");
              txn.rollback?.();
              return "transaction-complete";
            });
            const syncResult = receivedState.storage.transactionSync?.(() => {
              operations.push("transactionSync.closure");
              return "sync-complete";
            });
            const bookmarks = [
              await receivedState.storage.getCurrentBookmark?.(),
              await receivedState.storage.getBookmarkForTime?.(Date.now()),
              await receivedState.storage.onNextSessionRestoreBookmark?.("bookmark-1")
            ];

            return { txnResult, syncResult, bookmarks };
          });

          expect(result).toEqual({
            txnResult: "transaction-complete",
            syncResult: "sync-complete",
            bookmarks: ["bookmark-1", "bookmark-2", "bookmark-3"]
          });
          expect(operations).toEqual([
            "transaction",
            "txn.put:count:5",
            "txn.get:count",
            "txn.rollback",
            "transactionSync",
            "transactionSync.closure",
            "getCurrentBookmark",
            "getBookmarkForTime",
            "onNextSessionRestoreBookmark"
          ]);
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("do-state-transaction-helpers.test.ts");
    });
  });

  test("supports runInDurableObject state id and waitUntil helpers on synthetic stubs", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./do-state-id-waituntil.test.ts"],
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
          async fetch() {
            return new Response("ok");
          }
        }

        export default {
          fetch() {
            return new Response("ok");
          }
        };
      `,
      "do-state-id-waituntil.test.ts": `
        import { test, expect } from "@rstest/core";
        import { env, runInDurableObject } from "cloudflare:test";

        test("callbacks can read state id and call waitUntil when exposed", async () => {
          const namespace = env.COUNTER as {
            idFromName(name: string): unknown;
          };
          const id = namespace.idFromName("singleton");
          let waitUntilCalls = 0;
          let waitUntilSettled = false;

          class WorkerRpc {
            id: unknown;
            ctx: unknown;
            constructor(stubId: unknown, state: unknown) {
              this.id = stubId;
              this.ctx = state;
            }
            async fetch() {
              return new Response("ok");
            }
          }

          const state = {
            id: {
              toString: () => "state-id-from-synthetic-stub"
            },
            storage: {},
            waitUntil(promise: Promise<unknown>) {
              waitUntilCalls += 1;
              void promise.then(() => {
                waitUntilSettled = true;
              });
            }
          };

          const stub = new WorkerRpc(id, state);
          const result = await runInDurableObject(stub as any, async (_instance, receivedState) => {
            if ("__kind" in receivedState) {
              throw new Error("expected exposed state-like object");
            }
            receivedState.waitUntil?.(Promise.resolve("done"));
            return receivedState.id?.toString();
          });

          await Promise.resolve();
          expect(result).toBe("state-id-from-synthetic-stub");
          expect(waitUntilCalls).toBe(1);
          expect(waitUntilSettled).toBe(true);
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("do-state-id-waituntil.test.ts");
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

  test("supports cloudflare:test-internal state-like helpers on synthetic stubs", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./internal-do-state-like.test.ts"],
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
          async fetch() {
            return new Response("ok");
          }
        }

        export default {
          fetch() {
            return new Response("ok");
          }
        };
      `,
      "internal-do-state-like.test.ts": `
        import { test, expect } from "@rstest/core";
        import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test-internal";

        test("internal alias supports state-like helper pass-through on synthetic stubs", async () => {
          const namespace = env.COUNTER as {
            idFromName(name: string): unknown;
          };
          const id = namespace.idFromName("singleton");
          let value = 0;
          const operations: string[] = [];
          let deleteAlarmCalls = 0;

          class WorkerRpc {
            id: unknown;
            state: unknown;
            constructor(stubId: unknown, stubState: unknown) {
              this.id = stubId;
              this.state = stubState;
            }
            async fetch() {
              return new Response("ok");
            }
          }

          const state = {
            storage: {
              async put(key: string, nextValue: number) {
                operations.push("put:" + key);
                value = nextValue;
              },
              async get<T = unknown>(key: string): Promise<T | undefined> {
                operations.push("get:" + key);
                return value as T;
              },
              async getAlarm(): Promise<number | null> {
                operations.push("getAlarm");
                return Date.now() + 10_000;
              },
              async deleteAlarm(): Promise<void> {
                operations.push("deleteAlarm");
                deleteAlarmCalls += 1;
              }
            },
            async blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T> {
              operations.push("blockConcurrencyWhile");
              return closure();
            }
          };

          const stub = new WorkerRpc(id, state);

          const loaded = await runInDurableObject(stub as any, async (_instance, receivedState) => {
            if ("__kind" in receivedState) {
              throw new Error("expected exposed state-like object");
            }
            return receivedState.blockConcurrencyWhile?.(async () => {
              await receivedState.storage.put?.("count", 99);
              return receivedState.storage.get?.<number>("count");
            });
          });

          await expect(runDurableObjectAlarm(stub as any)).resolves.toBe(true);
          expect(loaded).toBe(99);
          expect(deleteAlarmCalls).toBe(1);
          expect(operations).toEqual([
            "blockConcurrencyWhile",
            "put:count",
            "get:count",
            "getAlarm",
            "deleteAlarm"
          ]);
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("internal-do-state-like.test.ts");
    });
  });

  test("supports cloudflare:test-internal transaction-like helpers on synthetic stubs", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./internal-do-transaction-like.test.ts"],
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
          async fetch() {
            return new Response("ok");
          }
        }

        export default {
          fetch() {
            return new Response("ok");
          }
        };
      `,
      "internal-do-transaction-like.test.ts": `
        import { test, expect } from "@rstest/core";
        import { env, runInDurableObject } from "cloudflare:test-internal";

        test("internal alias supports transaction-like helper pass-through", async () => {
          const namespace = env.COUNTER as {
            idFromName(name: string): unknown;
          };
          const id = namespace.idFromName("singleton");
          const operations: string[] = [];

          class WorkerRpc {
            id: unknown;
            state: unknown;
            constructor(stubId: unknown, stubState: unknown) {
              this.id = stubId;
              this.state = stubState;
            }
            async fetch() {
              return new Response("ok");
            }
          }

          const state = {
            storage: {
              async transaction<T>(closure: (txn: any) => Promise<T>): Promise<T> {
                operations.push("transaction");
                const txn = {
                  async put(key: string, value: unknown) {
                    operations.push("txn.put:" + key + ":" + String(value));
                  },
                  async get<TValue = unknown>(key: string): Promise<TValue> {
                    operations.push("txn.get:" + key);
                    return ("txn-value-" + key) as TValue;
                  }
                };
                return closure(txn);
              },
              transactionSync<T>(closure: () => T): T {
                operations.push("transactionSync");
                return closure();
              },
              async getCurrentBookmark(): Promise<string> {
                operations.push("getCurrentBookmark");
                return "bookmark-internal";
              }
            }
          };

          const stub = new WorkerRpc(id, state);
          const result = await runInDurableObject(stub as any, async (_instance, receivedState) => {
            if ("__kind" in receivedState) {
              throw new Error("expected exposed state-like object");
            }

            const txn = await receivedState.storage.transaction?.(async (transaction) => {
              await transaction.put?.("count", 7);
              return transaction.get?.<string>("count");
            });
            const sync = receivedState.storage.transactionSync?.(() => {
              operations.push("transactionSync.closure");
              return "sync-internal";
            });
            const bookmark = await receivedState.storage.getCurrentBookmark?.();
            return { txn, sync, bookmark };
          });

          expect(result).toEqual({
            txn: "txn-value-count",
            sync: "sync-internal",
            bookmark: "bookmark-internal"
          });
          expect(operations).toEqual([
            "transaction",
            "txn.put:count:7",
            "txn.get:count",
            "transactionSync",
            "transactionSync.closure",
            "getCurrentBookmark"
          ]);
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("internal-do-transaction-like.test.ts");
    });
  });

  test("supports cloudflare:test-internal state id and waitUntil helpers on synthetic stubs", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./internal-do-state-id-waituntil.test.ts"],
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
          async fetch() {
            return new Response("ok");
          }
        }

        export default {
          fetch() {
            return new Response("ok");
          }
        };
      `,
      "internal-do-state-id-waituntil.test.ts": `
        import { test, expect } from "@rstest/core";
        import { env, runInDurableObject } from "cloudflare:test-internal";

        test("internal alias callbacks can read state id and call waitUntil", async () => {
          const namespace = env.COUNTER as {
            idFromName(name: string): unknown;
          };
          const id = namespace.idFromName("singleton");
          let waitUntilCalls = 0;
          let waitUntilSettled = false;

          class WorkerRpc {
            id: unknown;
            state: unknown;
            constructor(stubId: unknown, stubState: unknown) {
              this.id = stubId;
              this.state = stubState;
            }
            async fetch() {
              return new Response("ok");
            }
          }

          const state = {
            id: {
              toString: () => "internal-state-id-value"
            },
            storage: {},
            waitUntil(promise: Promise<unknown>) {
              waitUntilCalls += 1;
              void promise.then(() => {
                waitUntilSettled = true;
              });
            }
          };

          const stub = new WorkerRpc(id, state);
          const result = await runInDurableObject(stub as any, async (_instance, receivedState) => {
            if ("__kind" in receivedState) {
              throw new Error("expected exposed state-like object");
            }
            receivedState.waitUntil?.(Promise.resolve("done"));
            return receivedState.id?.toString();
          });

          await Promise.resolve();
          expect(result).toBe("internal-state-id-value");
          expect(waitUntilCalls).toBe(1);
          expect(waitUntilSettled).toBe(true);
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("internal-do-state-id-waituntil.test.ts");
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

  test("surfaces actionable error when runDurableObjectAlarm is used with runtime stubs", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./do-runtime-alarm-guidance.test.ts"],
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
          async alarm() {
            await this.ctx.storage.put("alarm-ran", "yes");
          }
          async fetch(request) {
            if (new URL(request.url).pathname === "/set") {
              await this.ctx.storage.setAlarm(Date.now() + 1_000);
              return new Response("set");
            }
            return new Response("ok");
          }
        }

        export default {
          async fetch(_request, env) {
            const id = env.COUNTER.idFromName("singleton");
            await env.COUNTER.get(id).fetch("http://localhost/set");
            return new Response("ok");
          }
        };
      `,
      "do-runtime-alarm-guidance.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF, env, runDurableObjectAlarm } from "cloudflare:test";

        test("runtime alarm stubs throw actionable guidance", async () => {
          await SELF.fetch("http://localhost/");
          const namespace = env.COUNTER as {
            idFromName(name: string): unknown;
            get(id: unknown): unknown;
          };
          const stub = namespace.get(namespace.idFromName("singleton"));

          await expect(
            runDurableObjectAlarm(stub as any)
          ).rejects.toThrow(
            "runDurableObjectAlarm(): invoking alarm() on runtime Durable Object stubs is not yet supported in Rstest mode."
          );
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("do-runtime-alarm-guidance.test.ts");
    });
  });

  test("surfaces actionable error when runDurableObjectAlarm is used via cloudflare:test-internal", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./do-runtime-alarm-internal-guidance.test.ts"],
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
          async alarm() {
            await this.ctx.storage.put("alarm-ran", "yes");
          }
          async fetch(request) {
            if (new URL(request.url).pathname === "/set") {
              await this.ctx.storage.setAlarm(Date.now() + 1_000);
              return new Response("set");
            }
            return new Response("ok");
          }
        }

        export default {
          async fetch(_request, env) {
            const id = env.COUNTER.idFromName("singleton");
            await env.COUNTER.get(id).fetch("http://localhost/set");
            return new Response("ok");
          }
        };
      `,
      "do-runtime-alarm-internal-guidance.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF, env, runDurableObjectAlarm } from "cloudflare:test-internal";

        test("runtime alarm stubs throw actionable guidance through internal alias", async () => {
          await SELF.fetch("http://localhost/");
          const namespace = env.COUNTER as {
            idFromName(name: string): unknown;
            get(id: unknown): unknown;
          };
          const stub = namespace.get(namespace.idFromName("singleton"));

          await expect(
            runDurableObjectAlarm(stub as any)
          ).rejects.toThrow(
            "runDurableObjectAlarm(): invoking alarm() on runtime Durable Object stubs is not yet supported in Rstest mode."
          );
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("do-runtime-alarm-internal-guidance.test.ts");
    });
  });

  test("supports runDurableObjectAlarm with same-isolate synthetic stubs end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./do-alarm-synthetic-stub.test.ts"],
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
          async fetch() {
            return new Response("ok");
          }
        }

        export default {
          fetch() {
            return new Response("ok");
          }
        };
      `,
      "do-alarm-synthetic-stub.test.ts": `
        import { test, expect } from "@rstest/core";
        import { env, runDurableObjectAlarm } from "cloudflare:test";

        test("synthetic same-isolate stubs execute alarm and no-alarm branches", async () => {
          const namespace = env.COUNTER as {
            idFromName(name: string): unknown;
          };
          const id = namespace.idFromName("singleton");

          class WorkerRpc {
            id: unknown;
            constructor(stubId: unknown) {
              this.id = stubId;
            }
            async fetch() {
              return new Response("ok");
            }
            async alarm() {}
          }

          class WorkerRpcNoAlarm {
            id: unknown;
            constructor(stubId: unknown) {
              this.id = stubId;
            }
            async fetch() {
              return new Response("ok");
            }
          }

          await expect(runDurableObjectAlarm(new WorkerRpc(id) as any)).resolves.toBe(true);
          await expect(runDurableObjectAlarm(new WorkerRpcNoAlarm(id) as any)).resolves.toBe(false);
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("do-alarm-synthetic-stub.test.ts");
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

  test("surfaces defineWorkersConfig object export invalid top-level workers boolean options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          include: ["./object-invalid-top-level-workers-boolean.test.ts"],
          workers: false
        });
      `,
      "object-invalid-top-level-workers-boolean.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received boolean."
      );
    });
  });

  test("surfaces defineWorkersConfig object export invalid top-level workers array options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          include: ["./object-invalid-top-level-workers-array.test.ts"],
          workers: []
        });
      `,
      "object-invalid-top-level-workers-array.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersConfig object export invalid nested workers string options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./object-invalid-nested-workers-string.test.ts"],
            poolOptions: {
              workers: "invalid-workers-options"
            }
          }
        });
      `,
      "object-invalid-nested-workers-string.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersConfig object export invalid nested workers null options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          test: {
            include: ["./object-invalid-nested-workers-null.test.ts"],
            poolOptions: {
              workers: null
            }
          }
        });
      `,
      "object-invalid-nested-workers-null.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received null."
      );
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

  test("falls back to nested workers when defineWorkersConfig top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          include: ["./workers-undefined-fallback.test.ts"],
          workers: undefined,
          test: {
            poolOptions: {
              workers: {
                main: "./worker-nested.ts",
                miniflare: {
                  bindings: {
                    WORKERS_UNDEFINED_FALLBACK: "nested-fallback-selected"
                  }
                }
              }
            }
          }
        });
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.WORKERS_UNDEFINED_FALLBACK));
          }
        };
      `,
      "workers-undefined-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("nested workers value is selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("nested-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("workers-undefined-fallback.test.ts");
    });
  });

  test("falls back to nested workers function when defineWorkersConfig top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          include: ["./workers-function-undefined-fallback.test.ts"],
          workers: undefined,
          test: {
            poolOptions: {
              workers: () => ({
                main: "./worker-nested.ts",
                miniflare: {
                  bindings: {
                    WORKERS_FUNCTION_UNDEFINED_FALLBACK: "nested-function-fallback-selected"
                  }
                }
              })
            }
          }
        });
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.WORKERS_FUNCTION_UNDEFINED_FALLBACK));
          }
        };
      `,
      "workers-function-undefined-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("nested workers function value is selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("nested-function-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("workers-function-undefined-fallback.test.ts");
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

  test("surfaces sync config function export thrown errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => {
          throw new Error("sync config function throw e2e");
        });
      `,
      "sync-config-function-throw.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("sync config function throw e2e");
    });
  });

  test("surfaces sync config function export invalid top-level workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          include: ["./sync-config-function-invalid-top-level-workers.test.ts"],
          workers: "invalid-workers-options"
        }));
      `,
      "sync-config-function-invalid-top-level-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received string."
      );
    });
  });

  test("surfaces sync config function export invalid nested workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          test: {
            include: ["./sync-config-function-invalid-nested-workers-options.test.ts"],
            poolOptions: {
              workers: 123
            }
          }
        }));
      `,
      "sync-config-function-invalid-nested-workers-options.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received number."
      );
    });
  });

  test("surfaces sync config function export invalid top-level workers function return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          include: ["./sync-config-function-invalid-top-level-workers-return.test.ts"],
          workers: () => null
        }));
      `,
      "sync-config-function-invalid-top-level-workers-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces sync config function export invalid top-level workers null return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          include: ["./sync-config-function-invalid-top-level-workers-null-return.test.ts"],
          workers: () => null
        }));
      `,
      "sync-config-function-invalid-top-level-workers-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces sync config function export invalid top-level workers string return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          include: ["./sync-config-function-invalid-top-level-workers-string-return.test.ts"],
          workers: () => "invalid-workers-options"
        }));
      `,
      "sync-config-function-invalid-top-level-workers-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces sync config function export invalid top-level workers array return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          include: ["./sync-config-function-invalid-top-level-workers-array-return.test.ts"],
          workers: () => []
        }));
      `,
      "sync-config-function-invalid-top-level-workers-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces sync config function export invalid top-level workers undefined return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          include: ["./sync-config-function-invalid-top-level-workers-undefined-return.test.ts"],
          workers: () => undefined
        }));
      `,
      "sync-config-function-invalid-top-level-workers-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces sync config function export invalid top-level workers boolean return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          include: ["./sync-config-function-invalid-top-level-workers-boolean-return.test.ts"],
          workers: () => false
        }));
      `,
      "sync-config-function-invalid-top-level-workers-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces sync config function export invalid top-level workers number return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          include: ["./sync-config-function-invalid-top-level-workers-number-return.test.ts"],
          workers: () => 123
        }));
      `,
      "sync-config-function-invalid-top-level-workers-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces sync config function export invalid nested workers function return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          test: {
            include: ["./sync-config-function-invalid-nested-workers-return.test.ts"],
            poolOptions: {
              workers: () => []
            }
          }
        }));
      `,
      "sync-config-function-invalid-nested-workers-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces sync config function export invalid nested workers array return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          test: {
            include: ["./sync-config-function-invalid-nested-workers-array-return.test.ts"],
            poolOptions: {
              workers: () => []
            }
          }
        }));
      `,
      "sync-config-function-invalid-nested-workers-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces sync config function export invalid nested workers undefined return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          test: {
            include: ["./sync-config-function-invalid-nested-workers-undefined-return.test.ts"],
            poolOptions: {
              workers: () => undefined
            }
          }
        }));
      `,
      "sync-config-function-invalid-nested-workers-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces sync config function export invalid nested workers string return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          test: {
            include: ["./sync-config-function-invalid-nested-workers-string-return.test.ts"],
            poolOptions: {
              workers: () => "invalid-workers-options"
            }
          }
        }));
      `,
      "sync-config-function-invalid-nested-workers-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces sync config function export invalid nested workers null return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          test: {
            include: ["./sync-config-function-invalid-nested-workers-null-return.test.ts"],
            poolOptions: {
              workers: () => null
            }
          }
        }));
      `,
      "sync-config-function-invalid-nested-workers-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces sync config function export invalid nested workers boolean return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          test: {
            include: ["./sync-config-function-invalid-nested-workers-boolean-return.test.ts"],
            poolOptions: {
              workers: () => false
            }
          }
        }));
      `,
      "sync-config-function-invalid-nested-workers-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces sync config function export invalid nested workers number return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          test: {
            include: ["./sync-config-function-invalid-nested-workers-number-return.test.ts"],
            poolOptions: {
              workers: () => 123
            }
          }
        }));
      `,
      "sync-config-function-invalid-nested-workers-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces async config function export rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => {
          throw new Error("async config function rejection e2e");
        });
      `,
      "async-config-function-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("async config function rejection e2e");
    });
  });

  test("surfaces async config function export invalid nested workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          test: {
            include: ["./async-config-function-invalid-nested-workers.test.ts"],
            poolOptions: {
              workers: []
            }
          }
        }));
      `,
      "async-config-function-invalid-nested-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received array."
      );
    });
  });

  test("surfaces async config function export invalid top-level workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          include: ["./async-config-function-invalid-top-level-workers-options.test.ts"],
          workers: 123
        }));
      `,
      "async-config-function-invalid-top-level-workers-options.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received number."
      );
    });
  });

  test("falls back to nested workers for async config function exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          include: ["./async-config-function-undefined-fallback.test.ts"],
          workers: undefined,
          test: {
            poolOptions: {
              workers: {
                main: "./worker-nested.ts",
                miniflare: {
                  bindings: {
                    ASYNC_CONFIG_UNDEFINED_FALLBACK: "async-config-nested-fallback-selected"
                  }
                }
              }
            }
          }
        }));
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.ASYNC_CONFIG_UNDEFINED_FALLBACK));
          }
        };
      `,
      "async-config-function-undefined-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("async config nested workers selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("async-config-nested-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("async-config-function-undefined-fallback.test.ts");
    });
  });

  test("falls back to nested workers function for async config function exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          include: ["./async-config-function-undefined-function-fallback.test.ts"],
          workers: undefined,
          test: {
            poolOptions: {
              workers: () => ({
                main: "./worker-nested.ts",
                miniflare: {
                  bindings: {
                    ASYNC_CONFIG_UNDEFINED_FUNCTION_FALLBACK: "async-config-nested-function-fallback-selected"
                  }
                }
              })
            }
          }
        }));
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.ASYNC_CONFIG_UNDEFINED_FUNCTION_FALLBACK));
          }
        };
      `,
      "async-config-function-undefined-function-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("async config nested workers function selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("async-config-nested-function-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("async-config-function-undefined-function-fallback.test.ts");
    });
  });

  test("surfaces async config function export invalid nested workers function return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          test: {
            include: ["./async-config-function-invalid-nested-workers-return.test.ts"],
            poolOptions: {
              workers: () => []
            }
          }
        }));
      `,
      "async-config-function-invalid-nested-workers-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces async config function export invalid nested workers array return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          test: {
            include: ["./async-config-function-invalid-nested-workers-array-return.test.ts"],
            poolOptions: {
              workers: () => []
            }
          }
        }));
      `,
      "async-config-function-invalid-nested-workers-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces async config function export invalid nested workers undefined return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          test: {
            include: ["./async-config-function-invalid-nested-workers-undefined-return.test.ts"],
            poolOptions: {
              workers: () => undefined
            }
          }
        }));
      `,
      "async-config-function-invalid-nested-workers-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces async config function export invalid nested workers string return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          test: {
            include: ["./async-config-function-invalid-nested-workers-string-return.test.ts"],
            poolOptions: {
              workers: () => "invalid-workers-options"
            }
          }
        }));
      `,
      "async-config-function-invalid-nested-workers-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces async config function export invalid nested workers null return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          test: {
            include: ["./async-config-function-invalid-nested-workers-null-return.test.ts"],
            poolOptions: {
              workers: () => null
            }
          }
        }));
      `,
      "async-config-function-invalid-nested-workers-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces async config function export invalid nested workers boolean return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          test: {
            include: ["./async-config-function-invalid-nested-workers-boolean-return.test.ts"],
            poolOptions: {
              workers: () => false
            }
          }
        }));
      `,
      "async-config-function-invalid-nested-workers-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces async config function export invalid nested workers number return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          test: {
            include: ["./async-config-function-invalid-nested-workers-number-return.test.ts"],
            poolOptions: {
              workers: () => 123
            }
          }
        }));
      `,
      "async-config-function-invalid-nested-workers-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces async config function export invalid top-level workers function return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          include: ["./async-config-function-invalid-top-level-workers-return.test.ts"],
          workers: () => null
        }));
      `,
      "async-config-function-invalid-top-level-workers-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces async config function export invalid top-level workers null return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          include: ["./async-config-function-invalid-top-level-workers-null-return.test.ts"],
          workers: () => null
        }));
      `,
      "async-config-function-invalid-top-level-workers-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces async config function export invalid top-level workers string return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          include: ["./async-config-function-invalid-top-level-workers-string-return.test.ts"],
          workers: () => "invalid-workers-options"
        }));
      `,
      "async-config-function-invalid-top-level-workers-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces async config function export invalid top-level workers array return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          include: ["./async-config-function-invalid-top-level-workers-array-return.test.ts"],
          workers: () => []
        }));
      `,
      "async-config-function-invalid-top-level-workers-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces async config function export invalid top-level workers undefined return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          include: ["./async-config-function-invalid-top-level-workers-undefined-return.test.ts"],
          workers: () => undefined
        }));
      `,
      "async-config-function-invalid-top-level-workers-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces async config function export invalid top-level workers boolean return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          include: ["./async-config-function-invalid-top-level-workers-boolean-return.test.ts"],
          workers: () => false
        }));
      `,
      "async-config-function-invalid-top-level-workers-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces async config function export invalid top-level workers number return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(async () => ({
          include: ["./async-config-function-invalid-top-level-workers-number-return.test.ts"],
          workers: () => 123
        }));
      `,
      "async-config-function-invalid-top-level-workers-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces promise-returning config function export rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.reject(new Error("promise config function rejection e2e"))
        );
      `,
      "promise-config-function-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise config function rejection e2e");
    });
  });

  test("surfaces promise-returning config function export invalid top-level workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            include: ["./promise-config-function-invalid-top-level-workers.test.ts"],
            workers: null
          })
        );
      `,
      "promise-config-function-invalid-top-level-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received null."
      );
    });
  });

  test("falls back to nested workers for promise-returning config function exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            include: ["./promise-config-function-undefined-fallback.test.ts"],
            workers: undefined,
            test: {
              poolOptions: {
                workers: {
                  main: "./worker-nested.ts",
                  miniflare: {
                    bindings: {
                      PROMISE_CONFIG_UNDEFINED_FALLBACK: "promise-config-nested-fallback-selected"
                    }
                  }
                }
              }
            }
          })
        );
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_CONFIG_UNDEFINED_FALLBACK));
          }
        };
      `,
      "promise-config-function-undefined-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise config-function nested workers selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-config-nested-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-config-function-undefined-fallback.test.ts");
    });
  });

  test("falls back to nested workers function for promise-returning config function exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            include: ["./promise-config-function-undefined-function-fallback.test.ts"],
            workers: undefined,
            test: {
              poolOptions: {
                workers: () => ({
                  main: "./worker-nested.ts",
                  miniflare: {
                    bindings: {
                      PROMISE_CONFIG_UNDEFINED_FUNCTION_FALLBACK: "promise-config-nested-function-fallback-selected"
                    }
                  }
                })
              }
            }
          })
        );
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_CONFIG_UNDEFINED_FUNCTION_FALLBACK));
          }
        };
      `,
      "promise-config-function-undefined-function-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise config-function nested workers function selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-config-nested-function-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-config-function-undefined-function-fallback.test.ts");
    });
  });

  test("surfaces promise-returning config function export invalid nested workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            test: {
              include: ["./promise-config-function-invalid-nested-workers-options.test.ts"],
              poolOptions: {
                workers: 123
              }
            }
          })
        );
      `,
      "promise-config-function-invalid-nested-workers-options.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received number."
      );
    });
  });

  test("surfaces promise-returning config function export invalid top-level workers function return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            include: ["./promise-config-function-invalid-top-level-workers-return.test.ts"],
            workers: () => null
          })
        );
      `,
      "promise-config-function-invalid-top-level-workers-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces promise-returning config function export invalid top-level workers null return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            include: ["./promise-config-function-invalid-top-level-workers-null-return.test.ts"],
            workers: () => null
          })
        );
      `,
      "promise-config-function-invalid-top-level-workers-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces promise-returning config function export invalid top-level workers string return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            include: ["./promise-config-function-invalid-top-level-workers-string-return.test.ts"],
            workers: () => "invalid-workers-options"
          })
        );
      `,
      "promise-config-function-invalid-top-level-workers-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces promise-returning config function export invalid top-level workers array return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            include: ["./promise-config-function-invalid-top-level-workers-array-return.test.ts"],
            workers: () => []
          })
        );
      `,
      "promise-config-function-invalid-top-level-workers-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces promise-returning config function export invalid top-level workers undefined return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            include: ["./promise-config-function-invalid-top-level-workers-undefined-return.test.ts"],
            workers: () => undefined
          })
        );
      `,
      "promise-config-function-invalid-top-level-workers-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces promise-returning config function export invalid top-level workers boolean return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            include: ["./promise-config-function-invalid-top-level-workers-boolean-return.test.ts"],
            workers: () => false
          })
        );
      `,
      "promise-config-function-invalid-top-level-workers-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces promise-returning config function export invalid top-level workers number return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            include: ["./promise-config-function-invalid-top-level-workers-number-return.test.ts"],
            workers: () => 123
          })
        );
      `,
      "promise-config-function-invalid-top-level-workers-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces promise-returning config function export invalid nested workers function return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            test: {
              include: ["./promise-config-function-invalid-nested-workers-return.test.ts"],
              poolOptions: {
                workers: () => []
              }
            }
          })
        );
      `,
      "promise-config-function-invalid-nested-workers-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces promise-returning config function export invalid nested workers array return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            test: {
              include: ["./promise-config-function-invalid-nested-workers-array-return.test.ts"],
              poolOptions: {
                workers: () => []
              }
            }
          })
        );
      `,
      "promise-config-function-invalid-nested-workers-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces promise-returning config function export invalid nested workers undefined return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            test: {
              include: ["./promise-config-function-invalid-nested-workers-undefined-return.test.ts"],
              poolOptions: {
                workers: () => undefined
              }
            }
          })
        );
      `,
      "promise-config-function-invalid-nested-workers-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces promise-returning config function export invalid nested workers string return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            test: {
              include: ["./promise-config-function-invalid-nested-workers-string-return.test.ts"],
              poolOptions: {
                workers: () => "invalid-workers-options"
              }
            }
          })
        );
      `,
      "promise-config-function-invalid-nested-workers-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces promise-returning config function export invalid nested workers null return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            test: {
              include: ["./promise-config-function-invalid-nested-workers-null-return.test.ts"],
              poolOptions: {
                workers: () => null
              }
            }
          })
        );
      `,
      "promise-config-function-invalid-nested-workers-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces promise-returning config function export invalid nested workers boolean return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            test: {
              include: ["./promise-config-function-invalid-nested-workers-boolean-return.test.ts"],
              poolOptions: {
                workers: () => false
              }
            }
          })
        );
      `,
      "promise-config-function-invalid-nested-workers-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces promise-returning config function export invalid nested workers number return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() =>
          Promise.resolve({
            test: {
              include: ["./promise-config-function-invalid-nested-workers-number-return.test.ts"],
              poolOptions: {
                workers: () => 123
              }
            }
          })
        );
      `,
      "promise-config-function-invalid-nested-workers-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces thenable config function export rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(_resolve, reject) {
            const error = new Error("thenable config function rejection e2e");
            if (typeof reject === "function") {
              reject(error);
            }
            return Promise.reject(error);
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("thenable config function rejection e2e");
    });
  });

  test("surfaces thenable config function export invalid nested workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              test: {
                include: ["./thenable-config-function-invalid-nested-workers.test.ts"],
                poolOptions: {
                  workers: []
                }
              }
            });
            return Promise.resolve({
              test: {
                include: ["./thenable-config-function-invalid-nested-workers.test.ts"],
                poolOptions: {
                  workers: []
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-function-invalid-nested-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received array."
      );
    });
  });

  test("surfaces thenable config function export invalid top-level workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              include: ["./thenable-config-function-invalid-top-level-workers-options.test.ts"],
              workers: 123
            });
            return Promise.resolve({
              include: ["./thenable-config-function-invalid-top-level-workers-options.test.ts"],
              workers: 123
            });
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-function-invalid-top-level-workers-options.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received number."
      );
    });
  });

  test("falls back to nested workers for thenable config function exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              include: ["./thenable-config-function-undefined-fallback.test.ts"],
              workers: undefined,
              test: {
                poolOptions: {
                  workers: {
                    main: "./worker-nested.ts",
                    miniflare: {
                      bindings: {
                        THENABLE_CONFIG_UNDEFINED_FALLBACK: "thenable-config-nested-fallback-selected"
                      }
                    }
                  }
                }
              }
            });
            return Promise.resolve({
              include: ["./thenable-config-function-undefined-fallback.test.ts"],
              workers: undefined,
              test: {
                poolOptions: {
                  workers: {
                    main: "./worker-nested.ts",
                    miniflare: {
                      bindings: {
                        THENABLE_CONFIG_UNDEFINED_FALLBACK: "thenable-config-nested-fallback-selected"
                      }
                    }
                  }
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.THENABLE_CONFIG_UNDEFINED_FALLBACK));
          }
        };
      `,
      "thenable-config-function-undefined-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("thenable config-function nested workers selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("thenable-config-nested-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("thenable-config-function-undefined-fallback.test.ts");
    });
  });

  test("falls back to nested workers function for thenable config function exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              include: ["./thenable-config-function-undefined-function-fallback.test.ts"],
              workers: undefined,
              test: {
                poolOptions: {
                  workers: () => ({
                    main: "./worker-nested.ts",
                    miniflare: {
                      bindings: {
                        THENABLE_CONFIG_UNDEFINED_FUNCTION_FALLBACK: "thenable-config-nested-function-fallback-selected"
                      }
                    }
                  })
                }
              }
            });
            return Promise.resolve({
              include: ["./thenable-config-function-undefined-function-fallback.test.ts"],
              workers: undefined,
              test: {
                poolOptions: {
                  workers: () => ({
                    main: "./worker-nested.ts",
                    miniflare: {
                      bindings: {
                        THENABLE_CONFIG_UNDEFINED_FUNCTION_FALLBACK: "thenable-config-nested-function-fallback-selected"
                      }
                    }
                  })
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.THENABLE_CONFIG_UNDEFINED_FUNCTION_FALLBACK));
          }
        };
      `,
      "thenable-config-function-undefined-function-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("thenable config-function nested workers function selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("thenable-config-nested-function-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("thenable-config-function-undefined-function-fallback.test.ts");
    });
  });

  test("surfaces thenable config function export invalid nested workers function return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              test: {
                include: ["./thenable-config-function-invalid-nested-workers-return.test.ts"],
                poolOptions: {
                  workers: () => []
                }
              }
            });
            return Promise.resolve({
              test: {
                include: ["./thenable-config-function-invalid-nested-workers-return.test.ts"],
                poolOptions: {
                  workers: () => []
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-function-invalid-nested-workers-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces thenable config function export invalid nested workers array return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              test: {
                include: ["./thenable-config-function-invalid-nested-workers-array-return.test.ts"],
                poolOptions: {
                  workers: () => []
                }
              }
            });
            return Promise.resolve({
              test: {
                include: ["./thenable-config-function-invalid-nested-workers-array-return.test.ts"],
                poolOptions: {
                  workers: () => []
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-function-invalid-nested-workers-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces thenable config function export invalid nested workers undefined return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              test: {
                include: ["./thenable-config-function-invalid-nested-workers-undefined-return.test.ts"],
                poolOptions: {
                  workers: () => undefined
                }
              }
            });
            return Promise.resolve({
              test: {
                include: ["./thenable-config-function-invalid-nested-workers-undefined-return.test.ts"],
                poolOptions: {
                  workers: () => undefined
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-function-invalid-nested-workers-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces thenable config function export invalid nested workers string return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              test: {
                include: ["./thenable-config-function-invalid-nested-workers-string-return.test.ts"],
                poolOptions: {
                  workers: () => "invalid-workers-options"
                }
              }
            });
            return Promise.resolve({
              test: {
                include: ["./thenable-config-function-invalid-nested-workers-string-return.test.ts"],
                poolOptions: {
                  workers: () => "invalid-workers-options"
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-function-invalid-nested-workers-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces thenable config function export invalid nested workers null return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              test: {
                include: ["./thenable-config-function-invalid-nested-workers-null-return.test.ts"],
                poolOptions: {
                  workers: () => null
                }
              }
            });
            return Promise.resolve({
              test: {
                include: ["./thenable-config-function-invalid-nested-workers-null-return.test.ts"],
                poolOptions: {
                  workers: () => null
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-function-invalid-nested-workers-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces thenable config function export invalid nested workers boolean return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              test: {
                include: ["./thenable-config-function-invalid-nested-workers-boolean-return.test.ts"],
                poolOptions: {
                  workers: () => false
                }
              }
            });
            return Promise.resolve({
              test: {
                include: ["./thenable-config-function-invalid-nested-workers-boolean-return.test.ts"],
                poolOptions: {
                  workers: () => false
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-function-invalid-nested-workers-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces thenable config function export invalid nested workers number return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              test: {
                include: ["./thenable-config-function-invalid-nested-workers-number-return.test.ts"],
                poolOptions: {
                  workers: () => 123
                }
              }
            });
            return Promise.resolve({
              test: {
                include: ["./thenable-config-function-invalid-nested-workers-number-return.test.ts"],
                poolOptions: {
                  workers: () => 123
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-function-invalid-nested-workers-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces thenable config function export invalid top-level workers function return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              include: ["./thenable-config-function-invalid-top-level-workers-return.test.ts"],
              workers: () => null
            });
            return Promise.resolve({
              include: ["./thenable-config-function-invalid-top-level-workers-return.test.ts"],
              workers: () => null
            });
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-function-invalid-top-level-workers-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces thenable config function export invalid top-level workers null return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              include: ["./thenable-config-function-invalid-top-level-workers-null-return.test.ts"],
              workers: () => null
            });
            return Promise.resolve({
              include: ["./thenable-config-function-invalid-top-level-workers-null-return.test.ts"],
              workers: () => null
            });
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-function-invalid-top-level-workers-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces thenable config function export invalid top-level workers string return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              include: ["./thenable-config-function-invalid-top-level-workers-string-return.test.ts"],
              workers: () => "invalid-workers-options"
            });
            return Promise.resolve({
              include: ["./thenable-config-function-invalid-top-level-workers-string-return.test.ts"],
              workers: () => "invalid-workers-options"
            });
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-function-invalid-top-level-workers-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces thenable config function export invalid top-level workers array return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              include: ["./thenable-config-function-invalid-top-level-workers-array-return.test.ts"],
              workers: () => []
            });
            return Promise.resolve({
              include: ["./thenable-config-function-invalid-top-level-workers-array-return.test.ts"],
              workers: () => []
            });
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-function-invalid-top-level-workers-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces thenable config function export invalid top-level workers undefined return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              include: ["./thenable-config-function-invalid-top-level-workers-undefined-return.test.ts"],
              workers: () => undefined
            });
            return Promise.resolve({
              include: ["./thenable-config-function-invalid-top-level-workers-undefined-return.test.ts"],
              workers: () => undefined
            });
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-function-invalid-top-level-workers-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces thenable config function export invalid top-level workers boolean return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              include: ["./thenable-config-function-invalid-top-level-workers-boolean-return.test.ts"],
              workers: () => false
            });
            return Promise.resolve({
              include: ["./thenable-config-function-invalid-top-level-workers-boolean-return.test.ts"],
              workers: () => false
            });
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-function-invalid-top-level-workers-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces thenable config function export invalid top-level workers number return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(() => ({
          then(resolve) {
            resolve({
              include: ["./thenable-config-function-invalid-top-level-workers-number-return.test.ts"],
              workers: () => 123
            });
            return Promise.resolve({
              include: ["./thenable-config-function-invalid-top-level-workers-number-return.test.ts"],
              workers: () => 123
            });
          }
        }) as PromiseLike<any>);
      `,
      "thenable-config-function-invalid-top-level-workers-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received number."
      );
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

  test("supports config function thenable exports with single preinstalled workers plugin value end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersConfig(() => {
          const value = {
            plugins: workersRsbuildPlugin(),
            include: ["./config-function-thenable-single-preinstalled.test.ts"],
            workers: {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  THENABLE_CONFIG_SINGLE_PREINSTALLED_VALUE: "thenable-config-single-preinstalled-ok"
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
            return new Response(String(env.THENABLE_CONFIG_SINGLE_PREINSTALLED_VALUE));
          }
        };
      `,
      "config-function-thenable-single-preinstalled.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("thenable config function export with single preinstalled plugin is resolved", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("thenable-config-single-preinstalled-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("config-function-thenable-single-preinstalled.test.ts");
    });
  });

  test("supports config function thenable exports with falsey plugin entries and preinstalled workers plugin end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersConfig(() => {
          const value = {
            plugins: [false as any, workersRsbuildPlugin()],
            include: ["./config-function-thenable-falsey-preinstalled.test.ts"],
            workers: {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  THENABLE_CONFIG_FALSEY_PREINSTALLED_VALUE: "thenable-config-falsey-preinstalled-ok"
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
            return new Response(String(env.THENABLE_CONFIG_FALSEY_PREINSTALLED_VALUE));
          }
        };
      `,
      "config-function-thenable-falsey-preinstalled.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("thenable config function export with falsey + preinstalled plugin is resolved", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("thenable-config-falsey-preinstalled-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("config-function-thenable-falsey-preinstalled.test.ts");
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

  test("surfaces promise export invalid top-level workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-invalid-top-level-workers.test.ts"],
            workers: "invalid-workers-options"
          })
        );
      `,
      "promise-invalid-top-level-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received string."
      );
    });
  });

  test("surfaces promise export invalid top-level number workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-invalid-top-level-number-workers.test.ts"],
            workers: 123
          })
        );
      `,
      "promise-invalid-top-level-number-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received number."
      );
    });
  });

  test("surfaces promise export invalid nested workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-invalid-nested-workers.test.ts"],
              poolOptions: {
                workers: 123
              }
            }
          })
        );
      `,
      "promise-invalid-nested-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received number."
      );
    });
  });

  test("surfaces promise export invalid top-level null workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-invalid-top-level-null-workers.test.ts"],
            workers: null
          })
        );
      `,
      "promise-invalid-top-level-null-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received null."
      );
    });
  });

  test("surfaces promise export invalid nested array workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-invalid-nested-array-workers.test.ts"],
              poolOptions: {
                workers: []
              }
            }
          })
        );
      `,
      "promise-invalid-nested-array-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received array."
      );
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

  test("surfaces promise-like export invalid top-level workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-invalid-top-level-workers.test.ts"],
              workers: "invalid-workers-options"
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-invalid-top-level-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received string."
      );
    });
  });

  test("surfaces promise-like export invalid top-level number workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-invalid-top-level-number-workers.test.ts"],
              workers: 123
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-invalid-top-level-number-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received number."
      );
    });
  });

  test("surfaces promise-like export invalid nested workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-invalid-nested-workers.test.ts"],
                poolOptions: {
                  workers: false
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-invalid-nested-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received boolean."
      );
    });
  });

  test("surfaces promise-like export invalid top-level null workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-invalid-top-level-null-workers.test.ts"],
              workers: null
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-invalid-top-level-null-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received null."
      );
    });
  });

  test("surfaces promise-like export invalid nested array workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-invalid-nested-array-workers.test.ts"],
                poolOptions: {
                  workers: []
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-invalid-nested-array-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received array."
      );
    });
  });

  test("surfaces promise-like config export rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(_onfulfilled, onrejected) {
            const error = new Error("promise-like config export rejection e2e");
            if (typeof onrejected === "function") {
              onrejected(error);
            }
            return Promise.reject(error);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-config-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise-like config export rejection e2e");
    });
  });

  test("surfaces promise-like config export thrown errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then() {
            throw new Error("promise-like config export throw e2e");
          }
        } as PromiseLike<any>);
      `,
      "promise-like-config-throw.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise-like config export throw e2e");
    });
  });

  test("surfaces promise-like nested workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-rejection.test.ts"],
                poolOptions: {
                  workers: () => Promise.reject(new Error("promise-like nested workers rejection e2e"))
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise-like nested workers rejection e2e");
    });
  });

  test("surfaces promise-like nested workers thrown errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-throw.test.ts"],
                poolOptions: {
                  workers: () => {
                    throw new Error("promise-like nested workers throw e2e");
                  }
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-nested-throw.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise-like nested workers throw e2e");
    });
  });

  test("surfaces promise-like nested workers invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-invalid-options.test.ts"],
                poolOptions: {
                  workers: () => undefined
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-nested-invalid-options.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces promise-like nested workers array return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-invalid-options-array-return.test.ts"],
                poolOptions: {
                  workers: () => []
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-nested-invalid-options-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces promise-like nested workers boolean return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-invalid-options-boolean-return.test.ts"],
                poolOptions: {
                  workers: () => false
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-nested-invalid-options-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces promise-like nested workers string return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-invalid-options-string-return.test.ts"],
                poolOptions: {
                  workers: () => "invalid-workers-options"
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-nested-invalid-options-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces promise-like nested workers null return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-invalid-options-null-return.test.ts"],
                poolOptions: {
                  workers: () => null
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-nested-invalid-options-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces promise-like nested workers number return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-invalid-options-number-return.test.ts"],
                poolOptions: {
                  workers: () => 123
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-nested-invalid-options-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces promise-like nested thenable workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-thenable-rejection.test.ts"],
                poolOptions: {
                  workers: () => ({
                    then(_onfulfilled, onrejected) {
                      const error = new Error("promise-like nested thenable workers rejection e2e");
                      if (typeof onrejected === "function") {
                        onrejected(error);
                      }
                      return Promise.reject(error);
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
      "promise-like-nested-thenable-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise-like nested thenable workers rejection e2e");
    });
  });

  test("surfaces promise-like top-level workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-rejection.test.ts"],
              workers: () => Promise.reject(new Error("promise-like top-level workers rejection e2e"))
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-top-level-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise-like top-level workers rejection e2e");
    });
  });

  test("surfaces promise-like top-level workers invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-invalid-options.test.ts"],
              workers: () => "invalid-workers-options"
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-top-level-invalid-options.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces promise-like top-level workers null return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-invalid-options-null-return.test.ts"],
              workers: () => null
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-top-level-invalid-options-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces promise-like top-level workers boolean return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-invalid-options-boolean-return.test.ts"],
              workers: () => false
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-top-level-invalid-options-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces promise-like top-level workers undefined return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-invalid-options-undefined-return.test.ts"],
              workers: () => undefined
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-top-level-invalid-options-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces promise-like top-level workers array return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-invalid-options-array-return.test.ts"],
              workers: () => []
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-top-level-invalid-options-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces promise-like top-level workers number return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-invalid-options-number-return.test.ts"],
              workers: () => 123
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-top-level-invalid-options-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces promise-like top-level workers thrown errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-throw.test.ts"],
              workers: () => {
                throw new Error("promise-like top-level workers throw e2e");
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-top-level-throw.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise-like top-level workers throw e2e");
    });
  });

  test("surfaces promise-like top-level thenable workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-thenable-rejection.test.ts"],
              workers: () => ({
                then(_onfulfilled, onrejected) {
                  const error = new Error("promise-like top-level thenable workers rejection e2e");
                  if (typeof onrejected === "function") {
                    onrejected(error);
                  }
                  return Promise.reject(error);
                }
              })
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "promise-like-top-level-thenable-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "promise-like top-level thenable workers rejection e2e"
      );
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

  test("supports promise-like config exports nested workers function direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-workers-direct-env.test.ts"],
                poolOptions: {
                  workers: ({ inject }) => ({
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROMISE_LIKE_NESTED_WORKERS_DIRECT_ENV: inject("PROMISE_LIKE_NESTED_WORKERS_DIRECT_ENV")
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
            return new Response(String(env.PROMISE_LIKE_NESTED_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "promise-like-nested-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like nested workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-nested-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-nested-workers-direct-env.test.ts");
      },
      {
        env: {
          PROMISE_LIKE_NESTED_WORKERS_DIRECT_ENV:
            "\"promise-like-nested-workers-direct-env-ok\""
        }
      }
    );
  });

  test("supports promise-like config exports nested workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-workers-scoped-precedence.test.ts"],
                poolOptions: {
                  workers: ({ inject }) => ({
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROMISE_LIKE_NESTED_WORKERS_SCOPED_PRECEDENCE: inject("PROMISE_LIKE_NESTED_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROMISE_LIKE_NESTED_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "promise-like-nested-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like nested workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-nested-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-nested-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_LIKE_NESTED_WORKERS_SCOPED_PRECEDENCE:
            "\"promise-like-nested-workers-scoped-precedence-ok\"",
          PROMISE_LIKE_NESTED_WORKERS_SCOPED_PRECEDENCE:
            "\"promise-like-nested-workers-direct-should-not-win\""
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

  test("supports promise-like config exports nested async workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-async-workers-direct-env.test.ts"],
                poolOptions: {
                  workers: async ({ inject }) => ({
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROMISE_LIKE_NESTED_ASYNC_WORKERS_DIRECT_ENV: inject("PROMISE_LIKE_NESTED_ASYNC_WORKERS_DIRECT_ENV")
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
            return new Response(String(env.PROMISE_LIKE_NESTED_ASYNC_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "promise-like-nested-async-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like nested async workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-nested-async-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-nested-async-workers-direct-env.test.ts");
      },
      {
        env: {
          PROMISE_LIKE_NESTED_ASYNC_WORKERS_DIRECT_ENV:
            "\"promise-like-nested-async-workers-direct-env-ok\""
        }
      }
    );
  });

  test("supports promise-like config exports nested async workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-async-workers-scoped-precedence.test.ts"],
                poolOptions: {
                  workers: async ({ inject }) => ({
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROMISE_LIKE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE: inject("PROMISE_LIKE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROMISE_LIKE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "promise-like-nested-async-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like nested async workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-nested-async-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-nested-async-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_LIKE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE:
            "\"promise-like-nested-async-workers-scoped-precedence-ok\"",
          PROMISE_LIKE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE:
            "\"promise-like-nested-async-workers-direct-should-not-win\""
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

  test("supports promise-like config exports nested thenable workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-thenable-workers-direct-env.test.ts"],
                poolOptions: {
                  workers: ({ inject }) => {
                    const workersValue = {
                      main: "./worker.ts",
                      miniflare: {
                        bindings: {
                          PROMISE_LIKE_NESTED_THENABLE_WORKERS_DIRECT_ENV: inject("PROMISE_LIKE_NESTED_THENABLE_WORKERS_DIRECT_ENV")
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
            return new Response(String(env.PROMISE_LIKE_NESTED_THENABLE_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "promise-like-nested-thenable-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like nested thenable workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-nested-thenable-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-nested-thenable-workers-direct-env.test.ts");
      },
      {
        env: {
          PROMISE_LIKE_NESTED_THENABLE_WORKERS_DIRECT_ENV:
            "\"promise-like-nested-thenable-workers-direct-env-ok\""
        }
      }
    );
  });

  test("supports promise-like config exports nested thenable workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              test: {
                include: ["./promise-like-nested-thenable-workers-scoped-precedence.test.ts"],
                poolOptions: {
                  workers: ({ inject }) => {
                    const workersValue = {
                      main: "./worker.ts",
                      miniflare: {
                        bindings: {
                          PROMISE_LIKE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE: inject("PROMISE_LIKE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROMISE_LIKE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "promise-like-nested-thenable-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like nested thenable workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-nested-thenable-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-nested-thenable-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_LIKE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE:
            "\"promise-like-nested-thenable-workers-scoped-precedence-ok\"",
          PROMISE_LIKE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE:
            "\"promise-like-nested-thenable-workers-direct-should-not-win\""
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

  test("supports promise-like config exports top-level workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-workers-direct-env.test.ts"],
              workers: ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROMISE_LIKE_TOP_LEVEL_WORKERS_DIRECT_ENV: inject("PROMISE_LIKE_TOP_LEVEL_WORKERS_DIRECT_ENV")
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
            return new Response(String(env.PROMISE_LIKE_TOP_LEVEL_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "promise-like-top-level-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like top-level workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-top-level-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-top-level-workers-direct-env.test.ts");
      },
      {
        env: {
          PROMISE_LIKE_TOP_LEVEL_WORKERS_DIRECT_ENV:
            "\"promise-like-top-level-workers-direct-env-ok\""
        }
      }
    );
  });

  test("supports promise-like config exports top-level workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-workers-scoped-precedence.test.ts"],
              workers: ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROMISE_LIKE_TOP_LEVEL_WORKERS_SCOPED_PRECEDENCE: inject("PROMISE_LIKE_TOP_LEVEL_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROMISE_LIKE_TOP_LEVEL_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "promise-like-top-level-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like top-level workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-top-level-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-top-level-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_LIKE_TOP_LEVEL_WORKERS_SCOPED_PRECEDENCE:
            "\"promise-like-top-level-workers-scoped-precedence-ok\"",
          PROMISE_LIKE_TOP_LEVEL_WORKERS_SCOPED_PRECEDENCE:
            "\"promise-like-top-level-workers-direct-should-not-win\""
        }
      }
    );
  });

  test("supports promise-like config exports async top-level workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-async-workers-direct-env.test.ts"],
              workers: async ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_DIRECT_ENV: inject("PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_DIRECT_ENV")
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
            return new Response(String(env.PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "promise-like-top-level-async-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like top-level async workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-top-level-async-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-top-level-async-workers-direct-env.test.ts");
      },
      {
        env: {
          PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_DIRECT_ENV:
            "\"promise-like-top-level-async-workers-direct-env-ok\""
        }
      }
    );
  });

  test("supports promise-like config exports async top-level workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-async-workers-scoped-precedence.test.ts"],
              workers: async ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_SCOPED_PRECEDENCE: inject("PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "promise-like-top-level-async-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like top-level async workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-top-level-async-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-top-level-async-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_SCOPED_PRECEDENCE:
            "\"promise-like-top-level-async-workers-scoped-precedence-ok\"",
          PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_SCOPED_PRECEDENCE:
            "\"promise-like-top-level-async-workers-direct-should-not-win\""
        }
      }
    );
  });

  test("supports promise-like config exports top-level thenable workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-thenable-workers-direct-env.test.ts"],
              workers: ({ inject }) => {
                const workersValue = {
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_DIRECT_ENV: inject("PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_DIRECT_ENV")
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
            return new Response(String(env.PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "promise-like-top-level-thenable-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like top-level thenable workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-top-level-thenable-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-top-level-thenable-workers-direct-env.test.ts");
      },
      {
        env: {
          PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_DIRECT_ENV:
            "\"promise-like-top-level-thenable-workers-direct-env-ok\""
        }
      }
    );
  });

  test("supports promise-like config exports top-level thenable workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-top-level-thenable-workers-scoped-precedence.test.ts"],
              workers: ({ inject }) => {
                const workersValue = {
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_SCOPED_PRECEDENCE: inject("PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "promise-like-top-level-thenable-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like top-level thenable workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-top-level-thenable-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-like-top-level-thenable-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_SCOPED_PRECEDENCE:
            "\"promise-like-top-level-thenable-workers-scoped-precedence-ok\"",
          PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_SCOPED_PRECEDENCE:
            "\"promise-like-top-level-thenable-workers-direct-should-not-win\""
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

  test("falls back to nested workers in promise-like config exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-undefined-fallback.test.ts"],
              workers: undefined,
              test: {
                poolOptions: {
                  workers: {
                    main: "./worker-nested.ts",
                    miniflare: {
                      bindings: {
                        PROMISE_LIKE_UNDEFINED_FALLBACK_VALUE: "promise-like-nested-fallback-selected"
                      }
                    }
                  }
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_LIKE_UNDEFINED_FALLBACK_VALUE));
          }
        };
      `,
      "promise-like-undefined-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like nested workers selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-nested-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-like-undefined-fallback.test.ts");
    });
  });

  test("falls back to nested workers function in promise-like config exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-undefined-function-fallback.test.ts"],
              workers: undefined,
              test: {
                poolOptions: {
                  workers: () => ({
                    main: "./worker-nested.ts",
                    miniflare: {
                      bindings: {
                        PROMISE_LIKE_UNDEFINED_FUNCTION_FALLBACK_VALUE: "promise-like-nested-function-fallback-selected"
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
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_LIKE_UNDEFINED_FUNCTION_FALLBACK_VALUE));
          }
        };
      `,
      "promise-like-undefined-function-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like nested workers function selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-nested-function-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-like-undefined-function-fallback.test.ts");
    });
  });

  test("does not evaluate nested workers function when promise-like top-level async workers function is set end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-async-function-precedence.test.ts"],
              workers: async () => ({
                main: "./worker-top-level.ts",
                miniflare: {
                  bindings: {
                    PROMISE_LIKE_ASYNC_FUNCTION_PRECEDENCE_VALUE: "promise-like-top-level-async-function-selected"
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
            return new Response(String(env.PROMISE_LIKE_ASYNC_FUNCTION_PRECEDENCE_VALUE));
          }
        };
      `,
      "promise-like-async-function-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like top-level async workers function value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-top-level-async-function-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-like-async-function-precedence.test.ts");
    });
  });

  test("does not evaluate nested workers function when promise-like top-level thenable workers function is set end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig({
          then(resolve) {
            const value = {
              include: ["./promise-like-thenable-function-precedence.test.ts"],
              workers: () => {
                const workersValue = {
                  main: "./worker-top-level.ts",
                  miniflare: {
                    bindings: {
                      PROMISE_LIKE_THENABLE_FUNCTION_PRECEDENCE_VALUE: "promise-like-top-level-thenable-function-selected"
                    }
                  }
                };
                return {
                  then(nextResolve) {
                    nextResolve(workersValue);
                    return Promise.resolve(workersValue);
                  }
                };
              },
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
            return new Response(String(env.PROMISE_LIKE_THENABLE_FUNCTION_PRECEDENCE_VALUE));
          }
        };
      `,
      "promise-like-thenable-function-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise-like top-level thenable workers function value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-like-top-level-thenable-function-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-like-thenable-function-precedence.test.ts");
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

  test("falls back to nested workers in promise config exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-undefined-fallback.test.ts"],
            workers: undefined,
            test: {
              poolOptions: {
                workers: {
                  main: "./worker-nested.ts",
                  miniflare: {
                    bindings: {
                      PROMISE_UNDEFINED_FALLBACK_VALUE: "promise-nested-fallback-selected"
                    }
                  }
                }
              }
            }
          })
        );
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_UNDEFINED_FALLBACK_VALUE));
          }
        };
      `,
      "promise-undefined-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise nested workers selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-nested-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-undefined-fallback.test.ts");
    });
  });

  test("falls back to nested workers function in promise config exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-undefined-function-fallback.test.ts"],
            workers: undefined,
            test: {
              poolOptions: {
                workers: () => ({
                  main: "./worker-nested.ts",
                  miniflare: {
                    bindings: {
                      PROMISE_UNDEFINED_FUNCTION_FALLBACK_VALUE: "promise-nested-function-fallback-selected"
                    }
                  }
                })
              }
            }
          })
        );
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_UNDEFINED_FUNCTION_FALLBACK_VALUE));
          }
        };
      `,
      "promise-undefined-function-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise nested workers function selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-nested-function-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-undefined-function-fallback.test.ts");
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

  test("does not evaluate nested workers function in promise config export when top-level async function is set end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-async-function-precedence.test.ts"],
            workers: async () => ({
              main: "./worker-top-level.ts",
              miniflare: {
                bindings: {
                  PROMISE_ASYNC_FUNCTION_PRECEDENCE_VALUE: "promise-top-level-async-function-selected"
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
            return new Response(String(env.PROMISE_ASYNC_FUNCTION_PRECEDENCE_VALUE));
          }
        };
      `,
      "promise-async-function-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise top-level async workers function value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-top-level-async-function-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-async-function-precedence.test.ts");
    });
  });

  test("does not evaluate nested workers function in promise config export when top-level thenable function is set end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-thenable-function-precedence.test.ts"],
            workers: () => {
              const workersValue = {
                main: "./worker-top-level.ts",
                miniflare: {
                  bindings: {
                    PROMISE_THENABLE_FUNCTION_PRECEDENCE_VALUE: "promise-top-level-thenable-function-selected"
                  }
                }
              };
              return {
                then(resolve) {
                  resolve(workersValue);
                  return Promise.resolve(workersValue);
                }
              };
            },
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
            return new Response(String(env.PROMISE_THENABLE_FUNCTION_PRECEDENCE_VALUE));
          }
        };
      `,
      "promise-thenable-function-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise top-level thenable workers function value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-top-level-thenable-function-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("promise-thenable-function-precedence.test.ts");
    });
  });

  test("surfaces promise config export nested workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-rejection.test.ts"],
              poolOptions: {
                workers: () => Promise.reject(new Error("promise nested workers rejection e2e"))
              }
            }
          })
        );
      `,
      "promise-nested-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise nested workers rejection e2e");
    });
  });

  test("surfaces promise config export nested async workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-async-rejection.test.ts"],
              poolOptions: {
                workers: async () => {
                  throw new Error("promise nested async workers rejection e2e");
                }
              }
            }
          })
        );
      `,
      "promise-nested-async-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise nested async workers rejection e2e");
    });
  });

  test("surfaces promise config export nested workers thrown errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-throw.test.ts"],
              poolOptions: {
                workers: () => {
                  throw new Error("promise nested workers throw e2e");
                }
              }
            }
          })
        );
      `,
      "promise-nested-throw.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise nested workers throw e2e");
    });
  });

  test("surfaces promise config export nested workers invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-invalid-options.test.ts"],
              poolOptions: {
                workers: () => undefined
              }
            }
          })
        );
      `,
      "promise-nested-invalid-options.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces promise config export nested workers array return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-invalid-options-array-return.test.ts"],
              poolOptions: {
                workers: () => []
              }
            }
          })
        );
      `,
      "promise-nested-invalid-options-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces promise config export nested workers string return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-invalid-options-string-return.test.ts"],
              poolOptions: {
                workers: () => "invalid-promise-nested-options"
              }
            }
          })
        );
      `,
      "promise-nested-invalid-options-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces promise config export nested workers boolean return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-invalid-options-boolean-return.test.ts"],
              poolOptions: {
                workers: () => false
              }
            }
          })
        );
      `,
      "promise-nested-invalid-options-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces promise config export nested workers number return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-invalid-options-number-return.test.ts"],
              poolOptions: {
                workers: () => 123
              }
            }
          })
        );
      `,
      "promise-nested-invalid-options-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces promise config export nested workers null return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-invalid-options-null-return.test.ts"],
              poolOptions: {
                workers: () => null
              }
            }
          })
        );
      `,
      "promise-nested-invalid-options-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces promise config export nested thenable workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-thenable-rejection.test.ts"],
              poolOptions: {
                workers: () => ({
                  then(_onfulfilled, onrejected) {
                    const error = new Error("promise nested thenable workers rejection e2e");
                    if (typeof onrejected === "function") {
                      onrejected(error);
                    }
                    return Promise.reject(error);
                  }
                })
              }
            }
          })
        );
      `,
      "promise-nested-thenable-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise nested thenable workers rejection e2e");
    });
  });

  test("surfaces promise config export nested thenable workers thrown errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-thenable-throw.test.ts"],
              poolOptions: {
                workers: () => ({
                  then() {
                    throw new Error("promise nested thenable workers throw e2e");
                  }
                })
              }
            }
          })
        );
      `,
      "promise-nested-thenable-throw.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise nested thenable workers throw e2e");
    });
  });

  test("surfaces promise config export top-level workers thrown errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-throw.test.ts"],
            workers: () => {
              throw new Error("promise top-level workers throw e2e");
            }
          })
        );
      `,
      "promise-top-level-throw.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise top-level workers throw e2e");
    });
  });

  test("surfaces promise config export top-level workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-rejection.test.ts"],
            workers: () => Promise.reject(new Error("promise top-level workers rejection e2e"))
          })
        );
      `,
      "promise-top-level-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise top-level workers rejection e2e");
    });
  });

  test("surfaces promise config export top-level workers invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-invalid-options.test.ts"],
            workers: () => "invalid-workers-options"
          })
        );
      `,
      "promise-top-level-invalid-options.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces promise config export top-level workers null return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-invalid-options-null-return.test.ts"],
            workers: () => null
          })
        );
      `,
      "promise-top-level-invalid-options-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces promise config export top-level workers undefined return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-invalid-options-undefined-return.test.ts"],
            workers: () => undefined
          })
        );
      `,
      "promise-top-level-invalid-options-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces promise config export top-level workers array return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-invalid-options-array-return.test.ts"],
            workers: () => []
          })
        );
      `,
      "promise-top-level-invalid-options-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces promise config export top-level workers boolean return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-invalid-options-boolean-return.test.ts"],
            workers: () => false
          })
        );
      `,
      "promise-top-level-invalid-options-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces promise config export top-level workers number return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-invalid-options-number-return.test.ts"],
            workers: () => 123
          })
        );
      `,
      "promise-top-level-invalid-options-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces promise config export top-level async workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-async-rejection.test.ts"],
            workers: async () => {
              throw new Error("promise top-level async workers rejection e2e");
            }
          })
        );
      `,
      "promise-top-level-async-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise top-level async workers rejection e2e");
    });
  });

  test("surfaces promise config export top-level thenable workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-thenable-rejection.test.ts"],
            workers: () => ({
              then(_onfulfilled, onrejected) {
                const error = new Error("promise top-level thenable workers rejection e2e");
                if (typeof onrejected === "function") {
                  onrejected(error);
                }
                return Promise.reject(error);
              }
            })
          })
        );
      `,
      "promise-top-level-thenable-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise top-level thenable workers rejection e2e");
    });
  });

  test("surfaces promise config export top-level thenable workers thrown errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-thenable-throw.test.ts"],
            workers: () => ({
              then() {
                throw new Error("promise top-level thenable workers throw e2e");
              }
            })
          })
        );
      `,
      "promise-top-level-thenable-throw.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("promise top-level thenable workers throw e2e");
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

  test("supports promise config export nested async workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-async-workers-scoped-precedence.test.ts"],
              poolOptions: {
                workers: async ({ inject }) => ({
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROMISE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE: inject("PROMISE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROMISE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "promise-nested-async-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise nested async workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-nested-async-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-nested-async-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE:
            "promise-nested-async-workers-scoped-precedence-ok",
          PROMISE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE:
            "promise-nested-async-workers-direct-should-not-win"
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

  test("supports promise config export nested thenable workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-thenable-workers-direct-env.test.ts"],
              poolOptions: {
                workers: ({ inject }) => {
                  const value = {
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROMISE_NESTED_THENABLE_WORKERS_DIRECT_ENV: inject("PROMISE_NESTED_THENABLE_WORKERS_DIRECT_ENV")
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
            return new Response(String(env.PROMISE_NESTED_THENABLE_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "promise-nested-thenable-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise nested thenable workers direct-env fallback wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-nested-thenable-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-nested-thenable-workers-direct-env.test.ts");
      },
      {
        env: {
          PROMISE_NESTED_THENABLE_WORKERS_DIRECT_ENV:
            "promise-nested-thenable-workers-direct-env-ok"
        }
      }
    );
  });

  test("supports promise config export nested workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-workers-fn-scoped-precedence.test.ts"],
              poolOptions: {
                workers: ({ inject }) => ({
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROMISE_NESTED_WORKERS_FN_SCOPED_PRECEDENCE: inject("PROMISE_NESTED_WORKERS_FN_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROMISE_NESTED_WORKERS_FN_SCOPED_PRECEDENCE));
          }
        };
      `,
      "promise-nested-workers-fn-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise nested workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-nested-workers-fn-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-nested-workers-fn-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_NESTED_WORKERS_FN_SCOPED_PRECEDENCE:
            "promise-nested-workers-fn-scoped-precedence-ok",
          PROMISE_NESTED_WORKERS_FN_SCOPED_PRECEDENCE:
            "promise-nested-workers-fn-direct-should-not-win"
        }
      }
    );
  });

  test("supports promise config export nested thenable workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            test: {
              include: ["./promise-nested-thenable-workers-scoped-precedence.test.ts"],
              poolOptions: {
                workers: ({ inject }) => {
                  const value = {
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROMISE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE: inject("PROMISE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROMISE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "promise-nested-thenable-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise nested thenable workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-nested-thenable-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-nested-thenable-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE:
            "promise-nested-thenable-workers-scoped-precedence-ok",
          PROMISE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE:
            "promise-nested-thenable-workers-direct-should-not-win"
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

  test("supports promise config export top-level thenable workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-workers-fn-thenable-direct-env.test.ts"],
            workers: ({ inject }) => {
              const value = {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_DIRECT_ENV: inject("PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_DIRECT_ENV")
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
            return new Response(String(env.PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_DIRECT_ENV));
          }
        };
      `,
      "promise-top-level-workers-fn-thenable-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise top-level thenable workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-top-level-workers-fn-thenable-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-top-level-workers-fn-thenable-direct-env.test.ts");
      },
      {
        env: {
          PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_DIRECT_ENV:
            "promise-top-level-workers-fn-thenable-direct-env-ok"
        }
      }
    );
  });

  test("supports promise config export top-level thenable workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-workers-fn-thenable-scoped-precedence.test.ts"],
            workers: ({ inject }) => {
              const value = {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_SCOPED_PRECEDENCE: inject("PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_SCOPED_PRECEDENCE));
          }
        };
      `,
      "promise-top-level-workers-fn-thenable-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise top-level thenable workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-top-level-workers-fn-thenable-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-top-level-workers-fn-thenable-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_SCOPED_PRECEDENCE:
            "promise-top-level-workers-fn-thenable-scoped-precedence-ok",
          PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_SCOPED_PRECEDENCE:
            "promise-top-level-workers-fn-thenable-direct-should-not-win"
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

  test("supports promise config export async top-level workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-workers-fn-async-scoped-precedence.test.ts"],
            workers: async ({ inject }) => ({
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_SCOPED_PRECEDENCE: inject("PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_SCOPED_PRECEDENCE")
                }
              }
            })
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_SCOPED_PRECEDENCE));
          }
        };
      `,
      "promise-top-level-workers-fn-async-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise async top-level workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-top-level-workers-fn-async-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-top-level-workers-fn-async-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_SCOPED_PRECEDENCE:
            "promise-top-level-workers-fn-async-scoped-precedence-ok",
          PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_SCOPED_PRECEDENCE:
            "promise-top-level-workers-fn-async-direct-should-not-win"
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

  test("supports promise config export top-level workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersConfig } from ${JSON.stringify(configPathImport)};
        export default defineWorkersConfig(
          Promise.resolve({
            include: ["./promise-top-level-workers-fn-scoped-precedence.test.ts"],
            workers: ({ inject }) => ({
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROMISE_TOP_LEVEL_WORKERS_FN_SCOPED_PRECEDENCE: inject("PROMISE_TOP_LEVEL_WORKERS_FN_SCOPED_PRECEDENCE")
                }
              }
            })
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROMISE_TOP_LEVEL_WORKERS_FN_SCOPED_PRECEDENCE));
          }
        };
      `,
      "promise-top-level-workers-fn-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("promise top-level workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("promise-top-level-workers-fn-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("promise-top-level-workers-fn-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROMISE_TOP_LEVEL_WORKERS_FN_SCOPED_PRECEDENCE:
            "promise-top-level-workers-fn-scoped-precedence-ok",
          PROMISE_TOP_LEVEL_WORKERS_FN_SCOPED_PRECEDENCE:
            "promise-top-level-workers-fn-direct-should-not-win"
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

  test("surfaces defineWorkersProject promise export invalid top-level workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-invalid-top-level-workers.test.ts"],
            workers: "invalid-workers-options"
          })
        );
      `,
      "project-promise-invalid-top-level-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersProject promise export invalid top-level number workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-invalid-top-level-number-workers.test.ts"],
            workers: 123
          })
        );
      `,
      "project-promise-invalid-top-level-number-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received number."
      );
    });
  });

  test("surfaces defineWorkersProject promise export invalid nested workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-invalid-nested-workers.test.ts"],
              poolOptions: {
                workers: 123
              }
            }
          })
        );
      `,
      "project-promise-invalid-nested-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received number."
      );
    });
  });

  test("surfaces defineWorkersProject promise export invalid top-level null workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-invalid-top-level-null-workers.test.ts"],
            workers: null
          })
        );
      `,
      "project-promise-invalid-top-level-null-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject promise export invalid nested array workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-invalid-nested-array-workers.test.ts"],
              poolOptions: {
                workers: []
              }
            }
          })
        );
      `,
      "project-promise-invalid-nested-array-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received array."
      );
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

  test("surfaces defineWorkersProject promise-like export invalid top-level workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-invalid-top-level-workers.test.ts"],
              workers: "invalid-workers-options"
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-invalid-top-level-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like export invalid top-level number workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-invalid-top-level-number-workers.test.ts"],
              workers: 123
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-invalid-top-level-number-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received number."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like export invalid nested workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-invalid-nested-workers.test.ts"],
                poolOptions: {
                  workers: false
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-invalid-nested-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received boolean."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like export invalid top-level null workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-invalid-top-level-null-workers.test.ts"],
              workers: null
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-invalid-top-level-null-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like export invalid nested array workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-invalid-nested-array-workers.test.ts"],
                poolOptions: {
                  workers: []
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-invalid-nested-array-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like config export rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(_onfulfilled, onrejected) {
            const error = new Error("project promise-like config export rejection e2e");
            if (typeof onrejected === "function") {
              onrejected(error);
            }
            return Promise.reject(error);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-config-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("project promise-like config export rejection e2e");
    });
  });

  test("surfaces defineWorkersProject promise-like config export thrown errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then() {
            throw new Error("project promise-like config export throw e2e");
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-config-throw.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("project promise-like config export throw e2e");
    });
  });

  test("surfaces defineWorkersProject promise-like nested workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-rejection.test.ts"],
                poolOptions: {
                  workers: () => Promise.reject(new Error("project promise-like nested workers rejection e2e"))
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("project promise-like nested workers rejection e2e");
    });
  });

  test("surfaces defineWorkersProject promise-like nested workers thrown errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-throw.test.ts"],
                poolOptions: {
                  workers: () => {
                    throw new Error("project promise-like nested workers throw e2e");
                  }
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-nested-throw.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("project promise-like nested workers throw e2e");
    });
  });

  test("surfaces defineWorkersProject promise-like nested workers invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-invalid-options.test.ts"],
                poolOptions: {
                  workers: () => undefined
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-nested-invalid-options.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like nested workers array return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-invalid-options-array-return.test.ts"],
                poolOptions: {
                  workers: () => []
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-nested-invalid-options-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like nested workers boolean return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-invalid-options-boolean-return.test.ts"],
                poolOptions: {
                  workers: () => false
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-nested-invalid-options-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like nested workers string return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-invalid-options-string-return.test.ts"],
                poolOptions: {
                  workers: () => "invalid-workers-options"
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-nested-invalid-options-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like nested workers null return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-invalid-options-null-return.test.ts"],
                poolOptions: {
                  workers: () => null
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-nested-invalid-options-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like nested workers number return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-invalid-options-number-return.test.ts"],
                poolOptions: {
                  workers: () => 123
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-nested-invalid-options-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like nested thenable workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-thenable-rejection.test.ts"],
                poolOptions: {
                  workers: () => ({
                    then(_onfulfilled, onrejected) {
                      const error = new Error("project promise-like nested thenable workers rejection e2e");
                      if (typeof onrejected === "function") {
                        onrejected(error);
                      }
                      return Promise.reject(error);
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
      "project-promise-like-nested-thenable-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "project promise-like nested thenable workers rejection e2e"
      );
    });
  });

  test("surfaces defineWorkersProject promise-like top-level workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-rejection.test.ts"],
              workers: () => Promise.reject(new Error("project promise-like top-level workers rejection e2e"))
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-top-level-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("project promise-like top-level workers rejection e2e");
    });
  });

  test("surfaces defineWorkersProject promise-like top-level workers invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-invalid-options.test.ts"],
              workers: () => "invalid-workers-options"
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-top-level-invalid-options.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like top-level workers null return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-invalid-options-null-return.test.ts"],
              workers: () => null
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-top-level-invalid-options-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like top-level workers boolean return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-invalid-options-boolean-return.test.ts"],
              workers: () => false
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-top-level-invalid-options-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like top-level workers undefined return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-invalid-options-undefined-return.test.ts"],
              workers: () => undefined
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-top-level-invalid-options-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like top-level workers array return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-invalid-options-array-return.test.ts"],
              workers: () => []
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-top-level-invalid-options-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like top-level workers number return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-invalid-options-number-return.test.ts"],
              workers: () => 123
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-top-level-invalid-options-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces defineWorkersProject promise-like top-level workers thrown errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-throw.test.ts"],
              workers: () => {
                throw new Error("project promise-like top-level workers throw e2e");
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-top-level-throw.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("project promise-like top-level workers throw e2e");
    });
  });

  test("surfaces defineWorkersProject promise-like top-level thenable workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-thenable-rejection.test.ts"],
              workers: () => ({
                then(_onfulfilled, onrejected) {
                  const error = new Error("project promise-like top-level thenable workers rejection e2e");
                  if (typeof onrejected === "function") {
                    onrejected(error);
                  }
                  return Promise.reject(error);
                }
              })
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "project-promise-like-top-level-thenable-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "project promise-like top-level thenable workers rejection e2e"
      );
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

  test("supports defineWorkersProject promise-like export nested workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-workers-direct-env.test.ts"],
                poolOptions: {
                  workers: ({ inject }) => ({
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROJECT_PROMISE_LIKE_NESTED_WORKERS_DIRECT_ENV: inject("PROJECT_PROMISE_LIKE_NESTED_WORKERS_DIRECT_ENV")
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
            return new Response(String(env.PROJECT_PROMISE_LIKE_NESTED_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "project-promise-like-nested-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like nested workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-nested-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-nested-workers-direct-env.test.ts");
      },
      {
        env: {
          PROJECT_PROMISE_LIKE_NESTED_WORKERS_DIRECT_ENV:
            "\"project-promise-like-nested-workers-direct-env-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise-like export nested workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-workers-scoped-precedence.test.ts"],
                poolOptions: {
                  workers: ({ inject }) => ({
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROJECT_PROMISE_LIKE_NESTED_WORKERS_SCOPED_PRECEDENCE: inject("PROJECT_PROMISE_LIKE_NESTED_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROJECT_PROMISE_LIKE_NESTED_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "project-promise-like-nested-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like nested workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-nested-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-nested-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED_WORKERS_SCOPED_PRECEDENCE:
            "\"project-promise-like-nested-workers-scoped-precedence-ok\"",
          PROJECT_PROMISE_LIKE_NESTED_WORKERS_SCOPED_PRECEDENCE:
            "\"project-promise-like-nested-workers-direct-should-not-win\""
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

  test("supports defineWorkersProject promise-like export nested async workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-async-workers-direct-env.test.ts"],
                poolOptions: {
                  workers: async ({ inject }) => ({
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROJECT_PROMISE_LIKE_NESTED_ASYNC_WORKERS_DIRECT_ENV: inject("PROJECT_PROMISE_LIKE_NESTED_ASYNC_WORKERS_DIRECT_ENV")
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
            return new Response(String(env.PROJECT_PROMISE_LIKE_NESTED_ASYNC_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "project-promise-like-nested-async-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like nested async workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-nested-async-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-nested-async-workers-direct-env.test.ts");
      },
      {
        env: {
          PROJECT_PROMISE_LIKE_NESTED_ASYNC_WORKERS_DIRECT_ENV:
            "\"project-promise-like-nested-async-workers-direct-env-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise-like export nested async workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-async-workers-scoped-precedence.test.ts"],
                poolOptions: {
                  workers: async ({ inject }) => ({
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROJECT_PROMISE_LIKE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE: inject("PROJECT_PROMISE_LIKE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROJECT_PROMISE_LIKE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "project-promise-like-nested-async-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like nested async workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-nested-async-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-nested-async-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE:
            "\"project-promise-like-nested-async-workers-scoped-precedence-ok\"",
          PROJECT_PROMISE_LIKE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE:
            "\"project-promise-like-nested-async-workers-direct-should-not-win\""
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

  test("supports defineWorkersProject promise-like export nested thenable workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-thenable-workers-direct-env.test.ts"],
                poolOptions: {
                  workers: ({ inject }) => {
                    const workersValue = {
                      main: "./worker.ts",
                      miniflare: {
                        bindings: {
                          PROJECT_PROMISE_LIKE_NESTED_THENABLE_WORKERS_DIRECT_ENV: inject("PROJECT_PROMISE_LIKE_NESTED_THENABLE_WORKERS_DIRECT_ENV")
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
            return new Response(String(env.PROJECT_PROMISE_LIKE_NESTED_THENABLE_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "project-promise-like-nested-thenable-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like nested thenable workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-nested-thenable-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-nested-thenable-workers-direct-env.test.ts");
      },
      {
        env: {
          PROJECT_PROMISE_LIKE_NESTED_THENABLE_WORKERS_DIRECT_ENV:
            "\"project-promise-like-nested-thenable-workers-direct-env-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise-like export nested thenable workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              test: {
                include: ["./project-promise-like-nested-thenable-workers-scoped-precedence.test.ts"],
                poolOptions: {
                  workers: ({ inject }) => {
                    const workersValue = {
                      main: "./worker.ts",
                      miniflare: {
                        bindings: {
                          PROJECT_PROMISE_LIKE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE: inject("PROJECT_PROMISE_LIKE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROJECT_PROMISE_LIKE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "project-promise-like-nested-thenable-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like nested thenable workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-nested-thenable-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-nested-thenable-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_LIKE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE:
            "\"project-promise-like-nested-thenable-workers-scoped-precedence-ok\"",
          PROJECT_PROMISE_LIKE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE:
            "\"project-promise-like-nested-thenable-workers-direct-should-not-win\""
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

  test("supports defineWorkersProject promise-like export top-level workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-workers-direct-env.test.ts"],
              workers: ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_LIKE_TOP_LEVEL_WORKERS_DIRECT_ENV: inject("PROJECT_PROMISE_LIKE_TOP_LEVEL_WORKERS_DIRECT_ENV")
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
            return new Response(String(env.PROJECT_PROMISE_LIKE_TOP_LEVEL_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "project-promise-like-top-level-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like top-level workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-top-level-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-top-level-workers-direct-env.test.ts");
      },
      {
        env: {
          PROJECT_PROMISE_LIKE_TOP_LEVEL_WORKERS_DIRECT_ENV:
            "\"project-promise-like-top-level-workers-direct-env-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise-like export top-level workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-workers-scoped-precedence.test.ts"],
              workers: ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_LIKE_TOP_LEVEL_WORKERS_SCOPED_PRECEDENCE: inject("PROJECT_PROMISE_LIKE_TOP_LEVEL_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROJECT_PROMISE_LIKE_TOP_LEVEL_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "project-promise-like-top-level-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like top-level workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-top-level-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-top-level-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_LIKE_TOP_LEVEL_WORKERS_SCOPED_PRECEDENCE:
            "\"project-promise-like-top-level-workers-scoped-precedence-ok\"",
          PROJECT_PROMISE_LIKE_TOP_LEVEL_WORKERS_SCOPED_PRECEDENCE:
            "\"project-promise-like-top-level-workers-direct-should-not-win\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise-like export async top-level workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-async-workers-direct-env.test.ts"],
              workers: async ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_DIRECT_ENV: inject("PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_DIRECT_ENV")
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
            return new Response(String(env.PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "project-promise-like-top-level-async-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like top-level async workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-top-level-async-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-top-level-async-workers-direct-env.test.ts");
      },
      {
        env: {
          PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_DIRECT_ENV:
            "\"project-promise-like-top-level-async-workers-direct-env-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise-like export async top-level workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-async-workers-scoped-precedence.test.ts"],
              workers: async ({ inject }) => ({
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_SCOPED_PRECEDENCE: inject("PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "project-promise-like-top-level-async-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like top-level async workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-top-level-async-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-top-level-async-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_SCOPED_PRECEDENCE:
            "\"project-promise-like-top-level-async-workers-scoped-precedence-ok\"",
          PROJECT_PROMISE_LIKE_TOP_LEVEL_ASYNC_WORKERS_SCOPED_PRECEDENCE:
            "\"project-promise-like-top-level-async-workers-direct-should-not-win\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise-like export top-level thenable workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-thenable-workers-direct-env.test.ts"],
              workers: ({ inject }) => {
                const workersValue = {
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_DIRECT_ENV: inject("PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_DIRECT_ENV")
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
            return new Response(String(env.PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "project-promise-like-top-level-thenable-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like top-level thenable workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-top-level-thenable-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-top-level-thenable-workers-direct-env.test.ts");
      },
      {
        env: {
          PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_DIRECT_ENV:
            "\"project-promise-like-top-level-thenable-workers-direct-env-ok\""
        }
      }
    );
  });

  test("supports defineWorkersProject promise-like export top-level thenable workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-top-level-thenable-workers-scoped-precedence.test.ts"],
              workers: ({ inject }) => {
                const workersValue = {
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_SCOPED_PRECEDENCE: inject("PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "project-promise-like-top-level-thenable-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like top-level thenable workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-top-level-thenable-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-like-top-level-thenable-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_SCOPED_PRECEDENCE:
            "\"project-promise-like-top-level-thenable-workers-scoped-precedence-ok\"",
          PROJECT_PROMISE_LIKE_TOP_LEVEL_THENABLE_WORKERS_SCOPED_PRECEDENCE:
            "\"project-promise-like-top-level-thenable-workers-direct-should-not-win\""
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

  test("falls back to nested workers in defineWorkersProject promise-like exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-undefined-fallback.test.ts"],
              workers: undefined,
              test: {
                poolOptions: {
                  workers: {
                    main: "./worker-nested.ts",
                    miniflare: {
                      bindings: {
                        PROJECT_PROMISE_LIKE_UNDEFINED_FALLBACK_VALUE: "project-promise-like-nested-fallback-selected"
                      }
                    }
                  }
                }
              }
            };
            resolve(value);
            return Promise.resolve(value);
          }
        } as PromiseLike<any>);
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_LIKE_UNDEFINED_FALLBACK_VALUE));
          }
        };
      `,
      "project-promise-like-undefined-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like nested workers selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-nested-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-like-undefined-fallback.test.ts");
    });
  });

  test("falls back to nested workers function in defineWorkersProject promise-like exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-undefined-function-fallback.test.ts"],
              workers: undefined,
              test: {
                poolOptions: {
                  workers: () => ({
                    main: "./worker-nested.ts",
                    miniflare: {
                      bindings: {
                        PROJECT_PROMISE_LIKE_UNDEFINED_FUNCTION_FALLBACK_VALUE: "project-promise-like-nested-function-fallback-selected"
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
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_LIKE_UNDEFINED_FUNCTION_FALLBACK_VALUE));
          }
        };
      `,
      "project-promise-like-undefined-function-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like nested workers function selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-nested-function-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-like-undefined-function-fallback.test.ts");
    });
  });

  test("does not evaluate nested workers function when defineWorkersProject promise-like top-level async workers function is set end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-async-function-precedence.test.ts"],
              workers: async () => ({
                main: "./worker-top-level.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_LIKE_ASYNC_FUNCTION_PRECEDENCE_VALUE: "project-promise-like-top-level-async-function-selected"
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
            return new Response(String(env.PROJECT_PROMISE_LIKE_ASYNC_FUNCTION_PRECEDENCE_VALUE));
          }
        };
      `,
      "project-promise-like-async-function-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like top-level async workers function value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-top-level-async-function-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-like-async-function-precedence.test.ts");
    });
  });

  test("does not evaluate nested workers function when defineWorkersProject promise-like top-level thenable workers function is set end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          then(resolve) {
            const value = {
              include: ["./project-promise-like-thenable-function-precedence.test.ts"],
              workers: () => {
                const workersValue = {
                  main: "./worker-top-level.ts",
                  miniflare: {
                    bindings: {
                      PROJECT_PROMISE_LIKE_THENABLE_FUNCTION_PRECEDENCE_VALUE: "project-promise-like-top-level-thenable-function-selected"
                    }
                  }
                };
                return {
                  then(nextResolve) {
                    nextResolve(workersValue);
                    return Promise.resolve(workersValue);
                  }
                };
              },
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
            return new Response(String(env.PROJECT_PROMISE_LIKE_THENABLE_FUNCTION_PRECEDENCE_VALUE));
          }
        };
      `,
      "project-promise-like-thenable-function-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise-like top-level thenable workers function value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-like-top-level-thenable-function-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-like-thenable-function-precedence.test.ts");
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

  test("surfaces defineWorkersProject sync config function export thrown errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => {
          throw new Error("project sync config function throw e2e");
        });
      `,
      "project-sync-config-function-throw.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("project sync config function throw e2e");
    });
  });

  test("surfaces defineWorkersProject sync config function export invalid top-level workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          include: ["./project-sync-config-function-invalid-top-level-workers.test.ts"],
          workers: "invalid-workers-options"
        }));
      `,
      "project-sync-config-function-invalid-top-level-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersProject sync config function export invalid nested workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          test: {
            include: ["./project-sync-config-function-invalid-nested-workers-options.test.ts"],
            poolOptions: {
              workers: 123
            }
          }
        }));
      `,
      "project-sync-config-function-invalid-nested-workers-options.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received number."
      );
    });
  });

  test("surfaces defineWorkersProject sync config function export invalid top-level workers function return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          include: ["./project-sync-config-function-invalid-top-level-workers-return.test.ts"],
          workers: () => null
        }));
      `,
      "project-sync-config-function-invalid-top-level-workers-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject sync config function export invalid top-level workers null return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          include: ["./project-sync-config-function-invalid-top-level-workers-null-return.test.ts"],
          workers: () => null
        }));
      `,
      "project-sync-config-function-invalid-top-level-workers-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject sync config function export invalid top-level workers string return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          include: ["./project-sync-config-function-invalid-top-level-workers-string-return.test.ts"],
          workers: () => "invalid-workers-options"
        }));
      `,
      "project-sync-config-function-invalid-top-level-workers-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersProject sync config function export invalid top-level workers array return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          include: ["./project-sync-config-function-invalid-top-level-workers-array-return.test.ts"],
          workers: () => []
        }));
      `,
      "project-sync-config-function-invalid-top-level-workers-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject sync config function export invalid top-level workers undefined return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          include: ["./project-sync-config-function-invalid-top-level-workers-undefined-return.test.ts"],
          workers: () => undefined
        }));
      `,
      "project-sync-config-function-invalid-top-level-workers-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces defineWorkersProject sync config function export invalid top-level workers boolean return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          include: ["./project-sync-config-function-invalid-top-level-workers-boolean-return.test.ts"],
          workers: () => false
        }));
      `,
      "project-sync-config-function-invalid-top-level-workers-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces defineWorkersProject sync config function export invalid top-level workers number return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          include: ["./project-sync-config-function-invalid-top-level-workers-number-return.test.ts"],
          workers: () => 123
        }));
      `,
      "project-sync-config-function-invalid-top-level-workers-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces defineWorkersProject sync config function export invalid nested workers function return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          test: {
            include: ["./project-sync-config-function-invalid-nested-workers-return.test.ts"],
            poolOptions: {
              workers: () => []
            }
          }
        }));
      `,
      "project-sync-config-function-invalid-nested-workers-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject sync config function export invalid nested workers array return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          test: {
            include: ["./project-sync-config-function-invalid-nested-workers-array-return.test.ts"],
            poolOptions: {
              workers: () => []
            }
          }
        }));
      `,
      "project-sync-config-function-invalid-nested-workers-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject sync config function export invalid nested workers undefined return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          test: {
            include: ["./project-sync-config-function-invalid-nested-workers-undefined-return.test.ts"],
            poolOptions: {
              workers: () => undefined
            }
          }
        }));
      `,
      "project-sync-config-function-invalid-nested-workers-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces defineWorkersProject sync config function export invalid nested workers string return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          test: {
            include: ["./project-sync-config-function-invalid-nested-workers-string-return.test.ts"],
            poolOptions: {
              workers: () => "invalid-workers-options"
            }
          }
        }));
      `,
      "project-sync-config-function-invalid-nested-workers-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersProject sync config function export invalid nested workers null return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          test: {
            include: ["./project-sync-config-function-invalid-nested-workers-null-return.test.ts"],
            poolOptions: {
              workers: () => null
            }
          }
        }));
      `,
      "project-sync-config-function-invalid-nested-workers-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject sync config function export invalid nested workers boolean return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          test: {
            include: ["./project-sync-config-function-invalid-nested-workers-boolean-return.test.ts"],
            poolOptions: {
              workers: () => false
            }
          }
        }));
      `,
      "project-sync-config-function-invalid-nested-workers-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces defineWorkersProject sync config function export invalid nested workers number return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          test: {
            include: ["./project-sync-config-function-invalid-nested-workers-number-return.test.ts"],
            poolOptions: {
              workers: () => 123
            }
          }
        }));
      `,
      "project-sync-config-function-invalid-nested-workers-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces defineWorkersProject async config function export rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => {
          throw new Error("project async config function rejection e2e");
        });
      `,
      "project-async-config-function-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("project async config function rejection e2e");
    });
  });

  test("surfaces defineWorkersProject async config function export invalid nested workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          test: {
            include: ["./project-async-config-function-invalid-nested-workers.test.ts"],
            poolOptions: {
              workers: []
            }
          }
        }));
      `,
      "project-async-config-function-invalid-nested-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject async config function export invalid top-level workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          include: ["./project-async-config-function-invalid-top-level-workers-options.test.ts"],
          workers: 123
        }));
      `,
      "project-async-config-function-invalid-top-level-workers-options.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received number."
      );
    });
  });

  test("falls back to nested workers for defineWorkersProject async config function exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          include: ["./project-async-config-function-undefined-fallback.test.ts"],
          workers: undefined,
          test: {
            poolOptions: {
              workers: {
                main: "./worker-nested.ts",
                miniflare: {
                  bindings: {
                    PROJECT_ASYNC_CONFIG_UNDEFINED_FALLBACK: "project-async-config-nested-fallback-selected"
                  }
                }
              }
            }
          }
        }));
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_ASYNC_CONFIG_UNDEFINED_FALLBACK));
          }
        };
      `,
      "project-async-config-function-undefined-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project async config nested workers selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-async-config-nested-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-async-config-function-undefined-fallback.test.ts");
    });
  });

  test("falls back to nested workers function for defineWorkersProject async config function exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          include: ["./project-async-config-function-undefined-function-fallback.test.ts"],
          workers: undefined,
          test: {
            poolOptions: {
              workers: () => ({
                main: "./worker-nested.ts",
                miniflare: {
                  bindings: {
                    PROJECT_ASYNC_CONFIG_UNDEFINED_FUNCTION_FALLBACK: "project-async-config-nested-function-fallback-selected"
                  }
                }
              })
            }
          }
        }));
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_ASYNC_CONFIG_UNDEFINED_FUNCTION_FALLBACK));
          }
        };
      `,
      "project-async-config-function-undefined-function-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project async config nested workers function selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-async-config-nested-function-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-async-config-function-undefined-function-fallback.test.ts");
    });
  });

  test("surfaces defineWorkersProject async config function export invalid nested workers function return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          test: {
            include: ["./project-async-config-function-invalid-nested-workers-return.test.ts"],
            poolOptions: {
              workers: () => []
            }
          }
        }));
      `,
      "project-async-config-function-invalid-nested-workers-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject async config function export invalid nested workers array return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          test: {
            include: ["./project-async-config-function-invalid-nested-workers-array-return.test.ts"],
            poolOptions: {
              workers: () => []
            }
          }
        }));
      `,
      "project-async-config-function-invalid-nested-workers-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject async config function export invalid nested workers undefined return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          test: {
            include: ["./project-async-config-function-invalid-nested-workers-undefined-return.test.ts"],
            poolOptions: {
              workers: () => undefined
            }
          }
        }));
      `,
      "project-async-config-function-invalid-nested-workers-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces defineWorkersProject async config function export invalid nested workers string return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          test: {
            include: ["./project-async-config-function-invalid-nested-workers-string-return.test.ts"],
            poolOptions: {
              workers: () => "invalid-workers-options"
            }
          }
        }));
      `,
      "project-async-config-function-invalid-nested-workers-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersProject async config function export invalid nested workers null return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          test: {
            include: ["./project-async-config-function-invalid-nested-workers-null-return.test.ts"],
            poolOptions: {
              workers: () => null
            }
          }
        }));
      `,
      "project-async-config-function-invalid-nested-workers-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject async config function export invalid nested workers boolean return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          test: {
            include: ["./project-async-config-function-invalid-nested-workers-boolean-return.test.ts"],
            poolOptions: {
              workers: () => false
            }
          }
        }));
      `,
      "project-async-config-function-invalid-nested-workers-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces defineWorkersProject async config function export invalid nested workers number return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          test: {
            include: ["./project-async-config-function-invalid-nested-workers-number-return.test.ts"],
            poolOptions: {
              workers: () => 123
            }
          }
        }));
      `,
      "project-async-config-function-invalid-nested-workers-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces defineWorkersProject async config function export invalid top-level workers function return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          include: ["./project-async-config-function-invalid-top-level-workers-return.test.ts"],
          workers: () => null
        }));
      `,
      "project-async-config-function-invalid-top-level-workers-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject async config function export invalid top-level workers null return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          include: ["./project-async-config-function-invalid-top-level-workers-null-return.test.ts"],
          workers: () => null
        }));
      `,
      "project-async-config-function-invalid-top-level-workers-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject async config function export invalid top-level workers string return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          include: ["./project-async-config-function-invalid-top-level-workers-string-return.test.ts"],
          workers: () => "invalid-workers-options"
        }));
      `,
      "project-async-config-function-invalid-top-level-workers-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersProject async config function export invalid top-level workers array return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          include: ["./project-async-config-function-invalid-top-level-workers-array-return.test.ts"],
          workers: () => []
        }));
      `,
      "project-async-config-function-invalid-top-level-workers-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject async config function export invalid top-level workers undefined return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          include: ["./project-async-config-function-invalid-top-level-workers-undefined-return.test.ts"],
          workers: () => undefined
        }));
      `,
      "project-async-config-function-invalid-top-level-workers-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces defineWorkersProject async config function export invalid top-level workers boolean return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          include: ["./project-async-config-function-invalid-top-level-workers-boolean-return.test.ts"],
          workers: () => false
        }));
      `,
      "project-async-config-function-invalid-top-level-workers-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces defineWorkersProject async config function export invalid top-level workers number return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(async () => ({
          include: ["./project-async-config-function-invalid-top-level-workers-number-return.test.ts"],
          workers: () => 123
        }));
      `,
      "project-async-config-function-invalid-top-level-workers-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.reject(new Error("project promise config function rejection e2e"))
        );
      `,
      "project-promise-config-function-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("project promise config function rejection e2e");
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export invalid top-level workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            include: ["./project-promise-config-function-invalid-top-level-workers.test.ts"],
            workers: null
          })
        );
      `,
      "project-promise-config-function-invalid-top-level-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received null."
      );
    });
  });

  test("falls back to nested workers for defineWorkersProject promise-returning config function exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            include: ["./project-promise-config-function-undefined-fallback.test.ts"],
            workers: undefined,
            test: {
              poolOptions: {
                workers: {
                  main: "./worker-nested.ts",
                  miniflare: {
                    bindings: {
                      PROJECT_PROMISE_CONFIG_UNDEFINED_FALLBACK: "project-promise-config-nested-fallback-selected"
                    }
                  }
                }
              }
            }
          })
        );
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_CONFIG_UNDEFINED_FALLBACK));
          }
        };
      `,
      "project-promise-config-function-undefined-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise config-function nested workers selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-config-nested-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-config-function-undefined-fallback.test.ts");
    });
  });

  test("falls back to nested workers function for defineWorkersProject promise-returning config function exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            include: ["./project-promise-config-function-undefined-function-fallback.test.ts"],
            workers: undefined,
            test: {
              poolOptions: {
                workers: () => ({
                  main: "./worker-nested.ts",
                  miniflare: {
                    bindings: {
                      PROJECT_PROMISE_CONFIG_UNDEFINED_FUNCTION_FALLBACK: "project-promise-config-nested-function-fallback-selected"
                    }
                  }
                })
              }
            }
          })
        );
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_CONFIG_UNDEFINED_FUNCTION_FALLBACK));
          }
        };
      `,
      "project-promise-config-function-undefined-function-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise config-function nested workers function selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-config-nested-function-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain(
        "project-promise-config-function-undefined-function-fallback.test.ts"
      );
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export invalid nested workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            test: {
              include: ["./project-promise-config-function-invalid-nested-workers-options.test.ts"],
              poolOptions: {
                workers: 123
              }
            }
          })
        );
      `,
      "project-promise-config-function-invalid-nested-workers-options.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received number."
      );
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export invalid top-level workers function return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            include: ["./project-promise-config-function-invalid-top-level-workers-return.test.ts"],
            workers: () => null
          })
        );
      `,
      "project-promise-config-function-invalid-top-level-workers-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export invalid top-level workers null return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            include: ["./project-promise-config-function-invalid-top-level-workers-null-return.test.ts"],
            workers: () => null
          })
        );
      `,
      "project-promise-config-function-invalid-top-level-workers-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export invalid top-level workers string return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            include: ["./project-promise-config-function-invalid-top-level-workers-string-return.test.ts"],
            workers: () => "invalid-workers-options"
          })
        );
      `,
      "project-promise-config-function-invalid-top-level-workers-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export invalid top-level workers array return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            include: ["./project-promise-config-function-invalid-top-level-workers-array-return.test.ts"],
            workers: () => []
          })
        );
      `,
      "project-promise-config-function-invalid-top-level-workers-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export invalid top-level workers undefined return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            include: ["./project-promise-config-function-invalid-top-level-workers-undefined-return.test.ts"],
            workers: () => undefined
          })
        );
      `,
      "project-promise-config-function-invalid-top-level-workers-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export invalid top-level workers boolean return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            include: ["./project-promise-config-function-invalid-top-level-workers-boolean-return.test.ts"],
            workers: () => false
          })
        );
      `,
      "project-promise-config-function-invalid-top-level-workers-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export invalid top-level workers number return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            include: ["./project-promise-config-function-invalid-top-level-workers-number-return.test.ts"],
            workers: () => 123
          })
        );
      `,
      "project-promise-config-function-invalid-top-level-workers-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export invalid nested workers function return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            test: {
              include: ["./project-promise-config-function-invalid-nested-workers-return.test.ts"],
              poolOptions: {
                workers: () => []
              }
            }
          })
        );
      `,
      "project-promise-config-function-invalid-nested-workers-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export invalid nested workers array return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            test: {
              include: ["./project-promise-config-function-invalid-nested-workers-array-return.test.ts"],
              poolOptions: {
                workers: () => []
              }
            }
          })
        );
      `,
      "project-promise-config-function-invalid-nested-workers-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export invalid nested workers undefined return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            test: {
              include: ["./project-promise-config-function-invalid-nested-workers-undefined-return.test.ts"],
              poolOptions: {
                workers: () => undefined
              }
            }
          })
        );
      `,
      "project-promise-config-function-invalid-nested-workers-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export invalid nested workers string return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            test: {
              include: ["./project-promise-config-function-invalid-nested-workers-string-return.test.ts"],
              poolOptions: {
                workers: () => "invalid-workers-options"
              }
            }
          })
        );
      `,
      "project-promise-config-function-invalid-nested-workers-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export invalid nested workers null return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            test: {
              include: ["./project-promise-config-function-invalid-nested-workers-null-return.test.ts"],
              poolOptions: {
                workers: () => null
              }
            }
          })
        );
      `,
      "project-promise-config-function-invalid-nested-workers-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export invalid nested workers boolean return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            test: {
              include: ["./project-promise-config-function-invalid-nested-workers-boolean-return.test.ts"],
              poolOptions: {
                workers: () => false
              }
            }
          })
        );
      `,
      "project-promise-config-function-invalid-nested-workers-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces defineWorkersProject promise-returning config function export invalid nested workers number return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() =>
          Promise.resolve({
            test: {
              include: ["./project-promise-config-function-invalid-nested-workers-number-return.test.ts"],
              poolOptions: {
                workers: () => 123
              }
            }
          })
        );
      `,
      "project-promise-config-function-invalid-nested-workers-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces defineWorkersProject thenable config function export rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(_resolve, reject) {
            const error = new Error("project thenable config function rejection e2e");
            if (typeof reject === "function") {
              reject(error);
            }
            return Promise.reject(error);
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("project thenable config function rejection e2e");
    });
  });

  test("surfaces defineWorkersProject thenable config function export invalid nested workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              test: {
                include: ["./project-thenable-config-function-invalid-nested-workers.test.ts"],
                poolOptions: {
                  workers: []
                }
              }
            });
            return Promise.resolve({
              test: {
                include: ["./project-thenable-config-function-invalid-nested-workers.test.ts"],
                poolOptions: {
                  workers: []
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-function-invalid-nested-workers.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject thenable config function export invalid top-level workers options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              include: ["./project-thenable-config-function-invalid-top-level-workers-options.test.ts"],
              workers: 123
            });
            return Promise.resolve({
              include: ["./project-thenable-config-function-invalid-top-level-workers-options.test.ts"],
              workers: 123
            });
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-function-invalid-top-level-workers-options.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received number."
      );
    });
  });

  test("falls back to nested workers for defineWorkersProject thenable config function exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              include: ["./project-thenable-config-function-undefined-fallback.test.ts"],
              workers: undefined,
              test: {
                poolOptions: {
                  workers: {
                    main: "./worker-nested.ts",
                    miniflare: {
                      bindings: {
                        PROJECT_THENABLE_CONFIG_UNDEFINED_FALLBACK: "project-thenable-config-nested-fallback-selected"
                      }
                    }
                  }
                }
              }
            });
            return Promise.resolve({
              include: ["./project-thenable-config-function-undefined-fallback.test.ts"],
              workers: undefined,
              test: {
                poolOptions: {
                  workers: {
                    main: "./worker-nested.ts",
                    miniflare: {
                      bindings: {
                        PROJECT_THENABLE_CONFIG_UNDEFINED_FALLBACK: "project-thenable-config-nested-fallback-selected"
                      }
                    }
                  }
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_THENABLE_CONFIG_UNDEFINED_FALLBACK));
          }
        };
      `,
      "project-thenable-config-function-undefined-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project thenable config-function nested workers selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-thenable-config-nested-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-thenable-config-function-undefined-fallback.test.ts");
    });
  });

  test("falls back to nested workers function for defineWorkersProject thenable config function exports when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              include: ["./project-thenable-config-function-undefined-function-fallback.test.ts"],
              workers: undefined,
              test: {
                poolOptions: {
                  workers: () => ({
                    main: "./worker-nested.ts",
                    miniflare: {
                      bindings: {
                        PROJECT_THENABLE_CONFIG_UNDEFINED_FUNCTION_FALLBACK: "project-thenable-config-nested-function-fallback-selected"
                      }
                    }
                  })
                }
              }
            });
            return Promise.resolve({
              include: ["./project-thenable-config-function-undefined-function-fallback.test.ts"],
              workers: undefined,
              test: {
                poolOptions: {
                  workers: () => ({
                    main: "./worker-nested.ts",
                    miniflare: {
                      bindings: {
                        PROJECT_THENABLE_CONFIG_UNDEFINED_FUNCTION_FALLBACK: "project-thenable-config-nested-function-fallback-selected"
                      }
                    }
                  })
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_THENABLE_CONFIG_UNDEFINED_FUNCTION_FALLBACK));
          }
        };
      `,
      "project-thenable-config-function-undefined-function-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project thenable config-function nested workers function selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-thenable-config-nested-function-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain(
        "project-thenable-config-function-undefined-function-fallback.test.ts"
      );
    });
  });

  test("surfaces defineWorkersProject thenable config function export invalid nested workers function return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              test: {
                include: ["./project-thenable-config-function-invalid-nested-workers-return.test.ts"],
                poolOptions: {
                  workers: () => []
                }
              }
            });
            return Promise.resolve({
              test: {
                include: ["./project-thenable-config-function-invalid-nested-workers-return.test.ts"],
                poolOptions: {
                  workers: () => []
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-function-invalid-nested-workers-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject thenable config function export invalid nested workers array return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              test: {
                include: ["./project-thenable-config-function-invalid-nested-workers-array-return.test.ts"],
                poolOptions: {
                  workers: () => []
                }
              }
            });
            return Promise.resolve({
              test: {
                include: ["./project-thenable-config-function-invalid-nested-workers-array-return.test.ts"],
                poolOptions: {
                  workers: () => []
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-function-invalid-nested-workers-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject thenable config function export invalid nested workers undefined return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              test: {
                include: ["./project-thenable-config-function-invalid-nested-workers-undefined-return.test.ts"],
                poolOptions: {
                  workers: () => undefined
                }
              }
            });
            return Promise.resolve({
              test: {
                include: ["./project-thenable-config-function-invalid-nested-workers-undefined-return.test.ts"],
                poolOptions: {
                  workers: () => undefined
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-function-invalid-nested-workers-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces defineWorkersProject thenable config function export invalid nested workers string return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              test: {
                include: ["./project-thenable-config-function-invalid-nested-workers-string-return.test.ts"],
                poolOptions: {
                  workers: () => "invalid-workers-options"
                }
              }
            });
            return Promise.resolve({
              test: {
                include: ["./project-thenable-config-function-invalid-nested-workers-string-return.test.ts"],
                poolOptions: {
                  workers: () => "invalid-workers-options"
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-function-invalid-nested-workers-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersProject thenable config function export invalid nested workers null return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              test: {
                include: ["./project-thenable-config-function-invalid-nested-workers-null-return.test.ts"],
                poolOptions: {
                  workers: () => null
                }
              }
            });
            return Promise.resolve({
              test: {
                include: ["./project-thenable-config-function-invalid-nested-workers-null-return.test.ts"],
                poolOptions: {
                  workers: () => null
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-function-invalid-nested-workers-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject thenable config function export invalid nested workers boolean return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              test: {
                include: ["./project-thenable-config-function-invalid-nested-workers-boolean-return.test.ts"],
                poolOptions: {
                  workers: () => false
                }
              }
            });
            return Promise.resolve({
              test: {
                include: ["./project-thenable-config-function-invalid-nested-workers-boolean-return.test.ts"],
                poolOptions: {
                  workers: () => false
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-function-invalid-nested-workers-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces defineWorkersProject thenable config function export invalid nested workers number return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              test: {
                include: ["./project-thenable-config-function-invalid-nested-workers-number-return.test.ts"],
                poolOptions: {
                  workers: () => 123
                }
              }
            });
            return Promise.resolve({
              test: {
                include: ["./project-thenable-config-function-invalid-nested-workers-number-return.test.ts"],
                poolOptions: {
                  workers: () => 123
                }
              }
            });
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-function-invalid-nested-workers-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces defineWorkersProject thenable config function export invalid top-level workers function return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              include: ["./project-thenable-config-function-invalid-top-level-workers-return.test.ts"],
              workers: () => null
            });
            return Promise.resolve({
              include: ["./project-thenable-config-function-invalid-top-level-workers-return.test.ts"],
              workers: () => null
            });
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-function-invalid-top-level-workers-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject thenable config function export invalid top-level workers null return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              include: ["./project-thenable-config-function-invalid-top-level-workers-null-return.test.ts"],
              workers: () => null
            });
            return Promise.resolve({
              include: ["./project-thenable-config-function-invalid-top-level-workers-null-return.test.ts"],
              workers: () => null
            });
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-function-invalid-top-level-workers-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject thenable config function export invalid top-level workers string return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              include: ["./project-thenable-config-function-invalid-top-level-workers-string-return.test.ts"],
              workers: () => "invalid-workers-options"
            });
            return Promise.resolve({
              include: ["./project-thenable-config-function-invalid-top-level-workers-string-return.test.ts"],
              workers: () => "invalid-workers-options"
            });
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-function-invalid-top-level-workers-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersProject thenable config function export invalid top-level workers array return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              include: ["./project-thenable-config-function-invalid-top-level-workers-array-return.test.ts"],
              workers: () => []
            });
            return Promise.resolve({
              include: ["./project-thenable-config-function-invalid-top-level-workers-array-return.test.ts"],
              workers: () => []
            });
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-function-invalid-top-level-workers-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject thenable config function export invalid top-level workers undefined return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              include: ["./project-thenable-config-function-invalid-top-level-workers-undefined-return.test.ts"],
              workers: () => undefined
            });
            return Promise.resolve({
              include: ["./project-thenable-config-function-invalid-top-level-workers-undefined-return.test.ts"],
              workers: () => undefined
            });
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-function-invalid-top-level-workers-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces defineWorkersProject thenable config function export invalid top-level workers boolean return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              include: ["./project-thenable-config-function-invalid-top-level-workers-boolean-return.test.ts"],
              workers: () => false
            });
            return Promise.resolve({
              include: ["./project-thenable-config-function-invalid-top-level-workers-boolean-return.test.ts"],
              workers: () => false
            });
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-function-invalid-top-level-workers-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces defineWorkersProject thenable config function export invalid top-level workers number return options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(() => ({
          then(resolve) {
            resolve({
              include: ["./project-thenable-config-function-invalid-top-level-workers-number-return.test.ts"],
              workers: () => 123
            });
            return Promise.resolve({
              include: ["./project-thenable-config-function-invalid-top-level-workers-number-return.test.ts"],
              workers: () => 123
            });
          }
        }) as PromiseLike<any>);
      `,
      "project-thenable-config-function-invalid-top-level-workers-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received number."
      );
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

  test("supports defineWorkersProject config function thenable exports with single preinstalled workers plugin value end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersProject(() => {
          const value = {
            plugins: workersRsbuildPlugin(),
            include: ["./project-config-function-thenable-single-preinstalled.test.ts"],
            workers: {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROJECT_THENABLE_CONFIG_SINGLE_PREINSTALLED_VALUE: "project-thenable-config-single-preinstalled-ok"
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
            return new Response(String(env.PROJECT_THENABLE_CONFIG_SINGLE_PREINSTALLED_VALUE));
          }
        };
      `,
      "project-config-function-thenable-single-preinstalled.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project thenable config function export with single preinstalled plugin is resolved", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-thenable-config-single-preinstalled-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-config-function-thenable-single-preinstalled.test.ts");
    });
  });

  test("supports defineWorkersProject config function thenable exports with falsey plugin entries and preinstalled workers plugin end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const pluginPathImport = path.join(packageRoot, "src", "plugin", "workers-plugin.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        import { workersRsbuildPlugin } from ${JSON.stringify(pluginPathImport)};
        export default defineWorkersProject(() => {
          const value = {
            plugins: [false as any, workersRsbuildPlugin()],
            include: ["./project-config-function-thenable-falsey-preinstalled.test.ts"],
            workers: {
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROJECT_THENABLE_CONFIG_FALSEY_PREINSTALLED_VALUE: "project-thenable-config-falsey-preinstalled-ok"
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
            return new Response(String(env.PROJECT_THENABLE_CONFIG_FALSEY_PREINSTALLED_VALUE));
          }
        };
      `,
      "project-config-function-thenable-falsey-preinstalled.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project thenable config function export with falsey + preinstalled plugin is resolved", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-thenable-config-falsey-preinstalled-ok");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-config-function-thenable-falsey-preinstalled.test.ts");
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

  test("falls back to nested workers in defineWorkersProject promise export when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-undefined-fallback.test.ts"],
            workers: undefined,
            test: {
              poolOptions: {
                workers: {
                  main: "./worker-nested.ts",
                  miniflare: {
                    bindings: {
                      PROJECT_PROMISE_UNDEFINED_FALLBACK_VALUE: "project-promise-nested-fallback-selected"
                    }
                  }
                }
              }
            }
          })
        );
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_UNDEFINED_FALLBACK_VALUE));
          }
        };
      `,
      "project-promise-undefined-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise nested workers selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-nested-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-undefined-fallback.test.ts");
    });
  });

  test("falls back to nested workers function in defineWorkersProject promise export when top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-undefined-function-fallback.test.ts"],
            workers: undefined,
            test: {
              poolOptions: {
                workers: () => ({
                  main: "./worker-nested.ts",
                  miniflare: {
                    bindings: {
                      PROJECT_PROMISE_UNDEFINED_FUNCTION_FALLBACK_VALUE: "project-promise-nested-function-fallback-selected"
                    }
                  }
                })
              }
            }
          })
        );
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_UNDEFINED_FUNCTION_FALLBACK_VALUE));
          }
        };
      `,
      "project-promise-undefined-function-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise nested workers function selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-nested-function-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-undefined-function-fallback.test.ts");
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

  test("does not evaluate nested workers function in defineWorkersProject promise export when top-level async function is set end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-async-function-precedence.test.ts"],
            workers: async () => ({
              main: "./worker-top-level.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_ASYNC_FUNCTION_PRECEDENCE_VALUE: "project-promise-top-level-async-function-selected"
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
            return new Response(String(env.PROJECT_PROMISE_ASYNC_FUNCTION_PRECEDENCE_VALUE));
          }
        };
      `,
      "project-promise-async-function-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise top-level async workers function value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-top-level-async-function-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-async-function-precedence.test.ts");
    });
  });

  test("does not evaluate nested workers function in defineWorkersProject promise export when top-level thenable function is set end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-thenable-function-precedence.test.ts"],
            workers: () => {
              const workersValue = {
                main: "./worker-top-level.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_THENABLE_FUNCTION_PRECEDENCE_VALUE: "project-promise-top-level-thenable-function-selected"
                  }
                }
              };
              return {
                then(resolve) {
                  resolve(workersValue);
                  return Promise.resolve(workersValue);
                }
              };
            },
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
            return new Response(String(env.PROJECT_PROMISE_THENABLE_FUNCTION_PRECEDENCE_VALUE));
          }
        };
      `,
      "project-promise-thenable-function-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise top-level thenable workers function value wins", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-top-level-thenable-function-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-promise-thenable-function-precedence.test.ts");
    });
  });

  test("surfaces defineWorkersProject promise export nested workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-rejection.test.ts"],
              poolOptions: {
                workers: () => Promise.reject(new Error("project promise nested workers rejection e2e"))
              }
            }
          })
        );
      `,
      "project-promise-nested-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("project promise nested workers rejection e2e");
    });
  });

  test("surfaces defineWorkersProject promise export nested async workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-async-rejection.test.ts"],
              poolOptions: {
                workers: async () => {
                  throw new Error("project promise nested async workers rejection e2e");
                }
              }
            }
          })
        );
      `,
      "project-promise-nested-async-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("project promise nested async workers rejection e2e");
    });
  });

  test("surfaces defineWorkersProject promise export nested workers thrown errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-throw.test.ts"],
              poolOptions: {
                workers: () => {
                  throw new Error("project promise nested workers throw e2e");
                }
              }
            }
          })
        );
      `,
      "project-promise-nested-throw.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("project promise nested workers throw e2e");
    });
  });

  test("surfaces defineWorkersProject promise export nested workers invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-invalid-options.test.ts"],
              poolOptions: {
                workers: () => undefined
              }
            }
          })
        );
      `,
      "project-promise-nested-invalid-options.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces defineWorkersProject promise export nested workers array return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-invalid-options-array-return.test.ts"],
              poolOptions: {
                workers: () => []
              }
            }
          })
        );
      `,
      "project-promise-nested-invalid-options-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject promise export nested workers string return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-invalid-options-string-return.test.ts"],
              poolOptions: {
                workers: () => "invalid-project-promise-nested-options"
              }
            }
          })
        );
      `,
      "project-promise-nested-invalid-options-string-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersProject promise export nested workers boolean return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-invalid-options-boolean-return.test.ts"],
              poolOptions: {
                workers: () => false
              }
            }
          })
        );
      `,
      "project-promise-nested-invalid-options-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces defineWorkersProject promise export nested workers number return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-invalid-options-number-return.test.ts"],
              poolOptions: {
                workers: () => 123
              }
            }
          })
        );
      `,
      "project-promise-nested-invalid-options-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces defineWorkersProject promise export nested workers null return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-invalid-options-null-return.test.ts"],
              poolOptions: {
                workers: () => null
              }
            }
          })
        );
      `,
      "project-promise-nested-invalid-options-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject promise export nested thenable workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-thenable-rejection.test.ts"],
              poolOptions: {
                workers: () => ({
                  then(_onfulfilled, onrejected) {
                    const error = new Error("project promise nested thenable workers rejection e2e");
                    if (typeof onrejected === "function") {
                      onrejected(error);
                    }
                    return Promise.reject(error);
                  }
                })
              }
            }
          })
        );
      `,
      "project-promise-nested-thenable-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "project promise nested thenable workers rejection e2e"
      );
    });
  });

  test("surfaces defineWorkersProject promise export nested thenable workers thrown errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-thenable-throw.test.ts"],
              poolOptions: {
                workers: () => ({
                  then() {
                    throw new Error("project promise nested thenable workers throw e2e");
                  }
                })
              }
            }
          })
        );
      `,
      "project-promise-nested-thenable-throw.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("project promise nested thenable workers throw e2e");
    });
  });

  test("surfaces defineWorkersProject promise export top-level workers thrown errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-throw.test.ts"],
            workers: () => {
              throw new Error("project promise top-level workers throw e2e");
            }
          })
        );
      `,
      "project-promise-top-level-throw.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("project promise top-level workers throw e2e");
    });
  });

  test("surfaces defineWorkersProject promise export top-level workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-rejection.test.ts"],
            workers: () => Promise.reject(new Error("project promise top-level workers rejection e2e"))
          })
        );
      `,
      "project-promise-top-level-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain("project promise top-level workers rejection e2e");
    });
  });

  test("surfaces defineWorkersProject promise export top-level workers invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-invalid-options.test.ts"],
            workers: () => "invalid-workers-options"
          })
        );
      `,
      "project-promise-top-level-invalid-options.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersProject promise export top-level workers null return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-invalid-options-null-return.test.ts"],
            workers: () => null
          })
        );
      `,
      "project-promise-top-level-invalid-options-null-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received null."
      );
    });
  });

  test("surfaces defineWorkersProject promise export top-level workers undefined return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-invalid-options-undefined-return.test.ts"],
            workers: () => undefined
          })
        );
      `,
      "project-promise-top-level-invalid-options-undefined-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received undefined."
      );
    });
  });

  test("surfaces defineWorkersProject promise export top-level workers array return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-invalid-options-array-return.test.ts"],
            workers: () => []
          })
        );
      `,
      "project-promise-top-level-invalid-options-array-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject promise export top-level workers boolean return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-invalid-options-boolean-return.test.ts"],
            workers: () => false
          })
        );
      `,
      "project-promise-top-level-invalid-options-boolean-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received boolean."
      );
    });
  });

  test("surfaces defineWorkersProject promise export top-level workers number return invalid options errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-invalid-options-number-return.test.ts"],
            workers: () => 123
          })
        );
      `,
      "project-promise-top-level-invalid-options-number-return.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers() return value: expected an object but received number."
      );
    });
  });

  test("surfaces defineWorkersProject promise export top-level async workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-async-rejection.test.ts"],
            workers: async () => {
              throw new Error("project promise top-level async workers rejection e2e");
            }
          })
        );
      `,
      "project-promise-top-level-async-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "project promise top-level async workers rejection e2e"
      );
    });
  });

  test("surfaces defineWorkersProject promise export top-level thenable workers rejection end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-thenable-rejection.test.ts"],
            workers: () => ({
              then(_onfulfilled, onrejected) {
                const error = new Error("project promise top-level thenable workers rejection e2e");
                if (typeof onrejected === "function") {
                  onrejected(error);
                }
                return Promise.reject(error);
              }
            })
          })
        );
      `,
      "project-promise-top-level-thenable-rejection.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "project promise top-level thenable workers rejection e2e"
      );
    });
  });

  test("surfaces defineWorkersProject promise export top-level thenable workers thrown errors end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-thenable-throw.test.ts"],
            workers: () => ({
              then() {
                throw new Error("project promise top-level thenable workers throw e2e");
              }
            })
          })
        );
      `,
      "project-promise-top-level-thenable-throw.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "project promise top-level thenable workers throw e2e"
      );
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

  test("supports defineWorkersProject promise export top-level thenable workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-workers-fn-thenable-direct-env.test.ts"],
            workers: ({ inject }) => {
              const value = {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_DIRECT_ENV: inject("PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_DIRECT_ENV")
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
            return new Response(String(env.PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_DIRECT_ENV));
          }
        };
      `,
      "project-promise-top-level-workers-fn-thenable-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise top-level thenable workers direct-env fallback is wired", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-top-level-workers-fn-thenable-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-top-level-workers-fn-thenable-direct-env.test.ts");
      },
      {
        env: {
          PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_DIRECT_ENV:
            "project-promise-top-level-workers-fn-thenable-direct-env-ok"
        }
      }
    );
  });

  test("supports defineWorkersProject promise export top-level thenable workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-workers-fn-thenable-scoped-precedence.test.ts"],
            workers: ({ inject }) => {
              const value = {
                main: "./worker.ts",
                miniflare: {
                  bindings: {
                    PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_SCOPED_PRECEDENCE: inject("PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_SCOPED_PRECEDENCE));
          }
        };
      `,
      "project-promise-top-level-workers-fn-thenable-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise top-level thenable workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-top-level-workers-fn-thenable-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-top-level-workers-fn-thenable-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_SCOPED_PRECEDENCE:
            "project-promise-top-level-workers-fn-thenable-scoped-precedence-ok",
          PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_THENABLE_SCOPED_PRECEDENCE:
            "project-promise-top-level-workers-fn-thenable-direct-should-not-win"
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

  test("supports defineWorkersProject promise export async top-level workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-workers-fn-async-scoped-precedence.test.ts"],
            workers: async ({ inject }) => ({
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_SCOPED_PRECEDENCE: inject("PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_SCOPED_PRECEDENCE")
                }
              }
            })
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_SCOPED_PRECEDENCE));
          }
        };
      `,
      "project-promise-top-level-workers-fn-async-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise async top-level workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-top-level-workers-fn-async-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-top-level-workers-fn-async-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_SCOPED_PRECEDENCE:
            "project-promise-top-level-workers-fn-async-scoped-precedence-ok",
          PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_ASYNC_SCOPED_PRECEDENCE:
            "project-promise-top-level-workers-fn-async-direct-should-not-win"
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

  test("supports defineWorkersProject promise export top-level workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            include: ["./project-promise-top-level-workers-fn-scoped-precedence.test.ts"],
            workers: ({ inject }) => ({
              main: "./worker.ts",
              miniflare: {
                bindings: {
                  PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_SCOPED_PRECEDENCE: inject("PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_SCOPED_PRECEDENCE")
                }
              }
            })
          })
        );
      `,
      "worker.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_SCOPED_PRECEDENCE));
          }
        };
      `,
      "project-promise-top-level-workers-fn-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise top-level workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-top-level-workers-fn-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-top-level-workers-fn-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_SCOPED_PRECEDENCE:
            "project-promise-top-level-workers-fn-scoped-precedence-ok",
          PROJECT_PROMISE_TOP_LEVEL_WORKERS_FN_SCOPED_PRECEDENCE:
            "project-promise-top-level-workers-fn-direct-should-not-win"
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

  test("supports defineWorkersProject promise nested workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-workers-direct-env.test.ts"],
              poolOptions: {
                workers: ({ inject }) => ({
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROJECT_PROMISE_NESTED_WORKERS_DIRECT_ENV: inject("PROJECT_PROMISE_NESTED_WORKERS_DIRECT_ENV")
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
            return new Response(String(env.PROJECT_PROMISE_NESTED_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "project-promise-nested-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise nested workers direct-env fallback wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-nested-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-nested-workers-direct-env.test.ts");
      },
      {
        env: {
          PROJECT_PROMISE_NESTED_WORKERS_DIRECT_ENV: "project-promise-nested-workers-direct-env-ok"
        }
      }
    );
  });

  test("supports defineWorkersProject promise nested workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-workers-scoped-precedence.test.ts"],
              poolOptions: {
                workers: ({ inject }) => ({
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROJECT_PROMISE_NESTED_WORKERS_SCOPED_PRECEDENCE: inject("PROJECT_PROMISE_NESTED_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROJECT_PROMISE_NESTED_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "project-promise-nested-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise nested workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-nested-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-nested-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_NESTED_WORKERS_SCOPED_PRECEDENCE:
            "project-promise-nested-workers-scoped-precedence-ok",
          PROJECT_PROMISE_NESTED_WORKERS_SCOPED_PRECEDENCE:
            "project-promise-nested-workers-direct-should-not-win"
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

  test("supports defineWorkersProject promise nested async workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-async-workers-scoped-precedence.test.ts"],
              poolOptions: {
                workers: async ({ inject }) => ({
                  main: "./worker.ts",
                  miniflare: {
                    bindings: {
                      PROJECT_PROMISE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE: inject("PROJECT_PROMISE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROJECT_PROMISE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "project-promise-nested-async-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise nested async workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-nested-async-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-nested-async-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE:
            "project-promise-nested-async-workers-scoped-precedence-ok",
          PROJECT_PROMISE_NESTED_ASYNC_WORKERS_SCOPED_PRECEDENCE:
            "project-promise-nested-async-workers-direct-should-not-win"
        }
      }
    );
  });

  test("supports defineWorkersProject promise nested thenable workers direct-env fallback end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-thenable-workers-direct-env.test.ts"],
              poolOptions: {
                workers: ({ inject }) => {
                  const value = {
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROJECT_PROMISE_NESTED_THENABLE_WORKERS_DIRECT_ENV: inject("PROJECT_PROMISE_NESTED_THENABLE_WORKERS_DIRECT_ENV")
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
            return new Response(String(env.PROJECT_PROMISE_NESTED_THENABLE_WORKERS_DIRECT_ENV));
          }
        };
      `,
      "project-promise-nested-thenable-workers-direct-env.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise nested thenable workers direct-env fallback wiring works", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-nested-thenable-workers-direct-env-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-nested-thenable-workers-direct-env.test.ts");
      },
      {
        env: {
          PROJECT_PROMISE_NESTED_THENABLE_WORKERS_DIRECT_ENV:
            "project-promise-nested-thenable-workers-direct-env-ok"
        }
      }
    );
  });

  test("supports defineWorkersProject promise nested thenable workers scoped-env precedence end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject(
          Promise.resolve({
            test: {
              include: ["./project-promise-nested-thenable-workers-scoped-precedence.test.ts"],
              poolOptions: {
                workers: ({ inject }) => {
                  const value = {
                    main: "./worker.ts",
                    miniflare: {
                      bindings: {
                        PROJECT_PROMISE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE: inject("PROJECT_PROMISE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE")
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
            return new Response(String(env.PROJECT_PROMISE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE));
          }
        };
      `,
      "project-promise-nested-thenable-workers-scoped-precedence.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project promise nested thenable workers scoped env wins over direct env", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-promise-nested-thenable-workers-scoped-precedence-ok");
        });
      `
    };

    await runFixture(
      files,
      ({ stdout, stderr }) => {
        expect(stderr).toBe("");
        expect(stdout).toContain('"status": "pass"');
        expect(stdout).toContain("project-promise-nested-thenable-workers-scoped-precedence.test.ts");
      },
      {
        env: {
          RSTEST_INJECT_PROJECT_PROMISE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE:
            "project-promise-nested-thenable-workers-scoped-precedence-ok",
          PROJECT_PROMISE_NESTED_THENABLE_WORKERS_SCOPED_PRECEDENCE:
            "project-promise-nested-thenable-workers-direct-should-not-win"
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

  test("surfaces defineWorkersProject object export invalid top-level workers boolean options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          include: ["./project-object-invalid-top-level-workers-boolean.test.ts"],
          workers: false
        });
      `,
      "project-object-invalid-top-level-workers-boolean.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received boolean."
      );
    });
  });

  test("surfaces defineWorkersProject object export invalid top-level workers array options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          include: ["./project-object-invalid-top-level-workers-array.test.ts"],
          workers: []
        });
      `,
      "project-object-invalid-top-level-workers-array.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from workers: expected an object but received array."
      );
    });
  });

  test("surfaces defineWorkersProject object export invalid nested workers string options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          test: {
            include: ["./project-object-invalid-nested-workers-string.test.ts"],
            poolOptions: {
              workers: "invalid-workers-options"
            }
          }
        });
      `,
      "project-object-invalid-nested-workers-string.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received string."
      );
    });
  });

  test("surfaces defineWorkersProject object export invalid nested workers null options end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");
    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          test: {
            include: ["./project-object-invalid-nested-workers-null.test.ts"],
            poolOptions: {
              workers: null
            }
          }
        });
      `,
      "project-object-invalid-nested-workers-null.test.ts": `
        import { test } from "@rstest/core";

        test("placeholder", () => {
          // config resolution should fail before this executes
        });
      `
    };

    await runFixtureExpectFailure(files, ({ stdout, stderr }) => {
      expect(`${stdout}${stderr}`).toContain(
        "Invalid workers options from test.poolOptions.workers: expected an object but received null."
      );
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

  test("falls back to nested workers when defineWorkersProject top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          include: ["./project-workers-undefined-fallback.test.ts"],
          workers: undefined,
          test: {
            poolOptions: {
              workers: {
                main: "./worker-nested.ts",
                miniflare: {
                  bindings: {
                    PROJECT_WORKERS_UNDEFINED_FALLBACK: "project-nested-fallback-selected"
                  }
                }
              }
            }
          }
        });
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_WORKERS_UNDEFINED_FALLBACK));
          }
        };
      `,
      "project-workers-undefined-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project nested workers value is selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-nested-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-workers-undefined-fallback.test.ts");
    });
  });

  test("falls back to nested workers function when defineWorkersProject top-level workers is undefined end-to-end", async () => {
    const packageRoot = process.cwd();
    const configPathImport = path.join(packageRoot, "src", "config", "index.ts").replaceAll("\\", "/");

    const files: Record<string, string> = {
      "rstest.config.ts": `
        import { defineWorkersProject } from ${JSON.stringify(configPathImport)};
        export default defineWorkersProject({
          include: ["./project-workers-function-undefined-fallback.test.ts"],
          workers: undefined,
          test: {
            poolOptions: {
              workers: () => ({
                main: "./worker-nested.ts",
                miniflare: {
                  bindings: {
                    PROJECT_WORKERS_FUNCTION_UNDEFINED_FALLBACK: "project-nested-function-fallback-selected"
                  }
                }
              })
            }
          }
        });
      `,
      "worker-nested.ts": `
        export default {
          fetch(_request, env) {
            return new Response(String(env.PROJECT_WORKERS_FUNCTION_UNDEFINED_FALLBACK));
          }
        };
      `,
      "project-workers-function-undefined-fallback.test.ts": `
        import { test, expect } from "@rstest/core";
        import { SELF } from "cloudflare:test";

        test("project nested workers function value is selected when top-level workers is undefined", async () => {
          const res = await SELF.fetch("http://localhost/");
          expect(await res.text()).toBe("project-nested-function-fallback-selected");
        });
      `
    };

    await runFixture(files, ({ stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(stdout).toContain('"status": "pass"');
      expect(stdout).toContain("project-workers-function-undefined-fallback.test.ts");
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
