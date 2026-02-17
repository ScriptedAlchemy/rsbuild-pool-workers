declare module "cloudflare:test" {
  export const env: Readonly<Record<string, unknown>>;

  export const SELF: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    scheduled(options?: { scheduledTime?: number; cron?: string }): Promise<void>;
  };

  export const fetchMock: import("undici").MockAgent;

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
      ): Promise<Value | undefined> | Value | undefined;
      <Value = unknown>(
        keys: string[],
        options?: DurableObjectStorageGetOptionsLike
      ): Promise<Map<string, Value>> | Map<string, Value>;
    };
    put?: {
      <Value = unknown>(
        key: string,
        value: Value,
        options?: DurableObjectStoragePutOptionsLike
      ): Promise<void> | void;
      <Value = unknown>(
        entries: Record<string, Value>,
        options?: DurableObjectStoragePutOptionsLike
      ): Promise<void> | void;
    };
    list?: <Value = unknown>(
      options?: DurableObjectStorageListOptionsLike
    ) => Promise<Map<string, Value>> | Map<string, Value>;
    delete?: {
      (
        key: string,
        options?: DurableObjectStorageDeleteOptionsLike
      ): Promise<boolean> | boolean;
      (
        keys: string[],
        options?: DurableObjectStorageDeleteOptionsLike
      ): Promise<number> | number;
    };
    rollback?: () => void;
    getAlarm?: (
      options?: DurableObjectStorageGetAlarmOptionsLike
    ) => Promise<number | null> | number | null;
    setAlarm?: (
      scheduledTime: number | Date,
      options?: DurableObjectStorageSetAlarmOptionsLike
    ) => Promise<void> | void;
    deleteAlarm?: (
      options?: DurableObjectStorageSetAlarmOptionsLike
    ) => Promise<void> | void;
    [key: string]: unknown;
  }

  export interface DurableObjectStorageLike {
    get?: {
      <Value = unknown>(
        key: string,
        options?: DurableObjectStorageGetOptionsLike
      ): Promise<Value | undefined> | Value | undefined;
      <Value = unknown>(
        keys: string[],
        options?: DurableObjectStorageGetOptionsLike
      ): Promise<Map<string, Value>> | Map<string, Value>;
    };
    put?: {
      <Value = unknown>(
        key: string,
        value: Value,
        options?: DurableObjectStoragePutOptionsLike
      ): Promise<void> | void;
      <Value = unknown>(
        entries: Record<string, Value>,
        options?: DurableObjectStoragePutOptionsLike
      ): Promise<void> | void;
    };
    list?: <Value = unknown>(
      options?: DurableObjectStorageListOptionsLike
    ) => Promise<Map<string, Value>> | Map<string, Value>;
    delete?: {
      (
        key: string,
        options?: DurableObjectStorageDeleteOptionsLike
      ): Promise<boolean> | boolean;
      (
        keys: string[],
        options?: DurableObjectStorageDeleteOptionsLike
      ): Promise<number> | number;
    };
    deleteAll?: (options?: DurableObjectStorageDeleteOptionsLike) => Promise<void> | void;
    transaction?: <Result = unknown>(
      closure: (txn: DurableObjectTransactionLike) => Promise<Result> | Result
    ) => Promise<Result> | Result;
    transactionSync?: <Result = unknown>(
      closure: () => Result
    ) => Result;
    sync?: () => Promise<void> | void;
    getAlarm?: (
      options?: DurableObjectStorageGetAlarmOptionsLike
    ) => Promise<number | null> | number | null;
    setAlarm?: (
      scheduledTime: number | Date,
      options?: DurableObjectStorageSetAlarmOptionsLike
    ) => Promise<void> | void;
    deleteAlarm?: (
      options?: DurableObjectStorageSetAlarmOptionsLike
    ) => Promise<void> | void;
    sql?: unknown;
    kv?: unknown;
    getCurrentBookmark?: () => Promise<string> | string;
    getBookmarkForTime?: (timestamp: number | Date) => Promise<string> | string;
    onNextSessionRestoreBookmark?: (bookmark: string) => Promise<string> | string;
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

  export interface D1Migration {
    name: string;
    queries: string[];
  }

  export interface D1PreparedStatement {
    bind: (...args: unknown[]) => D1PreparedStatement;
    run: () => Promise<unknown>;
    first?: <T = unknown>() => Promise<T | null>;
    all?: <T = unknown>() => Promise<{ results: T[] }>;
  }

  export interface D1DatabaseLike {
    prepare: (sql: string) => D1PreparedStatement;
  }

  export function applyD1Migrations(
    db: D1DatabaseLike,
    migrations: D1Migration[],
    migrationsTableName?: string
  ): Promise<void>;

  export interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }

  export function createExecutionContext(): ExecutionContext;
  export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;

  export interface ScheduledController {
    readonly scheduledTime: number;
    readonly cron: string;
    noRetry(): void;
  }

  export function createScheduledController(options?: {
    scheduledTime?: number;
    cron?: string;
  }): ScheduledController;

  export interface QueueMessage<Body = unknown> {
    readonly id: string;
    readonly timestamp: Date;
    readonly body: Body;
    readonly attempts: number;
    retry(): void;
    ack(): void;
  }

  export interface QueueController<Body = unknown> {
    readonly queue: string;
    readonly messages: QueueMessage<Body>[];
    retryAll(): void;
    ackAll(): void;
  }

  export interface QueueResult {
    readonly outcome: "ok";
    readonly retryBatch: { retry: boolean };
    readonly ackAll: boolean;
    readonly retryMessages: Array<{ msgId: string }>;
    readonly explicitAcks: string[];
  }

  export function createMessageBatch<Body = unknown>(
    queueName: string,
    messages: Array<{ id: string; timestamp: number | Date; body: Body; attempts: number }>
  ): QueueController<Body>;

  export function getQueueResult(
    batch: QueueController<unknown>,
    ctx: ExecutionContext
  ): Promise<QueueResult>;

  export interface PagesEventContext<T extends Record<string, unknown> = Record<string, unknown>> {
    request: Request;
    functionPath: string;
    next: (request?: Request) => Promise<Response>;
    params: Record<string, string | string[]>;
    data: T;
    env: Record<string, unknown>;
    waitUntil: (promise: Promise<unknown>) => void;
    passThroughOnException: () => void;
  }

  export function createPagesEventContext<T extends Record<string, unknown>>(init: {
    request: Request;
    functionPath?: string;
    next?: (request: Request) => Promise<Response> | Response;
    params?: Record<string, string | string[]>;
    data?: T;
    env?: Record<string, unknown>;
  }): PagesEventContext<T>;

  export function runInDurableObject<_ObjectType, _ReturnType>(
    stub: DurableObjectStubLike,
    callback: (
      _instance: _ObjectType,
      _state: DurableObjectStateLike | DurableObjectStatePlaceholder
    ) => _ReturnType | Promise<_ReturnType>
  ): Promise<_ReturnType>;
  export function runDurableObjectAlarm(stub: DurableObjectStubLike): Promise<boolean>;
  export function listDurableObjectIds(
    namespace: DurableObjectNamespaceLike
  ): Promise<DurableObjectIdLike[]>;
  export function introspectWorkflowInstance(
    workflow: WorkflowLike,
    instanceId: string
  ): Promise<never>;
  export function introspectWorkflow(workflow: WorkflowLike): Promise<never>;
}

declare module "cloudflare:test-internal" {
  export * from "cloudflare:test";
}
