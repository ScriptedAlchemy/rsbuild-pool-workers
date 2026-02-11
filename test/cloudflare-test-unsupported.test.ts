import { describe, expect, test } from "@rstest/core";
import {
  type DurableObjectStubLike,
  introspectWorkflow,
  introspectWorkflowInstance,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject
} from "../src/cloudflare-test/index";

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
  });

  test("runDurableObjectAlarm throws with explicit guidance", async () => {
    await expect(runDurableObjectAlarm({} as unknown as DurableObjectStubLike)).rejects.toThrow(
      "Failed to execute 'runDurableObjectAlarm': parameter 1 is not of type 'DurableObjectStub'."
    );

    await expect(
      runDurableObjectAlarm({ fetch: async () => new Response("ok"), id: {} })
    ).rejects.toThrow(
      "runDurableObjectAlarm() is not yet available in Rstest mode."
    );
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
