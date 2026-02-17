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

export interface WebSocketRequestResponsePairLike {
  request: string;
  response: string;
}

export interface DurableObjectStorageGetOptionsLike {
  allowConcurrency?: boolean;
  noCache?: boolean;
}

export interface DurableObjectStoragePutOptionsLike {
  allowConcurrency?: boolean;
  allowUnconfirmed?: boolean;
  noCache?: boolean;
}

export interface DurableObjectStorageDeleteOptionsLike {
  allowConcurrency?: boolean;
  allowUnconfirmed?: boolean;
  noCache?: boolean;
}

export interface DurableObjectStorageGetAlarmOptionsLike {
  allowConcurrency?: boolean;
}

export interface DurableObjectStorageSetAlarmOptionsLike {
  allowConcurrency?: boolean;
  allowUnconfirmed?: boolean;
}

export interface DurableObjectStorageListOptionsLike {
  start?: string;
  startAfter?: string;
  end?: string;
  prefix?: string;
  reverse?: boolean;
  limit?: number;
  allowConcurrency?: boolean;
  noCache?: boolean;
}

export interface DurableObjectTransactionLike {
  get?: {
    <Value = unknown>(
      key: string,
      options?: DurableObjectStorageGetOptionsLike
    ): Promise<Value | undefined>;
    <Value = unknown>(
      keys: string[],
      options?: DurableObjectStorageGetOptionsLike
    ): Promise<Map<string, Value>>;
  };
  put?: {
    <Value = unknown>(
      key: string,
      value: Value,
      options?: DurableObjectStoragePutOptionsLike
    ): Promise<void>;
    <Value = unknown>(
      entries: Record<string, Value>,
      options?: DurableObjectStoragePutOptionsLike
    ): Promise<void>;
  };
  list?: <Value = unknown>(
    options?: DurableObjectStorageListOptionsLike
  ) => Promise<Map<string, Value>>;
  delete?: {
    (
      key: string,
      options?: DurableObjectStorageDeleteOptionsLike
    ): Promise<boolean>;
    (
      keys: string[],
      options?: DurableObjectStorageDeleteOptionsLike
    ): Promise<number>;
  };
  rollback?: () => void;
  getAlarm?: (
    options?: DurableObjectStorageGetAlarmOptionsLike
  ) => Promise<number | null>;
  setAlarm?: (
    scheduledTime: number | Date,
    options?: DurableObjectStorageSetAlarmOptionsLike
  ) => Promise<void>;
  deleteAlarm?: (
    options?: DurableObjectStorageSetAlarmOptionsLike
  ) => Promise<void>;
  [key: string]: unknown;
}

export interface DurableObjectStorageLike {
  get?: {
    <Value = unknown>(
      key: string,
      options?: DurableObjectStorageGetOptionsLike
    ): Promise<Value | undefined>;
    <Value = unknown>(
      keys: string[],
      options?: DurableObjectStorageGetOptionsLike
    ): Promise<Map<string, Value>>;
  };
  put?: {
    <Value = unknown>(
      key: string,
      value: Value,
      options?: DurableObjectStoragePutOptionsLike
    ): Promise<void>;
    <Value = unknown>(
      entries: Record<string, Value>,
      options?: DurableObjectStoragePutOptionsLike
    ): Promise<void>;
  };
  list?: <Value = unknown>(
    options?: DurableObjectStorageListOptionsLike
  ) => Promise<Map<string, Value>>;
  delete?: {
    (
      key: string,
      options?: DurableObjectStorageDeleteOptionsLike
    ): Promise<boolean>;
    (
      keys: string[],
      options?: DurableObjectStorageDeleteOptionsLike
    ): Promise<number>;
  };
  deleteAll?: (options?: DurableObjectStorageDeleteOptionsLike) => Promise<void>;
  transaction?: <Result = unknown>(
    closure: (txn: DurableObjectTransactionLike) => Promise<Result>
  ) => Promise<Result>;
  transactionSync?: <Result = unknown>(
    closure: () => Result
  ) => Result;
  sync?: () => Promise<void>;
  getAlarm?: (
    options?: DurableObjectStorageGetAlarmOptionsLike
  ) => Promise<number | null>;
  setAlarm?: (
    scheduledTime: number | Date,
    options?: DurableObjectStorageSetAlarmOptionsLike
  ) => Promise<void>;
  deleteAlarm?: (
    options?: DurableObjectStorageSetAlarmOptionsLike
  ) => Promise<void>;
  sql?: unknown;
  kv?: unknown;
  getCurrentBookmark?: () => Promise<string>;
  getBookmarkForTime?: (timestamp: number | Date) => Promise<string>;
  onNextSessionRestoreBookmark?: (bookmark: string) => Promise<string>;
  [key: string]: unknown;
}

export interface DurableObjectStateLike<Props = unknown> {
  storage: DurableObjectStorageLike;
  props?: Props;
  container?: unknown;
  blockConcurrencyWhile?: <Result = unknown>(
    closure: () => Promise<Result>
  ) => Promise<Result>;
  waitUntil?: (promise: Promise<unknown>) => void;
  id?: DurableObjectIdLike;
  acceptWebSocket?: (ws: WebSocket, tags?: string[]) => void;
  getWebSockets?: (tag?: string) => WebSocket[];
  setWebSocketAutoResponse?: (pair?: WebSocketRequestResponsePairLike) => void;
  getWebSocketAutoResponse?: () => WebSocketRequestResponsePairLike | null;
  getWebSocketAutoResponseTimestamp?: (ws: WebSocket) => Date | null;
  setHibernatableWebSocketEventTimeout?: (timeoutMs?: number) => void;
  getHibernatableWebSocketEventTimeout?: () => number | null;
  getTags?: (ws: WebSocket) => string[];
  abort?: (reason?: string) => void;
  [key: string]: unknown;
}

export interface WorkflowLike {
  [key: string]: unknown;
}

type DurableObjectStateFromStub<Stub extends DurableObjectStubLike> =
  [Extract<Stub extends { ctx?: infer CtxState } ? CtxState : never, DurableObjectStateLike>] extends [never]
    ? Extract<Stub extends { state?: infer StateValue } ? StateValue : never, DurableObjectStateLike>
    : Extract<Stub extends { ctx?: infer CtxState } ? CtxState : never, DurableObjectStateLike>;

function isDurableObjectStub(value: unknown): value is DurableObjectStubLike {
  const id = (value as { id?: unknown } | null)?.id;
  const constructorName =
    (value as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof constructorName === "string" &&
    constructorName !== "Object" &&
    "fetch" in value &&
    typeof (value as { fetch?: unknown }).fetch === "function" &&
    isDurableObjectIdLike(id)
  );
}

function isDurableObjectNamespaceLike(value: unknown): value is DurableObjectNamespaceLike {
  const constructorName =
    (value as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof constructorName === "string" &&
    constructorName !== "Object" &&
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

function isWorkflowLike(value: unknown): value is WorkflowLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReservedAlarmRpcError(error: unknown): boolean {
  const message = String((error as { message?: unknown } | undefined)?.message ?? error);
  const hasReservedPhrase =
    /reserved method/i.test(message) ||
    /\bmethod\b.*\breserved\b/i.test(message) ||
    /\breserved\b.*\bmethod\b/i.test(message);
  const hasRpcHint =
    /\brpc\b/i.test(message) ||
    /cannot be called/i.test(message);
  const hasNegatedReservedPhrase =
    /\bnot\s+reserved\b/i.test(message) ||
    /\bmethod\b.*\bnot\s+reserved\b/i.test(message) ||
    /\bnot\s+a?\s*reserved method/i.test(message) ||
    /\bisn['’]?\s*t\s+a?\s*reserved method/i.test(message);
  return (
    hasReservedPhrase &&
    hasRpcHint &&
    !hasNegatedReservedPhrase &&
    /\balarm\b/i.test(message)
  );
}

function isDurableObjectStateLike(value: unknown): value is DurableObjectStateLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  let storage: unknown;
  try {
    storage = (value as { storage?: unknown }).storage;
  } catch {
    return false;
  }

  return typeof storage === "object" && storage !== null;
}

function getDurableObjectStateFromStubKey(
  stub: DurableObjectStubLike,
  key: "ctx" | "state"
): DurableObjectStateLike | undefined {
  let candidate: unknown;
  try {
    candidate = (stub as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
  return isDurableObjectStateLike(candidate) ? candidate : undefined;
}

function getDurableObjectStateFromStub(stub: DurableObjectStubLike): DurableObjectStateLike | undefined {
  for (const key of ["ctx", "state"] as const) {
    const state = getDurableObjectStateFromStubKey(stub, key);
    if (state) {
      return state;
    }
  }
  return undefined;
}

function getDurableObjectAlarmStateFromStub(
  stub: DurableObjectStubLike,
  callbackState: DurableObjectStateLike | DurableObjectStatePlaceholder
): DurableObjectStateLike | undefined {
  const candidates: DurableObjectStateLike[] = [];
  const pushCandidate = (candidate: DurableObjectStateLike | undefined) => {
    if (!candidate) {
      return;
    }
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  if (isDurableObjectStateLike(callbackState)) {
    pushCandidate(callbackState);
  }
  pushCandidate(getDurableObjectStateFromStubKey(stub, "ctx"));
  pushCandidate(getDurableObjectStateFromStubKey(stub, "state"));

  for (const candidate of candidates) {
    if (typeof candidate.storage.getAlarm === "function") {
      return candidate;
    }
  }
  return candidates[0];
}

function assertDurableObjectStubFromSameWorker(stub: DurableObjectStubLike): void {
  let runtimeState:
    | (ReturnType<typeof runtime> & {
        getSameIsolateDurableObjectNamespaces?: () => unknown[];
      })
    | undefined;
  let bindings: Record<string, unknown>;
  try {
    runtimeState = runtime() as ReturnType<typeof runtime> & {
      getSameIsolateDurableObjectNamespaces?: () => unknown[];
    };
    bindings = runtimeState.getEnvSync();
  } catch {
    // If runtime hasn't been initialized yet, defer strict same-worker checks.
    return;
  }

  const idString = stub.id.toString();
  let namespaces: DurableObjectNamespaceLike[] | undefined;
  try {
    namespaces = runtimeState
      .getSameIsolateDurableObjectNamespaces?.()
      .filter(isDurableObjectNamespaceLike);
  } catch {
    namespaces = undefined;
  }
  if (!namespaces) {
    namespaces = Object.values(bindings).filter(isDurableObjectNamespaceLike);
  }
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

export async function runInDurableObject<
  _ObjectType,
  _ReturnType,
  Stub extends DurableObjectStubLike = DurableObjectStubLike
>(
  stub: Stub,
  callback: (
    _instance: _ObjectType,
    _state:
      DurableObjectStateFromStub<Stub> extends never
        ? DurableObjectStateLike | DurableObjectStatePlaceholder
        : DurableObjectStateFromStub<Stub>
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

  const runtimeState = getDurableObjectStateFromStub(stub);
  if (runtimeState) {
    return callback(stub as unknown as _ObjectType, runtimeState as never);
  }

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

  return callback(stub as unknown as _ObjectType, statePlaceholder as never);
}

export async function runDurableObjectAlarm(stub: DurableObjectStubLike): Promise<boolean> {
  if (!isDurableObjectStub(stub)) {
    throw new TypeError(
      "Failed to execute 'runDurableObjectAlarm': parameter 1 is not of type 'DurableObjectStub'."
    );
  }

  return runInDurableObject<{ alarm?: () => unknown }, boolean>(
    stub,
    async (instance, state) => {
      const throwReservedAlarmGuidance = () => {
        throw new Error(
          "runDurableObjectAlarm(): invoking alarm() on runtime Durable Object stubs is not yet supported in Rstest mode. " +
            "Use fetch-driven Durable Object hooks or same-isolate stubbed alarm methods for now."
        );
      };

      const resolveAlarmMethod = (): unknown => {
        try {
          return instance.alarm;
        } catch (error) {
          if (isReservedAlarmRpcError(error)) {
            throwReservedAlarmGuidance();
          }
          throw error;
        }
      };

      let hadScheduledAlarm = false;
      const alarmState = getDurableObjectAlarmStateFromStub(stub, state);
      if (alarmState) {
        const getAlarm = alarmState.storage.getAlarm;
        const deleteAlarm = alarmState.storage.deleteAlarm;
        if (typeof getAlarm === "function") {
          const scheduledAlarm = await getAlarm.call(alarmState.storage);
          if (scheduledAlarm === null || scheduledAlarm === undefined) {
            return false;
          }
          hadScheduledAlarm = true;
          if (typeof deleteAlarm === "function") {
            await deleteAlarm.call(alarmState.storage);
          }
        }
      }

      const alarmMethod = resolveAlarmMethod();
      if (typeof alarmMethod !== "function") {
        return hadScheduledAlarm;
      }

      try {
        await alarmMethod.call(instance);
      } catch (error) {
        if (isReservedAlarmRpcError(error)) {
          throwReservedAlarmGuidance();
        }
        throw error;
      }
      return true;
    }
  );
}

export async function listDurableObjectIds(
  namespace: DurableObjectNamespaceLike
): Promise<DurableObjectIdLike[]> {
  if (!isDurableObjectNamespaceLike(namespace)) {
    throw new TypeError(
      "Failed to execute 'listDurableObjectIds': parameter 1 is not of type 'DurableObjectNamespace'."
    );
  }

  return runtime().listDurableObjectIds(namespace) as Promise<DurableObjectIdLike[]>;
}

export async function introspectWorkflowInstance(
  workflow: WorkflowLike,
  instanceId: string
): Promise<never> {
  if (!isWorkflowLike(workflow)) {
    throw new TypeError(
      "Failed to execute 'introspectWorkflowInstance': parameter 1 is not of type 'Workflow'."
    );
  }
  if (typeof instanceId !== "string" || instanceId.length === 0) {
    throw new TypeError(
      "Failed to execute 'introspectWorkflowInstance': parameter 2 is not of type 'string'."
    );
  }

  throw new Error(
    "Workflow introspection helpers are not yet available in Rstest mode."
  );
}

export async function introspectWorkflow(workflow: WorkflowLike): Promise<never> {
  if (!isWorkflowLike(workflow)) {
    throw new TypeError(
      "Failed to execute 'introspectWorkflow': parameter 1 is not of type 'Workflow'."
    );
  }

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
