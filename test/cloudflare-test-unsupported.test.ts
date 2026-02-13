import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "@rstest/core";
import {
  type DurableObjectIdLike,
  type DurableObjectNamespaceLike,
  type DurableObjectStubLike,
  introspectWorkflow,
  introspectWorkflowInstance,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject
} from "../src/cloudflare-test/index";
import { WorkersRuntimeState } from "../src/runtime/state";

const RUNTIME_KEY = Symbol.for("@cloudflare/rstest-pool-workers/runtime-state");

function withRuntimeBindings(
  bindings: Record<string, unknown>,
  run: () => Promise<void>,
  runtimeOverrides: Record<string, unknown> = {}
): Promise<void> {
  const holder = globalThis as Record<PropertyKey, unknown>;
  const previous = holder[RUNTIME_KEY];
  holder[RUNTIME_KEY] = {
    getEnvSync() {
      return bindings;
    },
    ...runtimeOverrides
  };

  return run().finally(() => {
    if (previous === undefined) {
      delete holder[RUNTIME_KEY];
    } else {
      holder[RUNTIME_KEY] = previous;
    }
  });
}

function createNamespaceWithAcceptedId(acceptedId: string): DurableObjectNamespaceLike {
  class LoopbackDurableObjectNamespace {
    newUniqueId() {
      return { toString: () => acceptedId } as DurableObjectIdLike;
    }

    idFromName() {
      return { toString: () => acceptedId } as DurableObjectIdLike;
    }

    idFromString(id: string) {
      if (id !== acceptedId) {
        throw new Error("namespace mismatch");
      }
      return { toString: () => id } as DurableObjectIdLike;
    }

    get() {
      throw new Error("not implemented for this test");
    }
  }

  return new LoopbackDurableObjectNamespace() as DurableObjectNamespaceLike;
}

function createNamespaceAcceptingAnyId(): DurableObjectNamespaceLike {
  class LoopbackDurableObjectNamespace {
    newUniqueId() {
      return { toString: () => "generated-id" } as DurableObjectIdLike;
    }

    idFromName(name: string) {
      return { toString: () => name } as DurableObjectIdLike;
    }

    idFromString(id: string) {
      return { toString: () => id } as DurableObjectIdLike;
    }

    get() {
      throw new Error("not implemented for this test");
    }
  }

  return new LoopbackDurableObjectNamespace() as DurableObjectNamespaceLike;
}

function createDurableObjectStub(
  id: string,
  options: {
    fetch?: DurableObjectStubLike["fetch"];
    alarm?: (() => Promise<void> | void) | undefined;
  } = {}
): DurableObjectStubLike {
  class WorkerRpc {
    id: DurableObjectIdLike;

    constructor(stubId: DurableObjectIdLike) {
      this.id = stubId;
    }

    async fetch(): Promise<Response> {
      return new Response("ok");
    }
  }

  const stub = new WorkerRpc({ toString: () => id }) as DurableObjectStubLike & {
    alarm?: (() => Promise<void> | void) | undefined;
  };

  if (options.fetch) {
    stub.fetch = options.fetch;
  }
  if ("alarm" in options) {
    stub.alarm = options.alarm;
  }

  return stub;
}

describe("unsupported cloudflare:test APIs", () => {
  test("runInDurableObject validates argument types", async () => {
    await expect(
      runInDurableObject({} as unknown as DurableObjectStubLike, async () => "value")
    ).rejects.toThrow(
      "Failed to execute 'runInDurableObject': parameter 1 is not of type 'DurableObjectStub'."
    );

    await expect(
      runInDurableObject(
        createDurableObjectStub("id"),
        "not-a-function" as unknown as (_instance: unknown, _state: unknown) => unknown
      )
    ).rejects.toThrow(
      "Failed to execute 'runInDurableObject': parameter 2 is not of type 'function'."
    );

    await expect(
      runInDurableObject(
        { fetch: async () => new Response("ok"), id: {} } as unknown as DurableObjectStubLike,
        async () => "value"
      )
    ).rejects.toThrow(
      "Failed to execute 'runInDurableObject': parameter 1 is not of type 'DurableObjectStub'."
    );

    await expect(
      runInDurableObject(
        {
          fetch: async () => new Response("ok"),
          id: { toString: () => "id-plain-object" }
        } as unknown as DurableObjectStubLike,
        async () => "value"
      )
    ).rejects.toThrow(
      "Failed to execute 'runInDurableObject': parameter 1 is not of type 'DurableObjectStub'."
    );
  });

  test("runDurableObjectAlarm validates argument types and returns false when unavailable", async () => {
    await expect(runDurableObjectAlarm({} as unknown as DurableObjectStubLike)).rejects.toThrow(
      "Failed to execute 'runDurableObjectAlarm': parameter 1 is not of type 'DurableObjectStub'."
    );

    await expect(
      runDurableObjectAlarm(createDurableObjectStub("id-1"))
    ).resolves.toBe(false);

    await expect(
      runDurableObjectAlarm(
        {
          fetch: async () => new Response("ok"),
          id: { toString: () => "alarm-plain-object" }
        } as unknown as DurableObjectStubLike
      )
    ).rejects.toThrow(
      "Failed to execute 'runDurableObjectAlarm': parameter 1 is not of type 'DurableObjectStub'."
    );
  });

  test("runInDurableObject rejects stubs outside same-worker namespaces when runtime bindings are available", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("expected-id")
      },
      async () => {
        await expect(
          runInDurableObject(
            createDurableObjectStub("different-id"),
            async () => "value"
          )
        ).rejects.toThrow(
          "Durable Object test helpers can only be used with stubs pointing to objects defined within the same worker."
        );
      }
    );
  });

  test("runInDurableObject only accepts namespaces designated as same-isolate by runtime metadata", async () => {
    const localNamespace = createNamespaceWithAcceptedId("local-id");
    const remoteNamespace = createNamespaceWithAcceptedId("remote-id");

    await withRuntimeBindings(
      {
        LOCAL_COUNTER: localNamespace,
        REMOTE_COUNTER: remoteNamespace
      },
      async () => {
        await expect(
          runInDurableObject(
            createDurableObjectStub("remote-id"),
            async () => "value"
          )
        ).rejects.toThrow(
          "Durable Object test helpers can only be used with stubs pointing to objects defined within the same worker."
        );
      },
      {
        getSameIsolateDurableObjectNamespaces: () => [localNamespace]
      }
    );
  });

  test("runInDurableObject rejects stubs when runtime bindings contain no Durable Object namespaces", async () => {
    await withRuntimeBindings(
      {
        PLAIN_VALUE: 123
      },
      async () => {
        await expect(
          runInDurableObject(
            createDurableObjectStub("any-id"),
            async () => "value"
          )
        ).rejects.toThrow(
          "Durable Object test helpers can only be used with stubs pointing to objects defined within the same worker."
        );
      }
    );
  });

  test("runDurableObjectAlarm executes alarm method when stub belongs to same-worker namespace", async () => {
    let alarmCalls = 0;

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("shared-id")
      },
      async () => {
        const stubWithAlarm = createDurableObjectStub("shared-id") as DurableObjectStubLike & {
          alarm?: () => Promise<void>;
        };
        stubWithAlarm.alarm = async () => {
          alarmCalls += 1;
        };

        await expect(
          runDurableObjectAlarm(stubWithAlarm)
        ).resolves.toBe(true);
      }
    );

    expect(alarmCalls).toBe(1);
  });

  test("runDurableObjectAlarm returns false when same-worker stub has no alarm method", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("shared-id-no-alarm")
      },
      async () => {
        await expect(
          runDurableObjectAlarm(createDurableObjectStub("shared-id-no-alarm"))
        ).resolves.toBe(false);
      }
    );
  });

  test("runDurableObjectAlarm rejects stubs outside same-worker namespaces when runtime bindings are available", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("expected-id")
      },
      async () => {
        await expect(
          runDurableObjectAlarm(
            createDurableObjectStub("different-id", {
              async alarm() {}
            })
          )
        ).rejects.toThrow(
          "Durable Object test helpers can only be used with stubs pointing to objects defined within the same worker."
        );
      }
    );
  });

  test("listDurableObjectIds validates namespace argument type", async () => {
    await expect(
      listDurableObjectIds({} as never)
    ).rejects.toThrow(
      "Failed to execute 'listDurableObjectIds': parameter 1 is not of type 'DurableObjectNamespace'."
    );
  });

  test("listDurableObjectIds rejects namespace-like objects without DurableObjectNamespace constructor identity", async () => {
    await expect(
      listDurableObjectIds(
        {
          newUniqueId: () => ({ toString: () => "id-a" }),
          idFromName: () => ({ toString: () => "id-a" }),
          idFromString: (id: string) => ({ toString: () => id }),
          get: () => ({})
        } as unknown as DurableObjectNamespaceLike
      )
    ).rejects.toThrow(
      "Failed to execute 'listDurableObjectIds': parameter 1 is not of type 'DurableObjectNamespace'."
    );
  });

  test("workflow introspection APIs throw with explicit guidance", async () => {
    await expect(introspectWorkflow({})).rejects.toThrow(
      "Workflow introspection helpers are not yet available in Rstest mode"
    );
    await expect(introspectWorkflowInstance({}, "id-1")).rejects.toThrow(
      "Workflow introspection helpers are not yet available in Rstest mode"
    );
  });

  test("WorkersRuntimeState same-isolate namespace resolution excludes scriptName-scoped bindings", () => {
    const localNamespace = createNamespaceWithAcceptedId("local-id");
    const remoteNamespace = createNamespaceWithAcceptedId("remote-id");

    const state = new WorkersRuntimeState();
    (
      state as unknown as {
        envCache: Record<string, unknown>;
        resolvedOptions: { miniflare: Record<string, unknown> };
      }
    ).envCache = {
      LOCAL_COUNTER: localNamespace,
      REMOTE_COUNTER: remoteNamespace
    };
    (
      state as unknown as {
        resolvedOptions: { miniflare: Record<string, unknown> };
      }
    ).resolvedOptions = {
      miniflare: {
        durableObjects: {
          LOCAL_COUNTER: "Counter",
          REMOTE_COUNTER: {
            className: "Counter",
            scriptName: "remote-worker"
          }
        }
      }
    };

    expect(state.getSameIsolateDurableObjectNamespaces()).toEqual([localNamespace]);
  });

  test("WorkersRuntimeState listDurableObjectIds uses scriptName-scoped unique key when configured", async () => {
    const durablePersistPath = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-do-scriptname-"));
    const namespace = createNamespaceAcceptingAnyId();

    try {
      const remoteNamespacePath = path.join(durablePersistPath, "remote-worker-Counter");
      await fs.mkdir(remoteNamespacePath, { recursive: true });
      await fs.writeFile(path.join(remoteNamespacePath, "remote-id.sqlite"), "");

      const localNamespacePath = path.join(durablePersistPath, "worker-Counter");
      await fs.mkdir(localNamespacePath, { recursive: true });
      await fs.writeFile(path.join(localNamespacePath, "local-id.sqlite"), "");

      const state = new WorkersRuntimeState();
      (
        state as unknown as {
          setupReady: boolean;
          envCache: Record<string, unknown>;
          resolvedOptions: { miniflare: Record<string, unknown> };
          miniflare: { unsafeGetPersistPaths: () => Map<string, string> };
        }
      ).setupReady = true;
      (
        state as unknown as {
          envCache: Record<string, unknown>;
          resolvedOptions: { miniflare: Record<string, unknown> };
        }
      ).envCache = {
        REMOTE_COUNTER: namespace
      };
      (
        state as unknown as {
          resolvedOptions: { miniflare: Record<string, unknown> };
        }
      ).resolvedOptions = {
        miniflare: {
          name: "worker",
          durableObjects: {
            REMOTE_COUNTER: {
              className: "Counter",
              scriptName: "remote-worker"
            }
          }
        }
      };
      (
        state as unknown as {
          miniflare: { unsafeGetPersistPaths: () => Map<string, string> };
        }
      ).miniflare = {
        unsafeGetPersistPaths: () => new Map([["do", durablePersistPath]])
      };

      const ids = await state.listDurableObjectIds(namespace);
      expect(ids.map((id) => id.toString())).toEqual(["remote-id"]);
    } finally {
      await fs.rm(durablePersistPath, { recursive: true, force: true });
    }
  });

  test("WorkersRuntimeState listDurableObjectIds prefers unsafeUniqueKey when configured", async () => {
    const durablePersistPath = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-do-uniquekey-"));
    const namespace = createNamespaceAcceptingAnyId();

    try {
      const uniqueKeyPath = path.join(durablePersistPath, "custom-unique-key");
      await fs.mkdir(uniqueKeyPath, { recursive: true });
      await fs.writeFile(path.join(uniqueKeyPath, "custom-id.sqlite"), "");

      const scriptNamePath = path.join(durablePersistPath, "remote-worker-Counter");
      await fs.mkdir(scriptNamePath, { recursive: true });
      await fs.writeFile(path.join(scriptNamePath, "script-name-id.sqlite"), "");

      const state = new WorkersRuntimeState();
      (
        state as unknown as {
          setupReady: boolean;
          envCache: Record<string, unknown>;
          resolvedOptions: { miniflare: Record<string, unknown> };
          miniflare: { unsafeGetPersistPaths: () => Map<string, string> };
        }
      ).setupReady = true;
      (
        state as unknown as {
          envCache: Record<string, unknown>;
          resolvedOptions: { miniflare: Record<string, unknown> };
        }
      ).envCache = {
        REMOTE_COUNTER: namespace
      };
      (
        state as unknown as {
          resolvedOptions: { miniflare: Record<string, unknown> };
        }
      ).resolvedOptions = {
        miniflare: {
          name: "worker",
          durableObjects: {
            REMOTE_COUNTER: {
              className: "Counter",
              scriptName: "remote-worker",
              unsafeUniqueKey: "custom-unique-key"
            }
          }
        }
      };
      (
        state as unknown as {
          miniflare: { unsafeGetPersistPaths: () => Map<string, string> };
        }
      ).miniflare = {
        unsafeGetPersistPaths: () => new Map([["do", durablePersistPath]])
      };

      const ids = await state.listDurableObjectIds(namespace);
      expect(ids.map((id) => id.toString())).toEqual(["custom-id"]);
    } finally {
      await fs.rm(durablePersistPath, { recursive: true, force: true });
    }
  });
});
