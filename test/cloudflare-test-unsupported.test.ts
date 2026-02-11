import { describe, expect, test } from "@rstest/core";
import {
  introspectWorkflow,
  introspectWorkflowInstance,
  runDurableObjectAlarm,
  runInDurableObject
} from "../src/cloudflare-test/index";

describe("unsupported cloudflare:test APIs", () => {
  test("runInDurableObject throws with explicit guidance", async () => {
    await expect(
      runInDurableObject({}, async () => "value")
    ).rejects.toThrow("runInDurableObject() is not yet available in Rstest mode");
  });

  test("runDurableObjectAlarm throws with explicit guidance", async () => {
    await expect(runDurableObjectAlarm({})).rejects.toThrow(
      "runDurableObjectAlarm() is not yet available in Rstest mode"
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
