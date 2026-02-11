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

function isDurableObjectStub(value: unknown): value is {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  id: { toString: () => string };
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof (value as { fetch?: unknown }).fetch === "function" &&
    "id" in value &&
    typeof (value as { id?: unknown }).id === "object"
  );
}

export const env: Record<string, unknown> = new Proxy(
  {},
  {
    get(_target, property) {
      const bindings = runtime().getEnvSync();
      return bindings[property as string];
    },
    has(_target, property) {
      const bindings = runtime().getEnvSync();
      return property in bindings;
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
  stub: unknown,
  callback: (_instance: _ObjectType, _state: unknown) => _ReturnType | Promise<_ReturnType>
): Promise<_ReturnType> {
  if (!isDurableObjectStub(stub)) {
    throw new TypeError(
      "Failed to execute 'runInDurableObject': parameter 1 is not of type 'DurableObjectStub'."
    );
  }
  if (typeof callback !== "function") {
    throw new TypeError(
      "Failed to execute 'runInDurableObject': parameter 2 is not of type 'function'."
    );
  }

  // We can execute RPC-callable instance methods from the same isolate in Rstest,
  // but do not yet have access to the underlying DurableObjectState object.
  // Provide a throw-on-use placeholder so callbacks that only need `instance`
  // can run today, while stateful callbacks fail with actionable guidance.
  const statePlaceholder = new Proxy(
    {
      __kind: "DurableObjectStatePlaceholder"
    },
    {
      get(target, property) {
        if (property === "__kind") {
          return target.__kind;
        }
        throw new Error(
          "runInDurableObject(): DurableObjectState access is not yet available in Rstest mode. " +
            "Use RPC-callable instance methods for now."
        );
      }
    }
  );

  return callback(stub as _ObjectType, statePlaceholder);
}

export async function runDurableObjectAlarm(stub: unknown): Promise<boolean> {
  if (!isDurableObjectStub(stub)) {
    throw new TypeError(
      "Failed to execute 'runDurableObjectAlarm': parameter 1 is not of type 'DurableObjectStub'."
    );
  }
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
