import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "@rstest/core";
import {
  SELF,
  env as workersEnv,
  fetchMock,
  listDurableObjectIds,
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
    const response = await runtime.dispatchFetch("http://localhost/create");
    const createdId = await response.text();

    const ids = await listDurableObjectIds(workersEnv.COUNTER);
    const idStrings = ids.map((id) =>
      typeof id === "object" && id !== null && "toString" in id
        ? String((id as { toString: () => string }).toString())
        : String(id)
    );
    expect(idStrings).toContain(createdId);

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

    const namespace = workersEnv.COUNTER as {
      idFromName: (name: string) => unknown;
      get: (id: unknown) => unknown;
    };
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

    const namespace = workersEnv.COUNTER as {
      idFromName: (name: string) => unknown;
      get: (id: unknown) => unknown;
    };
    const stub = namespace.get(namespace.idFromName("singleton"));
    const seenStateKinds: string[] = [];

    await expect(
      runInDurableObject(stub, async (_instance, state: unknown) => {
        const kind = (state as { __kind?: string }).__kind;
        seenStateKinds.push(String(kind));
        const storage = (state as { storage: unknown }).storage;
        void storage;
        return "value";
      })
    ).rejects.toThrow("DurableObjectState access is not yet available in Rstest mode");
    expect(seenStateKinds).toEqual(["DurableObjectStatePlaceholder"]);
  });
});
