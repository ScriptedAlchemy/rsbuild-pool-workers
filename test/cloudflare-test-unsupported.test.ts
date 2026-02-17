import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "@rstest/core";
import {
  type DurableObjectIdLike,
  type DurableObjectNamespaceLike,
  type DurableObjectStateLike,
  type DurableObjectTransactionLike,
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

    get(): DurableObjectStubLike {
      throw new Error("not implemented for this test");
    }
  }

  return new LoopbackDurableObjectNamespace() as unknown as DurableObjectNamespaceLike;
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

    get(): DurableObjectStubLike {
      throw new Error("not implemented for this test");
    }
  }

  return new LoopbackDurableObjectNamespace() as unknown as DurableObjectNamespaceLike;
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

  const stub = new WorkerRpc({ toString: () => id }) as unknown as DurableObjectStubLike & {
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

function createDurableObjectState(options: {
  alarmValue?: number | null;
  onDeleteAlarm?: () => void;
  includeGetAlarm?: boolean;
  includeDeleteAlarm?: boolean;
} = {}): DurableObjectStateLike {
  let alarmValue = options.alarmValue ?? null;
  const storage: DurableObjectStateLike["storage"] = {};
  if (options.includeGetAlarm ?? true) {
    storage.getAlarm = async () => alarmValue;
  }
  if (options.includeDeleteAlarm ?? true) {
    storage.deleteAlarm = async () => {
      options.onDeleteAlarm?.();
      alarmValue = null;
    };
  }

  return {
    storage
  };
}

function createMockedRuntimeState(overrides: Record<string, unknown>): WorkersRuntimeState {
  const state = Object.create(WorkersRuntimeState.prototype) as WorkersRuntimeState &
    Record<string, unknown>;
  Object.assign(state, {
    setupReady: true,
    ...overrides
  });
  return state;
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

  test("runInDurableObject accepts class-based stubs with non-Object constructors", async () => {
    class CustomDurableStub {
      id: DurableObjectIdLike;

      constructor(id: DurableObjectIdLike) {
        this.id = id;
      }

      async fetch(): Promise<Response> {
        return new Response("ok");
      }
    }

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("custom-constructor-id")
      },
      async () => {
        const stub = new CustomDurableStub({
          toString: () => "custom-constructor-id"
        }) as unknown as DurableObjectStubLike;

        await expect(
          runInDurableObject(stub, async () => "value")
        ).resolves.toBe("value");
      }
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

  test("runInDurableObject falls back to env namespace discovery if same-isolate metadata helper throws", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("expected-id")
      },
      async () => {
        await expect(
          runInDurableObject(
            createDurableObjectStub("expected-id"),
            async () => "value"
          )
        ).resolves.toBe("value");
      },
      {
        getSameIsolateDurableObjectNamespaces: () => {
          throw new Error("metadata unavailable");
        }
      }
    );
  });

  test("runInDurableObject falls back to env namespace discovery if same-isolate metadata helper returns non-array value", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("expected-id")
      },
      async () => {
        await expect(
          runInDurableObject(
            createDurableObjectStub("expected-id"),
            async () => "value"
          )
        ).resolves.toBe("value");
      },
      {
        getSameIsolateDurableObjectNamespaces: () => ({ invalid: true }) as never
      }
    );
  });

  test("runInDurableObject still rejects mismatched stubs when metadata helper throws and fallback is used", async () => {
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
      },
      {
        getSameIsolateDurableObjectNamespaces: () => {
          throw new Error("metadata unavailable");
        }
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

  test("runInDurableObject uses stub-exposed DurableObjectState when available", async () => {
    const state = createDurableObjectState();

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("state-id")
      },
      async () => {
        const stub = createDurableObjectStub("state-id") as DurableObjectStubLike & {
          ctx?: DurableObjectStateLike;
        };
        stub.ctx = state;

        await expect(
          runInDurableObject(stub, async (_instance, receivedState) => receivedState)
        ).resolves.toBe(state);
      }
    );
  });

  test("runInDurableObject uses stub.state DurableObjectState when ctx is unavailable", async () => {
    const state = createDurableObjectState();

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("state-id-state-prop")
      },
      async () => {
        const stub = createDurableObjectStub(
          "state-id-state-prop"
        ) as DurableObjectStubLike & {
          state?: DurableObjectStateLike;
        };
        stub.state = state;

        await expect(
          runInDurableObject(stub, async (_instance, receivedState) => receivedState)
        ).resolves.toBe(state);
      }
    );
  });

  test("runInDurableObject tolerates throwing ctx getters when state fallback exists", async () => {
    const state = createDurableObjectState();

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("state-throwing-ctx-id")
      },
      async () => {
        const stub = createDurableObjectStub(
          "state-throwing-ctx-id"
        ) as DurableObjectStubLike & {
          state?: DurableObjectStateLike;
        };
        Object.defineProperty(stub, "ctx", {
          configurable: true,
          get() {
            throw new Error("ctx getter failed");
          }
        });
        stub.state = state;

        await expect(
          runInDurableObject(stub, async (_instance, receivedState) => receivedState)
        ).resolves.toBe(state);
      }
    );
  });

  test("runInDurableObject falls back to state placeholder when ctx getter throws and no state fallback exists", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("state-placeholder-throwing-ctx-id")
      },
      async () => {
        const stub = createDurableObjectStub(
          "state-placeholder-throwing-ctx-id"
        ) as DurableObjectStubLike;
        Object.defineProperty(stub, "ctx", {
          configurable: true,
          get() {
            throw new Error("ctx getter failed");
          }
        });

        await expect(
          runInDurableObject(stub, async (_instance, state) => state.__kind)
        ).resolves.toBe("DurableObjectStatePlaceholder");
      }
    );
  });

  test("runInDurableObject callbacks can use extended storage helpers when state is exposed", async () => {
    const callSequence: string[] = [];
    const put = (async (
      keyOrEntries: string | Record<string, unknown>,
      valueOrOptions?: unknown
    ) => {
      if (typeof keyOrEntries === "string") {
        callSequence.push(`put:${keyOrEntries}:${String(valueOrOptions)}`);
        return;
      }
      const entries = Object.entries(keyOrEntries);
      callSequence.push(`put-many:${entries.length}`);
    }) as NonNullable<DurableObjectStateLike["storage"]["put"]>;

    const get = (async <Value = unknown>(
      keyOrKeys: string | string[]
    ): Promise<Value | Map<string, Value> | undefined> => {
      if (typeof keyOrKeys === "string") {
        callSequence.push(`get:${keyOrKeys}`);
        return `value-for-${keyOrKeys}` as Value;
      }
      callSequence.push(`get-many:${keyOrKeys.length}`);
      return new Map<string, Value>(keyOrKeys.map((key) => [key, `value-for-${key}` as Value]));
    }) as NonNullable<DurableObjectStateLike["storage"]["get"]>;

    const deleteEntry = (async (
      keyOrKeys: string | string[]
    ): Promise<boolean | number> => {
      if (typeof keyOrKeys === "string") {
        callSequence.push(`delete:${keyOrKeys}`);
        return true;
      }
      callSequence.push(`delete-many:${keyOrKeys.length}`);
      return keyOrKeys.length;
    }) as NonNullable<DurableObjectStateLike["storage"]["delete"]>;

    const state: DurableObjectStateLike = {
      storage: {
        put,
        get,
        async list<Value = unknown>() {
          callSequence.push("list");
          return new Map<string, Value>([["entry", "listed-value" as Value]]);
        },
        delete: deleteEntry,
        async deleteAll() {
          callSequence.push("deleteAll");
        },
        async setAlarm(_scheduledTime: number | Date) {
          callSequence.push("setAlarm");
        },
        async getAlarm(options?: { allowConcurrency?: boolean }) {
          callSequence.push(`getAlarm:${String(options?.allowConcurrency ?? false)}`);
          return Date.now() + 1_000;
        },
        async deleteAlarm(options?: { allowConcurrency?: boolean }) {
          callSequence.push(`deleteAlarm:${String(options?.allowConcurrency ?? false)}`);
        },
        async transaction<Result = unknown>(
          closure: (txn: DurableObjectTransactionLike) => Promise<Result> | Result
        ): Promise<Result> {
          callSequence.push("transaction");
          const txnPut = (async (
            keyOrEntries: string | Record<string, unknown>,
            valueOrOptions?: unknown
          ) => {
            if (typeof keyOrEntries === "string") {
              callSequence.push(`txn.put:${keyOrEntries}:${String(valueOrOptions)}`);
              return;
            }
            callSequence.push(`txn.put-many:${Object.keys(keyOrEntries).length}`);
          }) as NonNullable<DurableObjectTransactionLike["put"]>;
          const txnGet = (async <Value = unknown>(
            keyOrKeys: string | string[]
          ): Promise<Value | Map<string, Value> | undefined> => {
            if (typeof keyOrKeys === "string") {
              callSequence.push(`txn.get:${keyOrKeys}`);
              return `txn-value-for-${keyOrKeys}` as Value;
            }
            callSequence.push(`txn.get-many:${keyOrKeys.length}`);
            return new Map<string, Value>(
              keyOrKeys.map((key) => [key, `txn-value-for-${key}` as Value])
            );
          }) as NonNullable<DurableObjectTransactionLike["get"]>;
          const txn: DurableObjectTransactionLike = {
            put: txnPut,
            get: txnGet,
            rollback() {
              callSequence.push("txn.rollback");
            }
          };
          return closure(txn);
        },
        transactionSync<Result = unknown>(closure: () => Result): Result {
          callSequence.push("transactionSync");
          return closure();
        },
        getCurrentBookmark() {
          callSequence.push("getCurrentBookmark");
          return "bookmark-1";
        },
        getBookmarkForTime(_timestamp: number | Date) {
          callSequence.push("getBookmarkForTime");
          return "bookmark-at-time";
        },
        onNextSessionRestoreBookmark(_bookmark: string) {
          callSequence.push("onNextSessionRestoreBookmark");
          return "bookmark-restored";
        }
      },
      async blockConcurrencyWhile(closure) {
        callSequence.push("blockConcurrencyWhile");
        return closure();
      }
    };

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("state-storage-methods-id")
      },
      async () => {
        const stub = createDurableObjectStub(
          "state-storage-methods-id"
        ) as DurableObjectStubLike & {
          ctx?: DurableObjectStateLike;
        };
        stub.ctx = state;

        await expect(
          runInDurableObject(stub, async (_instance, receivedState) => {
            if ("__kind" in receivedState) {
              throw new Error("expected exposed DurableObjectStateLike");
            }
            await receivedState.blockConcurrencyWhile?.(async () => {
              await receivedState.storage.put?.("alpha", "one");
              const loaded = await receivedState.storage.get?.<string>("alpha");
              const listed = await receivedState.storage.list?.<string>();
              await receivedState.storage.delete?.("alpha");
              await receivedState.storage.deleteAll?.();
              await receivedState.storage.setAlarm?.(Date.now() + 1_000);
              await receivedState.storage.getAlarm?.({ allowConcurrency: true });
              await receivedState.storage.deleteAlarm?.({ allowConcurrency: true });
              await receivedState.storage.transaction?.(async (txn) => {
                await txn.put?.("beta", 2);
                await txn.get?.("beta");
                txn.rollback?.();
                return "txn-result";
              });
              receivedState.storage.transactionSync?.(() => {
                callSequence.push("transactionSync.closure");
                return "sync-result";
              });
              await receivedState.storage.getCurrentBookmark?.();
              await receivedState.storage.getBookmarkForTime?.(Date.now());
              await receivedState.storage.onNextSessionRestoreBookmark?.("bookmark-1");

              return {
                loaded,
                listed: listed ? Array.from(listed.values()) : []
              };
            });

            return "ok";
          })
        ).resolves.toBe("ok");
      }
    );

    expect(callSequence).toEqual([
      "blockConcurrencyWhile",
      "put:alpha:one",
      "get:alpha",
      "list",
      "delete:alpha",
      "deleteAll",
      "setAlarm",
      "getAlarm:true",
      "deleteAlarm:true",
      "transaction",
      "txn.put:beta:2",
      "txn.get:beta",
      "txn.rollback",
      "transactionSync",
      "transactionSync.closure",
      "getCurrentBookmark",
      "getBookmarkForTime",
      "onNextSessionRestoreBookmark"
    ]);
  });

  test("runInDurableObject callbacks can access state id and waitUntil helpers when exposed", async () => {
    let waitUntilCalls = 0;
    let waitUntilSettled = false;

    const state: DurableObjectStateLike = {
      id: {
        toString: () => "state-id-helper-value"
      },
      storage: {},
      waitUntil(promise) {
        waitUntilCalls += 1;
        void promise.then(() => {
          waitUntilSettled = true;
        });
      }
    };

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("state-id-helper-value")
      },
      async () => {
        const stub = createDurableObjectStub(
          "state-id-helper-value"
        ) as DurableObjectStubLike & {
          state?: DurableObjectStateLike;
        };
        stub.state = state;

        await expect(
          runInDurableObject(stub, async (_instance, receivedState) => {
            if ("__kind" in receivedState) {
              throw new Error("expected exposed DurableObjectStateLike");
            }
            receivedState.waitUntil?.(Promise.resolve());
            return receivedState.id?.toString();
          })
        ).resolves.toBe("state-id-helper-value");
      }
    );

    await Promise.resolve();
    expect(waitUntilCalls).toBe(1);
    expect(waitUntilSettled).toBe(true);
  });

  test("runInDurableObject callbacks can read state props when exposed", async () => {
    const state: DurableObjectStateLike = {
      props: {
        featureFlag: true,
        tenant: "acme"
      },
      storage: {}
    };

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("state-props-helper-id")
      },
      async () => {
        const stub = createDurableObjectStub(
          "state-props-helper-id"
        ) as DurableObjectStubLike & {
          ctx?: DurableObjectStateLike;
        };
        stub.ctx = state;

        await expect(
          runInDurableObject(stub, async (_instance, receivedState) => {
            if ("__kind" in receivedState) {
              throw new Error("expected exposed DurableObjectStateLike");
            }
            return receivedState.props;
          })
        ).resolves.toEqual({
          featureFlag: true,
          tenant: "acme"
        });
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

  test("runDurableObjectAlarm falls back to env namespace discovery if same-isolate metadata helper throws", async () => {
    let alarmCalls = 0;

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("fallback-alarm-id")
      },
      async () => {
        const stubWithAlarm = createDurableObjectStub(
          "fallback-alarm-id"
        ) as DurableObjectStubLike & {
          alarm?: () => Promise<void>;
        };
        stubWithAlarm.alarm = async () => {
          alarmCalls += 1;
        };

        await expect(
          runDurableObjectAlarm(stubWithAlarm)
        ).resolves.toBe(true);
      },
      {
        getSameIsolateDurableObjectNamespaces: () => {
          throw new Error("metadata unavailable");
        }
      }
    );

    expect(alarmCalls).toBe(1);
  });

  test("runDurableObjectAlarm falls back when metadata helper returns non-array value", async () => {
    let alarmCalls = 0;

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("fallback-alarm-non-array-id")
      },
      async () => {
        const stubWithAlarm = createDurableObjectStub(
          "fallback-alarm-non-array-id"
        ) as DurableObjectStubLike & {
          alarm?: () => Promise<void>;
        };
        stubWithAlarm.alarm = async () => {
          alarmCalls += 1;
        };

        await expect(
          runDurableObjectAlarm(stubWithAlarm)
        ).resolves.toBe(true);
      },
      {
        getSameIsolateDurableObjectNamespaces: () => ({ invalid: true }) as never
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

  test("runDurableObjectAlarm rejects mismatched stubs when metadata helper throws and fallback is used", async () => {
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
      },
      {
        getSameIsolateDurableObjectNamespaces: () => {
          throw new Error("metadata unavailable");
        }
      }
    );
  });

  test("runDurableObjectAlarm returns false when state storage reports no scheduled alarm", async () => {
    let alarmCalls = 0;
    let deleteAlarmCalls = 0;
    const state = createDurableObjectState({
      alarmValue: null,
      onDeleteAlarm: () => {
        deleteAlarmCalls += 1;
      }
    });

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("scheduled-alarm-id")
      },
      async () => {
        const stubWithAlarm = createDurableObjectStub(
          "scheduled-alarm-id",
          {
            async alarm() {
              alarmCalls += 1;
            }
          }
        ) as DurableObjectStubLike & {
          ctx?: DurableObjectStateLike;
        };
        stubWithAlarm.ctx = state;

        await expect(runDurableObjectAlarm(stubWithAlarm)).resolves.toBe(false);
      }
    );

    expect(alarmCalls).toBe(0);
    expect(deleteAlarmCalls).toBe(0);
  });

  test("runDurableObjectAlarm returns false when state storage getAlarm resolves to undefined", async () => {
    let alarmCalls = 0;
    const state = createDurableObjectState({
      alarmValue: undefined as unknown as number | null
    });

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("scheduled-alarm-undefined")
      },
      async () => {
        const stubWithAlarm = createDurableObjectStub(
          "scheduled-alarm-undefined",
          {
            async alarm() {
              alarmCalls += 1;
            }
          }
        ) as DurableObjectStubLike & {
          ctx?: DurableObjectStateLike;
        };
        stubWithAlarm.ctx = state;

        await expect(runDurableObjectAlarm(stubWithAlarm)).resolves.toBe(false);
      }
    );

    expect(alarmCalls).toBe(0);
  });

  test("runDurableObjectAlarm clears alarm before invoking alarm handler when state is available", async () => {
    let alarmCalls = 0;
    let deleteAlarmCalls = 0;
    const state = createDurableObjectState({
      alarmValue: Date.now() + 60_000,
      onDeleteAlarm: () => {
        deleteAlarmCalls += 1;
      }
    });

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("scheduled-alarm-id-present")
      },
      async () => {
        const stubWithAlarm = createDurableObjectStub(
          "scheduled-alarm-id-present",
          {
            async alarm() {
              alarmCalls += 1;
            }
          }
        ) as DurableObjectStubLike & {
          ctx?: DurableObjectStateLike;
        };
        stubWithAlarm.ctx = state;

        await expect(runDurableObjectAlarm(stubWithAlarm)).resolves.toBe(true);
      }
    );

    expect(deleteAlarmCalls).toBe(1);
    expect(alarmCalls).toBe(1);
  });

  test("runDurableObjectAlarm returns true when scheduled alarm exists but no alarm method is present", async () => {
    let deleteAlarmCalls = 0;
    const state = createDurableObjectState({
      alarmValue: Date.now() + 5_000,
      onDeleteAlarm: () => {
        deleteAlarmCalls += 1;
      }
    });

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("scheduled-alarm-no-method")
      },
      async () => {
        const stub = createDurableObjectStub(
          "scheduled-alarm-no-method"
        ) as DurableObjectStubLike & {
          ctx?: DurableObjectStateLike;
        };
        stub.ctx = state;
        delete (stub as Record<string, unknown>).alarm;

        await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
      }
    );

    expect(deleteAlarmCalls).toBe(1);
  });

  test("runDurableObjectAlarm treats zero getAlarm values as scheduled alarms", async () => {
    let deleteAlarmCalls = 0;
    const state: DurableObjectStateLike = {
      storage: {
        async getAlarm() {
          return 0;
        },
        async deleteAlarm() {
          deleteAlarmCalls += 1;
        }
      }
    };

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("scheduled-alarm-zero-value")
      },
      async () => {
        const stub = createDurableObjectStub(
          "scheduled-alarm-zero-value"
        ) as DurableObjectStubLike & {
          ctx?: DurableObjectStateLike;
        };
        stub.ctx = state;
        delete (stub as Record<string, unknown>).alarm;

        await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
      }
    );

    expect(deleteAlarmCalls).toBe(1);
  });

  test("runDurableObjectAlarm still invokes alarm when deleteAlarm is unavailable", async () => {
    let alarmCalls = 0;
    const state = createDurableObjectState({
      alarmValue: Date.now() + 10_000,
      includeDeleteAlarm: false
    });

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("scheduled-alarm-no-delete")
      },
      async () => {
        const stubWithAlarm = createDurableObjectStub(
          "scheduled-alarm-no-delete",
          {
            async alarm() {
              alarmCalls += 1;
            }
          }
        ) as DurableObjectStubLike & {
          ctx?: DurableObjectStateLike;
        };
        stubWithAlarm.ctx = state;

        await expect(runDurableObjectAlarm(stubWithAlarm)).resolves.toBe(true);
      }
    );

    expect(alarmCalls).toBe(1);
  });

  test("runDurableObjectAlarm propagates deleteAlarm failures before invoking alarm", async () => {
    let alarmCalls = 0;
    const state: DurableObjectStateLike = {
      storage: {
        async getAlarm() {
          return Date.now() + 30_000;
        },
        async deleteAlarm() {
          throw new Error("deleteAlarm-failure");
        }
      }
    };

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("delete-alarm-failure-id")
      },
      async () => {
        const stubWithAlarm = createDurableObjectStub(
          "delete-alarm-failure-id",
          {
            async alarm() {
              alarmCalls += 1;
            }
          }
        ) as DurableObjectStubLike & {
          ctx?: DurableObjectStateLike;
        };
        stubWithAlarm.ctx = state;

        await expect(runDurableObjectAlarm(stubWithAlarm)).rejects.toThrow(
          "deleteAlarm-failure"
        );
      }
    );

    expect(alarmCalls).toBe(0);
  });

  test("runDurableObjectAlarm propagates getAlarm failures before evaluating alarm accessor", async () => {
    let alarmAccessorReads = 0;
    const state: DurableObjectStateLike = {
      storage: {
        async getAlarm() {
          throw new Error("getAlarm-failure");
        }
      }
    };

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("get-alarm-failure-id")
      },
      async () => {
        const stub = createDurableObjectStub("get-alarm-failure-id") as DurableObjectStubLike & {
          ctx?: DurableObjectStateLike;
        };
        stub.ctx = state;
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            alarmAccessorReads += 1;
            throw new Error("alarm-accessor-should-not-run");
          }
        });

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow("getAlarm-failure");
      }
    );

    expect(alarmAccessorReads).toBe(0);
  });

  test("runDurableObjectAlarm translates reserved alarm RPC errors into actionable guidance", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("reserved-alarm-id")
      },
      async () => {
        const stub = createDurableObjectStub("reserved-alarm-id");
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            throw new TypeError("'alarm' is a reserved method and cannot be called over RPC.");
          }
        });

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
          "runDurableObjectAlarm(): invoking alarm() on runtime Durable Object stubs is not yet supported in Rstest mode."
        );
      }
    );
  });

  test("runDurableObjectAlarm translates reserved alarm RPC errors without quoted alarm names", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("reserved-alarm-unquoted-id")
      },
      async () => {
        const stub = createDurableObjectStub("reserved-alarm-unquoted-id");
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            throw new TypeError("alarm is a reserved method and cannot be called over RPC.");
          }
        });

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
          "runDurableObjectAlarm(): invoking alarm() on runtime Durable Object stubs is not yet supported in Rstest mode."
        );
      }
    );
  });

  test("runDurableObjectAlarm translates reserved alarm RPC errors raised during alarm invocation", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("reserved-alarm-call-id")
      },
      async () => {
        const stub = createDurableObjectStub("reserved-alarm-call-id", {
          async alarm() {
            throw new TypeError("alarm is a reserved method and cannot be called over RPC.");
          }
        });

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
          "runDurableObjectAlarm(): invoking alarm() on runtime Durable Object stubs is not yet supported in Rstest mode."
        );
      }
    );
  });

  test("runDurableObjectAlarm translates reserved alarm RPC string throws from alarm accessor", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("reserved-alarm-string-throw-id")
      },
      async () => {
        const stub = createDurableObjectStub("reserved-alarm-string-throw-id");
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            throw "reserved method alarm cannot be called over rpc";
          }
        });

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
          "runDurableObjectAlarm(): invoking alarm() on runtime Durable Object stubs is not yet supported in Rstest mode."
        );
      }
    );
  });

  test("runDurableObjectAlarm clears scheduled alarms before surfacing reserved alarm guidance", async () => {
    let deleteAlarmCalls = 0;
    const state = createDurableObjectState({
      alarmValue: Date.now() + 1_000,
      onDeleteAlarm: () => {
        deleteAlarmCalls += 1;
      }
    });

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("reserved-alarm-after-clear-id")
      },
      async () => {
        const stub = createDurableObjectStub(
          "reserved-alarm-after-clear-id"
        ) as DurableObjectStubLike & {
          ctx?: DurableObjectStateLike;
        };
        stub.ctx = state;
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            throw new TypeError("'alarm' is a reserved method and cannot be called over RPC.");
          }
        });

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
          "runDurableObjectAlarm(): invoking alarm() on runtime Durable Object stubs is not yet supported in Rstest mode."
        );
      }
    );

    expect(deleteAlarmCalls).toBe(1);
  });

  test("runDurableObjectAlarm translates case-insensitive reserved ALARM RPC errors", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("reserved-alarm-uppercase-id")
      },
      async () => {
        const stub = createDurableObjectStub("reserved-alarm-uppercase-id");
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            throw new TypeError("Cannot perform RPC call: Reserved method ALARM cannot be called.");
          }
        });

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
          "runDurableObjectAlarm(): invoking alarm() on runtime Durable Object stubs is not yet supported in Rstest mode."
        );
      }
    );
  });

  test("runDurableObjectAlarm translates method-is-reserved phrasing for alarm errors", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("method-is-reserved-alarm-id")
      },
      async () => {
        const stub = createDurableObjectStub("method-is-reserved-alarm-id");
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            throw new TypeError("Method alarm is reserved and cannot be called over RPC.");
          }
        });

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
          "runDurableObjectAlarm(): invoking alarm() on runtime Durable Object stubs is not yet supported in Rstest mode."
        );
      }
    );
  });

  test("runDurableObjectAlarm preserves non-reserved alarm accessor errors", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("non-reserved-alarm-id")
      },
      async () => {
        const stub = createDurableObjectStub("non-reserved-alarm-id");
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            throw new Error("custom alarm accessor failure");
          }
        });

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
          "custom alarm accessor failure"
        );
      }
    );
  });

  test("runDurableObjectAlarm preserves reserved-method errors that are not for alarm", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("reserved-non-alarm-id")
      },
      async () => {
        const stub = createDurableObjectStub("reserved-non-alarm-id");
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            throw new TypeError("fetch is a reserved method and cannot be called over RPC.");
          }
        });

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
          "fetch is a reserved method and cannot be called over RPC."
        );
      }
    );
  });

  test("runDurableObjectAlarm preserves alarm errors explicitly stating alarm is not reserved", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("alarm-not-reserved-id")
      },
      async () => {
        const stub = createDurableObjectStub("alarm-not-reserved-id");
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            throw new TypeError("alarm is not a reserved method in this context");
          }
        });

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
          "alarm is not a reserved method in this context"
        );
      }
    );
  });

  test("runDurableObjectAlarm preserves method-is-not-reserved phrasing for alarm errors", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("method-is-not-reserved-alarm-id")
      },
      async () => {
        const stub = createDurableObjectStub("method-is-not-reserved-alarm-id");
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            throw new TypeError("Method alarm is not reserved in this context.");
          }
        });

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
          "Method alarm is not reserved in this context."
        );
      }
    );
  });

  test("runDurableObjectAlarm preserves reserved alarm errors without rpc hints", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("reserved-without-rpc-hint-id")
      },
      async () => {
        const stub = createDurableObjectStub("reserved-without-rpc-hint-id");
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            throw new TypeError("alarm is a reserved method in this application");
          }
        });

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
          "alarm is a reserved method in this application"
        );
      }
    );
  });

  test("runDurableObjectAlarm preserves alarm errors explicitly stating alarm isn't reserved", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("alarm-isnt-reserved-id")
      },
      async () => {
        const stub = createDurableObjectStub("alarm-isnt-reserved-id");
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            throw new TypeError("alarm isn't a reserved method in this context");
          }
        });

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
          "alarm isn't a reserved method in this context"
        );
      }
    );
  });

  test("runDurableObjectAlarm preserves alarm errors using unicode apostrophe negation wording", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("alarm-unicode-negation-id")
      },
      async () => {
        const stub = createDurableObjectStub("alarm-unicode-negation-id");
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            throw new TypeError("alarm isn’t a reserved method in this context");
          }
        });

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
          "alarm isn’t a reserved method in this context"
        );
      }
    );
  });

  test("runDurableObjectAlarm preserves non-reserved string throws from alarm accessor", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("non-reserved-string-throw-id")
      },
      async () => {
        const stub = createDurableObjectStub("non-reserved-string-throw-id");
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            throw "custom string alarm accessor failure";
          }
        });

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
          "custom string alarm accessor failure"
        );
      }
    );
  });

  test("runDurableObjectAlarm preserves non-reserved errors thrown by alarm invocation", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("non-reserved-invocation-error-id")
      },
      async () => {
        const stub = createDurableObjectStub(
          "non-reserved-invocation-error-id",
          {
            async alarm() {
              throw new Error("custom alarm invocation failure");
            }
          }
        );

        await expect(runDurableObjectAlarm(stub)).rejects.toThrow(
          "custom alarm invocation failure"
        );
      }
    );
  });

  test("runDurableObjectAlarm returns false when alarm accessor resolves to non-function without schedule metadata", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("non-function-alarm-no-schedule-id")
      },
      async () => {
        const stub = createDurableObjectStub(
          "non-function-alarm-no-schedule-id"
        ) as DurableObjectStubLike;
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            return 42;
          }
        });

        await expect(runDurableObjectAlarm(stub)).resolves.toBe(false);
      }
    );
  });

  test("runDurableObjectAlarm returns false before reading alarm accessor when state reports no scheduled alarm", async () => {
    const state = createDurableObjectState({
      alarmValue: null
    });

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("state-no-schedule-before-accessor")
      },
      async () => {
        const stub = createDurableObjectStub(
          "state-no-schedule-before-accessor"
        ) as DurableObjectStubLike & {
          ctx?: DurableObjectStateLike;
        };
        stub.ctx = state;
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            throw new TypeError("'alarm' is a reserved method and cannot be called over RPC.");
          }
        });

        await expect(runDurableObjectAlarm(stub)).resolves.toBe(false);
      }
    );
  });

  test("runDurableObjectAlarm returns false before reading non-reserved alarm accessors when no alarm is scheduled", async () => {
    let alarmAccessorReads = 0;
    const state = createDurableObjectState({
      alarmValue: null
    });

    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("state-no-schedule-non-reserved-accessor")
      },
      async () => {
        const stub = createDurableObjectStub(
          "state-no-schedule-non-reserved-accessor"
        ) as DurableObjectStubLike & {
          ctx?: DurableObjectStateLike;
        };
        stub.ctx = state;
        Object.defineProperty(stub, "alarm", {
          configurable: true,
          get() {
            alarmAccessorReads += 1;
            throw new Error("alarm-accessor-non-reserved-error");
          }
        });

        await expect(runDurableObjectAlarm(stub)).resolves.toBe(false);
      }
    );

    expect(alarmAccessorReads).toBe(0);
  });

  test("listDurableObjectIds validates namespace argument type", async () => {
    await withRuntimeBindings(
      {},
      async () => {
        await expect(
          listDurableObjectIds({} as never)
        ).rejects.toThrow(
          "Failed to execute 'listDurableObjectIds': parameter 1 is not of type 'DurableObjectNamespace'."
        );
      },
      {
        listDurableObjectIds: () => {
          throw new Error("runtime-should-not-be-called");
        }
      }
    );
  });

  test("listDurableObjectIds rejects namespace-like objects without DurableObjectNamespace constructor identity", async () => {
    await withRuntimeBindings(
      {},
      async () => {
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
      },
      {
        listDurableObjectIds: () => {
          throw new Error("runtime-should-not-be-called");
        }
      }
    );
  });

  test("listDurableObjectIds accepts class-based namespaces with non-Object constructors", async () => {
    class CustomNamespace {
      newUniqueId() {
        return { toString: () => "custom-id" } as DurableObjectIdLike;
      }

      idFromName(name: string) {
        return { toString: () => name } as DurableObjectIdLike;
      }

      idFromString(id: string) {
        return { toString: () => id } as DurableObjectIdLike;
      }

      get() {
        return createDurableObjectStub("custom-id");
      }
    }

    const namespace = new CustomNamespace() as unknown as DurableObjectNamespaceLike;
    await withRuntimeBindings(
      {},
      async () => {
        const ids = await listDurableObjectIds(namespace);
        expect(ids.map((id) => id.toString())).toEqual(["custom-id"]);
      },
      {
        listDurableObjectIds: () => [{ toString: () => "custom-id" }]
      }
    );
  });

  test("workflow introspection validates workflow parameter types", async () => {
    await expect(introspectWorkflow(null as unknown as Record<string, unknown>)).rejects.toThrow(
      "Failed to execute 'introspectWorkflow': parameter 1 is not of type 'Workflow'."
    );
    await expect(introspectWorkflow("workflow" as unknown as Record<string, unknown>)).rejects.toThrow(
      "Failed to execute 'introspectWorkflow': parameter 1 is not of type 'Workflow'."
    );
    await expect(introspectWorkflow([] as unknown as Record<string, unknown>)).rejects.toThrow(
      "Failed to execute 'introspectWorkflow': parameter 1 is not of type 'Workflow'."
    );
    await expect(
      introspectWorkflowInstance(null as unknown as Record<string, unknown>, "id-1")
    ).rejects.toThrow(
      "Failed to execute 'introspectWorkflowInstance': parameter 1 is not of type 'Workflow'."
    );
    await expect(
      introspectWorkflowInstance(
        "workflow" as unknown as Record<string, unknown>,
        "id-1"
      )
    ).rejects.toThrow(
      "Failed to execute 'introspectWorkflowInstance': parameter 1 is not of type 'Workflow'."
    );
    await expect(
      introspectWorkflowInstance(
        [] as unknown as Record<string, unknown>,
        "id-1"
      )
    ).rejects.toThrow(
      "Failed to execute 'introspectWorkflowInstance': parameter 1 is not of type 'Workflow'."
    );
  });

  test("workflow introspection validates instance id parameter type", async () => {
    await expect(introspectWorkflowInstance({}, "")).rejects.toThrow(
      "Failed to execute 'introspectWorkflowInstance': parameter 2 is not of type 'string'."
    );
    await expect(
      introspectWorkflowInstance({}, 123 as unknown as string)
    ).rejects.toThrow(
      "Failed to execute 'introspectWorkflowInstance': parameter 2 is not of type 'string'."
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

    const state = createMockedRuntimeState({
      envCache: {
        LOCAL_COUNTER: localNamespace,
        REMOTE_COUNTER: remoteNamespace
      },
      resolvedOptions: {
        miniflare: {
          durableObjects: {
            LOCAL_COUNTER: "Counter",
            REMOTE_COUNTER: {
              className: "Counter",
              scriptName: "remote-worker"
            }
          }
        }
      }
    });

    expect(state.getSameIsolateDurableObjectNamespaces()).toEqual([localNamespace]);
  });

  test("WorkersRuntimeState same-isolate namespace resolution throws for invalid designated bindings", () => {
    const state = createMockedRuntimeState({
      envCache: {
        LOCAL_COUNTER: 123
      },
      resolvedOptions: {
        miniflare: {
          durableObjects: {
            LOCAL_COUNTER: "Counter"
          }
        }
      }
    });

    expect(() => state.getSameIsolateDurableObjectNamespaces()).toThrow(
      "Expected LOCAL_COUNTER to be a DurableObjectNamespace binding"
    );
  });

  test("WorkersRuntimeState same-isolate namespace resolution ignores empty scriptName values", () => {
    const localNamespace = createNamespaceWithAcceptedId("local-id");

    const state = createMockedRuntimeState({
      envCache: {
        LOCAL_COUNTER: localNamespace
      },
      resolvedOptions: {
        miniflare: {
          durableObjects: {
            LOCAL_COUNTER: {
              className: "Counter",
              scriptName: "   "
            }
          }
        }
      }
    });

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

      const state = createMockedRuntimeState({
        envCache: {
          REMOTE_COUNTER: namespace
        },
        resolvedOptions: {
          miniflare: {
            name: "worker",
            durableObjects: {
              REMOTE_COUNTER: {
                className: "Counter",
                scriptName: "remote-worker"
              }
            }
          }
        },
        miniflare: {
          unsafeGetPersistPaths: () => new Map([["do", durablePersistPath]])
        }
      });

      const ids = (await state.listDurableObjectIds(namespace)) as DurableObjectIdLike[];
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

      const state = createMockedRuntimeState({
        envCache: {
          REMOTE_COUNTER: namespace
        },
        resolvedOptions: {
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
        },
        miniflare: {
          unsafeGetPersistPaths: () => new Map([["do", durablePersistPath]])
        }
      });

      const ids = (await state.listDurableObjectIds(namespace)) as DurableObjectIdLike[];
      expect(ids.map((id) => id.toString())).toEqual(["custom-id"]);
    } finally {
      await fs.rm(durablePersistPath, { recursive: true, force: true });
    }
  });

  test("WorkersRuntimeState listDurableObjectIds defaults script name to worker when absent", async () => {
    const durablePersistPath = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-do-defaultname-"));
    const namespace = createNamespaceAcceptingAnyId();

    try {
      const defaultNamePath = path.join(durablePersistPath, "worker-Counter");
      await fs.mkdir(defaultNamePath, { recursive: true });
      await fs.writeFile(path.join(defaultNamePath, "default-worker-id.sqlite"), "");

      const state = createMockedRuntimeState({
        envCache: {
          COUNTER: namespace
        },
        resolvedOptions: {
          miniflare: {
            durableObjects: {
              COUNTER: "Counter"
            }
          }
        },
        miniflare: {
          unsafeGetPersistPaths: () => new Map([["do", durablePersistPath]])
        }
      });

      const ids = (await state.listDurableObjectIds(namespace)) as DurableObjectIdLike[];
      expect(ids.map((id) => id.toString())).toEqual(["default-worker-id"]);
    } finally {
      await fs.rm(durablePersistPath, { recursive: true, force: true });
    }
  });

  test("WorkersRuntimeState listDurableObjectIds uses configured worker name when scriptName is absent", async () => {
    const durablePersistPath = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-do-workername-"));
    const namespace = createNamespaceAcceptingAnyId();

    try {
      const namedPath = path.join(durablePersistPath, "named-worker-Counter");
      await fs.mkdir(namedPath, { recursive: true });
      await fs.writeFile(path.join(namedPath, "named-worker-id.sqlite"), "");

      const state = createMockedRuntimeState({
        envCache: {
          COUNTER: namespace
        },
        resolvedOptions: {
          miniflare: {
            name: "named-worker",
            durableObjects: {
              COUNTER: {
                className: "Counter"
              }
            }
          }
        },
        miniflare: {
          unsafeGetPersistPaths: () => new Map([["do", durablePersistPath]])
        }
      });

      const ids = (await state.listDurableObjectIds(namespace)) as DurableObjectIdLike[];
      expect(ids.map((id) => id.toString())).toEqual(["named-worker-id"]);
    } finally {
      await fs.rm(durablePersistPath, { recursive: true, force: true });
    }
  });

  test("WorkersRuntimeState listDurableObjectIds throws when no designator exists for resolved binding", async () => {
    const durablePersistPath = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-do-missing-designator-"));
    const namespace = createNamespaceAcceptingAnyId();

    try {
      const state = createMockedRuntimeState({
        envCache: {
          COUNTER: namespace
        },
        resolvedOptions: {
          miniflare: {
            durableObjects: {
              OTHER_COUNTER: "Counter"
            }
          }
        },
        miniflare: {
          unsafeGetPersistPaths: () => new Map([["do", durablePersistPath]])
        }
      });

      await expect(state.listDurableObjectIds(namespace)).rejects.toThrow(
        'Could not resolve Durable Object designator for binding "COUNTER".'
      );
    } finally {
      await fs.rm(durablePersistPath, { recursive: true, force: true });
    }
  });

  test("WorkersRuntimeState listDurableObjectIds validates designator resolution before checking persist paths", async () => {
    const namespace = createNamespaceAcceptingAnyId();

    const state = createMockedRuntimeState({
      envCache: {
        COUNTER: namespace
      },
      resolvedOptions: {
        miniflare: {
          durableObjects: {
            OTHER_COUNTER: "Counter"
          }
        }
      },
      miniflare: {
        unsafeGetPersistPaths: () => new Map<string, string>()
      }
    });

    await expect(state.listDurableObjectIds(namespace)).rejects.toThrow(
      'Could not resolve Durable Object designator for binding "COUNTER".'
    );
  });

  test("WorkersRuntimeState listDurableObjectIds throws when className is not a string", async () => {
    const durablePersistPath = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-do-invalid-classname-"));
    const namespace = createNamespaceAcceptingAnyId();

    try {
      const state = createMockedRuntimeState({
        envCache: {
          COUNTER: namespace
        },
        resolvedOptions: {
          miniflare: {
            durableObjects: {
              COUNTER: {
                className: 123
              }
            }
          }
        },
        miniflare: {
          unsafeGetPersistPaths: () => new Map([["do", durablePersistPath]])
        }
      });

      await expect(state.listDurableObjectIds(namespace)).rejects.toThrow(
        'Could not infer Durable Object class for binding "COUNTER".'
      );
    } finally {
      await fs.rm(durablePersistPath, { recursive: true, force: true });
    }
  });

  test("WorkersRuntimeState listDurableObjectIds validates className before checking persist paths", async () => {
    const namespace = createNamespaceAcceptingAnyId();

    const state = createMockedRuntimeState({
      envCache: {
        COUNTER: namespace
      },
      resolvedOptions: {
        miniflare: {
          durableObjects: {
            COUNTER: {
              className: 123
            }
          }
        }
      },
      miniflare: {
        unsafeGetPersistPaths: () => new Map<string, string>()
      }
    });

    await expect(state.listDurableObjectIds(namespace)).rejects.toThrow(
      'Could not infer Durable Object class for binding "COUNTER".'
    );
  });

  test("WorkersRuntimeState listDurableObjectIds throws when className is an empty string", async () => {
    const durablePersistPath = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-do-empty-classname-"));
    const namespace = createNamespaceAcceptingAnyId();

    try {
      const state = createMockedRuntimeState({
        envCache: {
          COUNTER: namespace
        },
        resolvedOptions: {
          miniflare: {
            durableObjects: {
              COUNTER: {
                className: "   "
              }
            }
          }
        },
        miniflare: {
          unsafeGetPersistPaths: () => new Map([["do", durablePersistPath]])
        }
      });

      await expect(state.listDurableObjectIds(namespace)).rejects.toThrow(
        'Could not infer Durable Object class for binding "COUNTER".'
      );
    } finally {
      await fs.rm(durablePersistPath, { recursive: true, force: true });
    }
  });

  test("WorkersRuntimeState listDurableObjectIds throws when string designator className is empty", async () => {
    const durablePersistPath = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-do-empty-string-designator-"));
    const namespace = createNamespaceAcceptingAnyId();

    try {
      const state = createMockedRuntimeState({
        envCache: {
          COUNTER: namespace
        },
        resolvedOptions: {
          miniflare: {
            durableObjects: {
              COUNTER: "   "
            }
          }
        },
        miniflare: {
          unsafeGetPersistPaths: () => new Map([["do", durablePersistPath]])
        }
      });

      await expect(state.listDurableObjectIds(namespace)).rejects.toThrow(
        'Could not infer Durable Object class for binding "COUNTER".'
      );
    } finally {
      await fs.rm(durablePersistPath, { recursive: true, force: true });
    }
  });

  test("WorkersRuntimeState listDurableObjectIds ignores empty scriptName values and falls back to worker name", async () => {
    const durablePersistPath = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-do-empty-scriptname-"));
    const namespace = createNamespaceAcceptingAnyId();

    try {
      const fallbackPath = path.join(durablePersistPath, "named-worker-Counter");
      await fs.mkdir(fallbackPath, { recursive: true });
      await fs.writeFile(path.join(fallbackPath, "fallback-id.sqlite"), "");

      const state = createMockedRuntimeState({
        envCache: {
          COUNTER: namespace
        },
        resolvedOptions: {
          miniflare: {
            name: "named-worker",
            durableObjects: {
              COUNTER: {
                className: "Counter",
                scriptName: "   "
              }
            }
          }
        },
        miniflare: {
          unsafeGetPersistPaths: () => new Map([["do", durablePersistPath]])
        }
      });

      const ids = (await state.listDurableObjectIds(namespace)) as DurableObjectIdLike[];
      expect(ids.map((id) => id.toString())).toEqual(["fallback-id"]);
    } finally {
      await fs.rm(durablePersistPath, { recursive: true, force: true });
    }
  });

  test("WorkersRuntimeState listDurableObjectIds ignores empty unsafeUniqueKey values and falls back to scriptName key", async () => {
    const durablePersistPath = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-do-empty-unsafe-key-"));
    const namespace = createNamespaceAcceptingAnyId();

    try {
      const scriptNamePath = path.join(durablePersistPath, "remote-worker-Counter");
      await fs.mkdir(scriptNamePath, { recursive: true });
      await fs.writeFile(path.join(scriptNamePath, "script-key-id.sqlite"), "");

      const state = createMockedRuntimeState({
        envCache: {
          COUNTER: namespace
        },
        resolvedOptions: {
          miniflare: {
            name: "worker",
            durableObjects: {
              COUNTER: {
                className: "Counter",
                scriptName: "remote-worker",
                unsafeUniqueKey: "   "
              }
            }
          }
        },
        miniflare: {
          unsafeGetPersistPaths: () => new Map([["do", durablePersistPath]])
        }
      });

      const ids = (await state.listDurableObjectIds(namespace)) as DurableObjectIdLike[];
      expect(ids.map((id) => id.toString())).toEqual(["script-key-id"]);
    } finally {
      await fs.rm(durablePersistPath, { recursive: true, force: true });
    }
  });

});
