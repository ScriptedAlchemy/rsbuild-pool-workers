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

function isDurableObjectIdLike(value: unknown): value is DurableObjectIdLike {
  if (
    typeof value !== "object" ||
    value === null ||
    !("toString" in value) ||
    typeof (value as { toString?: unknown }).toString !== "function"
  ) {
    return false;
  }

  try {
    const rendered = String((value as { toString: () => string }).toString());
    return rendered !== "[object Object]" && rendered.length > 0;
  } catch {
    return false;
  }
}

export interface DurableObjectIdLike {
  toString(): string;
}

export interface DurableObjectStubLike {
  id: DurableObjectIdLike;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  [method: string]: unknown;
}

export interface DurableObjectNamespaceLike {
  newUniqueId(options?: { jurisdiction?: string }): DurableObjectIdLike;
  idFromName(name: string): DurableObjectIdLike;
  idFromString(id: string): DurableObjectIdLike;
  get(
    id: DurableObjectIdLike,
    options?: {
      locationHint?: string;
      jurisdiction?: string;
    }
  ): DurableObjectStubLike;
}

export interface DurableObjectStatePlaceholder {
  readonly __kind: "DurableObjectStatePlaceholder";
}

function isDurableObjectStub(value: unknown): value is DurableObjectStubLike {
  const id = (value as { id?: unknown } | null)?.id;
  const constructorName =
    (value as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  return (
    typeof value === "object" &&
    value !== null &&
    (constructorName === "DurableObject" || constructorName === "WorkerRpc") &&
    "fetch" in value &&
    typeof (value as { fetch?: unknown }).fetch === "function" &&
    isDurableObjectIdLike(id)
  );
}

function isDurableObjectNamespaceLike(value: unknown): value is DurableObjectNamespaceLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "newUniqueId" in value &&
    typeof (value as { newUniqueId?: unknown }).newUniqueId === "function" &&
    "idFromName" in value &&
    typeof (value as { idFromName?: unknown }).idFromName === "function" &&
    "idFromString" in value &&
    typeof (value as { idFromString?: unknown }).idFromString === "function" &&
    "get" in value &&
    typeof (value as { get?: unknown }).get === "function"
  );
}

function assertDurableObjectStubFromSameWorker(stub: DurableObjectStubLike): void {
  let bindings: Record<string, unknown>;
  try {
    bindings = runtime().getEnvSync();
  } catch {
    // If runtime hasn't been initialized yet, defer strict same-worker checks.
    return;
  }

  const idString = stub.id.toString();
  const namespaces = Object.values(bindings).filter(isDurableObjectNamespaceLike);
  if (namespaces.length === 0) {
    throw new Error(
      "Durable Object test helpers can only be used with stubs pointing to objects defined within the same worker."
    );
  }

  for (const namespace of namespaces) {
    try {
      namespace.idFromString(idString);
      return;
    } catch {
      // Try next namespace
    }
  }

  throw new Error(
    "Durable Object test helpers can only be used with stubs pointing to objects defined within the same worker."
  );
}

export const env: Readonly<Record<string, unknown>> = new Proxy(
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
      return descriptor;
    },
    set() {
      throw new TypeError("Cannot assign to read only property on cloudflare:test env.");
    },
    defineProperty() {
      throw new TypeError("Cannot redefine properties on cloudflare:test env.");
    },
    deleteProperty() {
      throw new TypeError("Cannot delete properties from cloudflare:test env.");
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
  stub: DurableObjectStubLike,
  callback: (
    _instance: _ObjectType,
    _state: DurableObjectStatePlaceholder
  ) => _ReturnType | Promise<_ReturnType>
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
  assertDurableObjectStubFromSameWorker(stub);

  // We can execute RPC-callable instance methods from the same isolate in Rstest,
  // but do not yet have access to the underlying DurableObjectState object.
  // Provide a throw-on-use placeholder so callbacks that only need `instance`
  // can run today, while stateful callbacks fail with actionable guidance.
  const statePlaceholder = new Proxy<DurableObjectStatePlaceholder>(
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

export async function runDurableObjectAlarm(stub: DurableObjectStubLike): Promise<boolean> {
  if (!isDurableObjectStub(stub)) {
    throw new TypeError(
      "Failed to execute 'runDurableObjectAlarm': parameter 1 is not of type 'DurableObjectStub'."
    );
  }

  return runInDurableObject<{ alarm?: () => unknown }, boolean>(
    stub,
    async (instance) => {
      if (typeof instance.alarm !== "function") {
        return false;
      }
      await instance.alarm();
      return true;
    }
  );
}

export async function listDurableObjectIds(
  namespace: DurableObjectNamespaceLike
): Promise<DurableObjectIdLike[]> {
  return runtime().listDurableObjectIds(namespace) as Promise<DurableObjectIdLike[]>;
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
