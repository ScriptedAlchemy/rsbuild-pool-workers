import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "@rstest/core";
import {
  SELF,
  type DurableObjectNamespaceLike,
  type DurableObjectStatePlaceholder,
  type DurableObjectStubLike,
  env as workersEnv,
  fetchMock,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject
} from "../src/cloudflare-test/index";
import {
  setWorkersRuntimeOptionsForTesting
} from "../src/runtime/options";
import { getWorkersRuntimeState } from "../src/runtime/state";

const runtime = getWorkersRuntimeState();

afterEach(async () => {
  await runtime.teardown();
  setWorkersRuntimeOptionsForTesting(undefined);
});

describe("Workers runtime state integration", () => {
  test("SELF.fetch executes worker script and exposes bindings through env", async () => {
    setWorkersRuntimeOptionsForTesting({
      miniflare: {
        modules: true,
        script: `
          export default {
            fetch(_request, env) {
              return new Response(String(env.ANSWER));
            }
          };
        `,
        bindings: {
          ANSWER: 42
        }
      }
    });

    const response = await SELF.fetch("http://localhost/");
    expect(await response.text()).toBe("42");
    expect(workersEnv.ANSWER).toBe(42);
    expect("ANSWER" in workersEnv).toBe(true);
    expect(Object.keys(workersEnv)).toContain("ANSWER");
    expect(Object.getOwnPropertyDescriptor(workersEnv, "ANSWER")).toBeDefined();
    expect(Object.getOwnPropertyDescriptor(workersEnv, "MISSING")).toBeUndefined();
    expect(() => {
      (workersEnv as Record<string, unknown>).ANSWER = 7;
    }).toThrow("Cannot assign to read only property on cloudflare:test env.");
    expect(() => {
      delete (workersEnv as Record<string, unknown>).ANSWER;
    }).toThrow("Cannot delete properties from cloudflare:test env.");
    expect(() => {
      Object.defineProperty(workersEnv, "ANSWER", { value: 9 });
    }).toThrow("Cannot redefine properties on cloudflare:test env.");
  });

  test("SELF.fetch supports Request inputs with method/body semantics", async () => {
    setWorkersRuntimeOptionsForTesting({
      miniflare: {
        modules: true,
        script: `
          export default {
            async fetch(request) {
              const body = await request.text();
              return new Response(request.method + ":" + body);
            }
          };
        `
      }
    });

    const request = new Request("http://localhost/", {
      method: "POST",
      body: "payload"
    });
    const response = await SELF.fetch(request);
    expect(await response.text()).toBe("POST:payload");
  });

  test("SELF.fetch supports URL object inputs", async () => {
    setWorkersRuntimeOptionsForTesting({
      miniflare: {
        modules: true,
        script: `
          export default {
            fetch(request) {
              return new Response(new URL(request.url).pathname);
            }
          };
        `
      }
    });

    const response = await SELF.fetch(new URL("http://localhost/url-input"));
    expect(await response.text()).toBe("/url-input");
  });

  test("pushStorageSnapshot and popStorageSnapshot restore persisted KV state", async () => {
    const persistRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-kv-"));

    setWorkersRuntimeOptionsForTesting({
      miniflare: {
        modules: true,
        script: `
          export default {
            async fetch(request, env) {
              if (request.url.endsWith("/inc")) {
                const value = Number((await env.COUNTER.get("count")) ?? "0") + 1;
                await env.COUNTER.put("count", String(value));
                return new Response(String(value));
              }

              return new Response((await env.COUNTER.get("count")) ?? "0");
            }
          };
        `,
        kvNamespaces: ["COUNTER"],
        kvPersist: path.join(persistRoot, "kv")
      }
    });

    await runtime.setup();

    await runtime.dispatchFetch("http://localhost/inc");
    await runtime.dispatchFetch("http://localhost/inc");

    const beforeSnapshot = await runtime.dispatchFetch("http://localhost/");
    expect(await beforeSnapshot.text()).toBe("2");

    await runtime.pushStorageSnapshot();
    await runtime.dispatchFetch("http://localhost/inc");

    const inSnapshot = await runtime.dispatchFetch("http://localhost/");
    expect(await inSnapshot.text()).toBe("3");

    await runtime.popStorageSnapshot();

    const afterRestore = await runtime.dispatchFetch("http://localhost/");
    expect(await afterRestore.text()).toBe("2");

    await fs.rm(persistRoot, { recursive: true, force: true });
  });

  test("listDurableObjectIds enumerates created Durable Object IDs", async () => {
    const persistRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-do-"));

    setWorkersRuntimeOptionsForTesting({
      miniflare: {
        name: "worker",
        modules: true,
        script: `
          export class Counter {
            constructor(state) {
              this.state = state;
            }
            async fetch() {
              return new Response("ok");
            }
          }

          export default {
            async fetch(request, env) {
              if (request.url.endsWith("/create")) {
                const id = env.COUNTER.newUniqueId();
                await env.COUNTER.get(id).fetch("http://localhost/");
                return new Response(id.toString());
              }
              return new Response("noop");
            }
          };
        `,
        durableObjects: {
          COUNTER: "Counter"
        },
        durableObjectsPersist: path.join(persistRoot, "do")
      }
    });

    await runtime.setup();
    const first = await runtime.dispatchFetch("http://localhost/create");
    const second = await runtime.dispatchFetch("http://localhost/create");
    const createdIds = [await first.text(), await second.text()];

    const ids = await listDurableObjectIds(
      workersEnv.COUNTER as unknown as DurableObjectNamespaceLike
    );
    const idStrings = ids.map((id) =>
      typeof id === "object" && id !== null && "toString" in id
        ? String((id as { toString: () => string }).toString())
        : String(id)
    );
    for (const createdId of createdIds) {
      expect(idStrings).toContain(createdId);
    }
    expect(idStrings).toEqual([...idStrings].sort((a, b) => a.localeCompare(b)));

    await fs.rm(persistRoot, { recursive: true, force: true });
  });

  test("fetchMock intercepts outbound fetch and resets interceptor state", async () => {
    setWorkersRuntimeOptionsForTesting({
      miniflare: {
        modules: true,
        script: `
          export default {
            async fetch() {
              const response = await fetch("http://example.com/data");
              return new Response(await response.text());
            }
          };
        `
      }
    });

    await runtime.setup();
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock
      .get("http://example.com")
      .intercept({ path: "/data", method: "GET" })
      .reply(200, "mocked-1");

    const response1 = await SELF.fetch("http://localhost/");
    expect(await response1.text()).toBe("mocked-1");
    expect(fetchMock.pendingInterceptors().length).toBe(0);

    await runtime.resetFetchMock();
    fetchMock.activate();
    expect(fetchMock.pendingInterceptors().length).toBe(0);

    fetchMock.disableNetConnect();
    fetchMock
      .get("http://example.com")
      .intercept({ path: "/data", method: "GET" })
      .reply(200, "mocked-2");

    const response2 = await SELF.fetch("http://localhost/");
    expect(await response2.text()).toBe("mocked-2");
    expect(fetchMock.pendingInterceptors().length).toBe(0);
  });

  test("fetchMock remains usable after teardown followed by setup", async () => {
    setWorkersRuntimeOptionsForTesting({
      miniflare: {
        modules: true,
        script: `
          export default {
            async fetch() {
              const response = await fetch("http://example.com/data");
              return new Response(await response.text());
            }
          };
        `
      }
    });

    await runtime.setup();
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock
      .get("http://example.com")
      .intercept({ path: "/data", method: "GET" })
      .reply(200, "first-run");

    const first = await SELF.fetch("http://localhost/");
    expect(await first.text()).toBe("first-run");

    await runtime.teardown();
    await runtime.setup();

    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock
      .get("http://example.com")
      .intercept({ path: "/data", method: "GET" })
      .reply(200, "second-run");

    const second = await SELF.fetch("http://localhost/");
    expect(await second.text()).toBe("second-run");
  });

  test("runInDurableObject executes RPC-callable instance methods", async () => {
    setWorkersRuntimeOptionsForTesting({
      miniflare: {
        modules: true,
        script: `
          import { DurableObject } from "cloudflare:workers";

          export class Counter extends DurableObject {
            async incrementAndGet() {
              const current = Number((await this.ctx.storage.get("count")) ?? 0) + 1;
              await this.ctx.storage.put("count", current);
              return current;
            }
          }

          export default {
            fetch(_request, env) {
              const id = env.COUNTER.idFromName("singleton");
              return new Response(id.toString());
            }
          };
        `,
        durableObjects: {
          COUNTER: "Counter"
        }
      }
    });

    await runtime.setup();

    const namespace = workersEnv.COUNTER as unknown as DurableObjectNamespaceLike;
    const id = namespace.idFromName("singleton");
    const stub = namespace.get(id);

    const result1 = await runInDurableObject<{ incrementAndGet: () => Promise<number> }, number>(
      stub,
      async (instance) => instance.incrementAndGet()
    );
    const result2 = await runInDurableObject<{ incrementAndGet: () => Promise<number> }, number>(
      stub,
      async (instance) => instance.incrementAndGet()
    );

    expect(result1).toBe(1);
    expect(result2).toBe(2);
  });

  test("runInDurableObject throws actionable error on state access", async () => {
    setWorkersRuntimeOptionsForTesting({
      miniflare: {
        modules: true,
        script: `
          import { DurableObject } from "cloudflare:workers";

          export class Counter extends DurableObject {
            async ping() {
              return "pong";
            }
          }

          export default {
            fetch(_request, env) {
              const id = env.COUNTER.idFromName("singleton");
              return new Response(id.toString());
            }
          };
        `,
        durableObjects: {
          COUNTER: "Counter"
        }
      }
    });

    await runtime.setup();

    const namespace = workersEnv.COUNTER as unknown as DurableObjectNamespaceLike;
    const stub = namespace.get(namespace.idFromName("singleton"));
    const seenStateKinds: string[] = [];

    await expect(
      runInDurableObject(stub as DurableObjectStubLike, async (_instance, state) => {
        const kind = (state as DurableObjectStatePlaceholder).__kind;
        seenStateKinds.push(kind);
        const storage = (state as unknown as { storage: unknown }).storage;
        void storage;
        return "value";
      })
    ).rejects.toThrow("DurableObjectState access is not yet available in Rstest mode");
    expect(seenStateKinds).toEqual(["DurableObjectStatePlaceholder"]);
  });

  test("runInDurableObject preserves callback return values and errors", async () => {
    setWorkersRuntimeOptionsForTesting({
      miniflare: {
        modules: true,
        script: `
          import { DurableObject } from "cloudflare:workers";

          export class Counter extends DurableObject {
            async ping() {
              return "pong";
            }
          }

          export default {
            fetch(_request, env) {
              const id = env.COUNTER.idFromName("singleton");
              return new Response(id.toString());
            }
          };
        `,
        durableObjects: {
          COUNTER: "Counter"
        }
      }
    });

    await runtime.setup();

    const namespace = workersEnv.COUNTER as unknown as DurableObjectNamespaceLike;
    const stub = namespace.get(namespace.idFromName("singleton"));

    const response = await runInDurableObject<{ ping: () => Promise<string> }, Response>(
      stub,
      async () => new Response("from-callback")
    );
    expect(response).toBeInstanceOf(Response);
    expect(await response.text()).toBe("from-callback");

    await expect(
      runInDurableObject(stub, async () => {
        throw new Error("callback-failure");
      })
    ).rejects.toThrow("callback-failure");
  });

  test("runDurableObjectAlarm rejects with unsupported guidance for real stubs", async () => {
    setWorkersRuntimeOptionsForTesting({
      miniflare: {
        modules: true,
        script: `
          import { DurableObject } from "cloudflare:workers";

          export class Counter extends DurableObject {
            async alarm() {}
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
              const stub = env.COUNTER.get(id);
              await stub.fetch("http://localhost/set");
              return new Response("done");
            }
          };
        `,
        durableObjects: {
          COUNTER: "Counter"
        }
      }
    });

    await runtime.setup();
    await SELF.fetch("http://localhost/");

    const namespace = workersEnv.COUNTER as unknown as DurableObjectNamespaceLike;
    const stub = namespace.get(namespace.idFromName("singleton"));

    await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
      "runDurableObjectAlarm() is not yet available in Rstest mode."
    );
  });

  test("SELF.scheduled dispatches scheduled handler and persists effects", async () => {
    setWorkersRuntimeOptionsForTesting({
      miniflare: {
        modules: true,
        script: `
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
        kvNamespaces: ["CLOCK"]
      }
    });

    await runtime.setup();

    const before = await SELF.fetch("http://localhost/");
    expect(await before.text()).toBe("none");

    await SELF.scheduled({
      cron: "*/5 * * * *",
      scheduledTime: 1_700_000_000_000
    });

    let afterText = "none";
    for (let attempt = 0; attempt < 10; attempt++) {
      const after = await SELF.fetch("http://localhost/");
      afterText = await after.text();
      if (afterText !== "none") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(afterText).toBe("*/5 * * * *|1700000000000");
  });

  test("SELF.scheduled applies default cron/time when options are omitted", async () => {
    setWorkersRuntimeOptionsForTesting({
      miniflare: {
        modules: true,
        script: `
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
        kvNamespaces: ["CLOCK"]
      }
    });

    await runtime.setup();
    await SELF.scheduled();

    let afterText = "none";
    for (let attempt = 0; attempt < 10; attempt++) {
      const after = await SELF.fetch("http://localhost/");
      afterText = await after.text();
      if (afterText !== "none") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(afterText).not.toBe("none");
    const parsed = JSON.parse(afterText) as { cron: string; scheduledTime: number };
    expect(parsed.cron).toBe("");
    expect(Number.isFinite(parsed.scheduledTime)).toBe(true);
    expect(parsed.scheduledTime).toBeGreaterThan(0);
  });
});
