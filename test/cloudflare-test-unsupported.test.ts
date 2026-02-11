import { describe, expect, test } from "@rstest/core";
import {
  introspectWorkflow,
  introspectWorkflowInstance,
  runDurableObjectAlarm,
  runInDurableObject
} from "../src/cloudflare-test/index";

describe("unsupported cloudflare:test APIs", () => {
  test("runInDurableObject validates argument types", async () => {
    await expect(
      runInDurableObject({}, async () => "value")
    ).rejects.toThrow(
      "Failed to execute 'runInDurableObject': parameter 1 is not of type 'DurableObjectStub'."
    );

    await expect(
      runInDurableObject(
        { fetch: async () => new Response("ok"), id: { toString: () => "id" } },
        "not-a-function" as unknown as (_instance: unknown, _state: unknown) => unknown
      )
    ).rejects.toThrow(
      "Failed to execute 'runInDurableObject': parameter 2 is not of type 'function'."
    );
  });

  test("runDurableObjectAlarm throws with explicit guidance", async () => {
    await expect(runDurableObjectAlarm({})).rejects.toThrow(
      "Failed to execute 'runDurableObjectAlarm': parameter 1 is not of type 'DurableObjectStub'."
    );

    await expect(
      runDurableObjectAlarm({ fetch: async () => new Response("ok"), id: {} })
    ).rejects.toThrow(
      "runDurableObjectAlarm() is not yet available in Rstest mode."
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
