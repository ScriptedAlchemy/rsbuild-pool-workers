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

const RUNTIME_KEY = Symbol.for("@cloudflare/rstest-pool-workers/runtime-state");

function withRuntimeBindings(
  bindings: Record<string, unknown>,
  run: () => Promise<void>
): Promise<void> {
  const holder = globalThis as Record<PropertyKey, unknown>;
  const previous = holder[RUNTIME_KEY];
  holder[RUNTIME_KEY] = {
    getEnvSync() {
      return bindings;
    }
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
  return {
    newUniqueId() {
      return { toString: () => acceptedId } as DurableObjectIdLike;
    },
    idFromName() {
      return { toString: () => acceptedId } as DurableObjectIdLike;
    },
    idFromString(id: string) {
      if (id !== acceptedId) {
        throw new Error("namespace mismatch");
      }
      return { toString: () => id } as DurableObjectIdLike;
    },
    get() {
      throw new Error("not implemented for this test");
    }
  };
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
        { fetch: async () => new Response("ok"), id: { toString: () => "id" } } as DurableObjectStubLike,
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
  });

  test("runDurableObjectAlarm validates argument types and returns false when unavailable", async () => {
    await expect(runDurableObjectAlarm({} as unknown as DurableObjectStubLike)).rejects.toThrow(
      "Failed to execute 'runDurableObjectAlarm': parameter 1 is not of type 'DurableObjectStub'."
    );

    await expect(
      runDurableObjectAlarm({
        fetch: async () => new Response("ok"),
        id: { toString: () => "id-1" }
      } as DurableObjectStubLike)
    ).resolves.toBe(false);
  });

  test("runInDurableObject rejects stubs outside same-worker namespaces when runtime bindings are available", async () => {
    await withRuntimeBindings(
      {
        COUNTER: createNamespaceWithAcceptedId("expected-id")
      },
      async () => {
        await expect(
          runInDurableObject(
            {
              fetch: async () => new Response("ok"),
              id: { toString: () => "different-id" }
            } as DurableObjectStubLike,
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
        await expect(
          runDurableObjectAlarm({
            fetch: async () => new Response("ok"),
            id: { toString: () => "shared-id" },
            async alarm() {
              alarmCalls += 1;
            }
          } as DurableObjectStubLike)
        ).resolves.toBe(true);
      }
    );

    expect(alarmCalls).toBe(1);
  });

  test("listDurableObjectIds validates namespace argument type", async () => {
    await expect(
      listDurableObjectIds({} as never)
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
});
