import type { MockAgent } from "undici";
import { applyD1Migrations } from "./d1";
import {
  createExecutionContext,
  createMessageBatch,
  createPagesEventContext,
  createScheduledController,
  getQueueResult,
  waitOnExecutionContext
} from "./events";
import { getWorkersRuntimeState } from "../runtime/state";

function runtime() {
  return getWorkersRuntimeState();
}

export const env: Record<string, unknown> = new Proxy(
  {},
  {
    get(_target, property) {
      const bindings = runtime().getEnvSync();
      return bindings[property as string];
    },
    ownKeys() {
      return Reflect.ownKeys(runtime().getEnvSync());
    },
    getOwnPropertyDescriptor(_target, property) {
      const bindings = runtime().getEnvSync();
      const descriptor = Object.getOwnPropertyDescriptor(bindings, property);
      if (descriptor) {
        return descriptor;
      }
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: undefined
      };
    }
  }
);

type SelfFetchInit = RequestInit;

export const SELF = {
  fetch(input: RequestInfo | URL, init?: SelfFetchInit): Promise<Response> {
    return runtime().dispatchFetch(input, init);
  },
  scheduled(options?: { scheduledTime?: number; cron?: string }): Promise<void> {
    return runtime().dispatchScheduled(options);
  }
};

export const fetchMock = new Proxy(
  {},
  {
    get(_target, property) {
      const mockAgent = runtime().getFetchMock() as unknown as Record<string, unknown>;
      const value = mockAgent[property as string];
      if (typeof value === "function") {
        return value.bind(mockAgent);
      }
      return value;
    }
  }
) as MockAgent;

export async function runInDurableObject<_ObjectType, _ReturnType>(
  _stub: unknown,
  _callback: (_instance: _ObjectType, _state: unknown) => _ReturnType | Promise<_ReturnType>
): Promise<_ReturnType> {
  throw new Error(
    "runInDurableObject() is not yet available in Rstest mode. " +
      "Use Durable Object public APIs through `SELF.fetch()` integration paths."
  );
}

export async function runDurableObjectAlarm(_stub: unknown): Promise<boolean> {
  throw new Error(
    "runDurableObjectAlarm() is not yet available in Rstest mode."
  );
}

export async function listDurableObjectIds(_namespace: unknown): Promise<unknown[]> {
  return runtime().listDurableObjectIds(_namespace);
}

export async function introspectWorkflowInstance(
  _workflow: unknown,
  _instanceId: string
): Promise<never> {
  throw new Error(
    "Workflow introspection helpers are not yet available in Rstest mode."
  );
}

export async function introspectWorkflow(_workflow: unknown): Promise<never> {
  throw new Error(
    "Workflow introspection helpers are not yet available in Rstest mode."
  );
}

export {
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
  createScheduledController,
  createMessageBatch,
  getQueueResult,
  createPagesEventContext
};
