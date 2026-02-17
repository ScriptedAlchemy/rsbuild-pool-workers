import type {
  DurableObjectIdLike,
  DurableObjectNamespaceLike,
  DurableObjectStorageGetAlarmOptionsLike,
  DurableObjectStorageSetAlarmOptionsLike,
  DurableObjectTransactionLike,
  DurableObjectStateLike,
  DurableObjectStatePlaceholder,
  WebSocketRequestResponsePairLike,
  DurableObjectStubLike,
  ExecutionContext,
  SELF,
  env,
  PagesEventContext,
  QueueController,
  QueueResult,
  ScheduledController,
  createExecutionContext,
  createMessageBatch,
  createPagesEventContext,
  createScheduledController,
  getQueueResult,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext
} from "cloudflare:test";
import type {
  createExecutionContext as createExecutionContextInternal,
  env as envInternal,
  fetchMock as fetchMockInternal,
  listDurableObjectIds as listDurableObjectIdsInternal,
  runInDurableObject as runInDurableObjectInternal,
  SELF as SELFInternal
} from "cloudflare:test-internal";
import { WORKERS_RSBUILD_PLUGIN_NAME } from "../src/index";

type Assert<T extends true> = T;
type IsAssignable<T, U> = [T] extends [U] ? true : false;

type CreatedExecutionContext = ReturnType<typeof createExecutionContext>;
type CreatedExecutionContextInternal = ReturnType<typeof createExecutionContextInternal>;
type CreatedScheduledController = ReturnType<typeof createScheduledController>;
type CreatedMessageBatch = ReturnType<typeof createMessageBatch<{ value: number }>>;
type GetQueueResultReturn = ReturnType<typeof getQueueResult>;
type ListDurableObjectIdsReturn = ReturnType<typeof listDurableObjectIds>;
type RunDurableObjectAlarmReturn = ReturnType<typeof runDurableObjectAlarm>;
type RunInDurableObjectReturn = ReturnType<
  typeof runInDurableObject<{ ping: () => Promise<string> }, string>
>;
type RunInDurableObjectCallback = Parameters<
  typeof runInDurableObject<{ ping: () => Promise<string> }, string>
>[1];
type RunInDurableObjectStateParam = Parameters<RunInDurableObjectCallback>[1];
type WaitOnExecutionContextReturn = ReturnType<typeof waitOnExecutionContext>;
type CreatedPagesEventContext = ReturnType<
  typeof createPagesEventContext<{ userId: string }>
>;
type ListDurableObjectIdsInternalReturn = ReturnType<typeof listDurableObjectIdsInternal>;
type RunInDurableObjectInternalReturn = ReturnType<
  typeof runInDurableObjectInternal<{ ping: () => Promise<string> }, string>
>;
type RunInDurableObjectInternalCallback = Parameters<
  typeof runInDurableObjectInternal<{ ping: () => Promise<string> }, string>
>[1];
type RunInDurableObjectInternalStateParam = Parameters<RunInDurableObjectInternalCallback>[1];

type _ExecutionContextContract = Assert<
  IsAssignable<
    CreatedExecutionContext,
    ExecutionContext
  >
>;
type _SelfContract = Assert<
  IsAssignable<
    typeof SELF,
    {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
      scheduled: (options?: { scheduledTime?: number; cron?: string }) => Promise<void>;
    }
  >
>;
type _EnvReadonlyContract = Assert<
  IsAssignable<
    typeof env,
    Readonly<Record<string, unknown>>
  >
>;
type _ExecutionContextInternalContract = Assert<
  IsAssignable<
    CreatedExecutionContextInternal,
    ExecutionContext
  >
>;
type _ScheduledControllerContract = Assert<
  IsAssignable<
    CreatedScheduledController,
    ScheduledController
  >
>;
type _QueueControllerContract = Assert<
  IsAssignable<
    CreatedMessageBatch,
    QueueController<{ value: number }>
  >
>;
type _QueueResultContract = Assert<
  IsAssignable<
    GetQueueResultReturn,
    Promise<QueueResult>
  >
>;
type _ListDurableObjectIdsContract = Assert<
  IsAssignable<
    ListDurableObjectIdsReturn,
    Promise<DurableObjectIdLike[]>
  >
>;
type _RunDurableObjectAlarmContract = Assert<
  IsAssignable<
    RunDurableObjectAlarmReturn,
    Promise<boolean>
  >
>;
type _RunInDurableObjectContract = Assert<
  IsAssignable<
    RunInDurableObjectReturn,
    Promise<string>
  >
>;
type _RunInDurableObjectStateParamContract = Assert<
  IsAssignable<
    RunInDurableObjectStateParam,
    DurableObjectStateLike | DurableObjectStatePlaceholder
  >
>;
type _RunInDurableObjectStateParamReverseContract = Assert<
  IsAssignable<
    DurableObjectStateLike | DurableObjectStatePlaceholder,
    RunInDurableObjectStateParam
  >
>;
type _WaitOnExecutionContextContract = Assert<
  IsAssignable<
    WaitOnExecutionContextReturn,
    Promise<void>
  >
>;
type _PagesEventContextContract = Assert<
  IsAssignable<
    CreatedPagesEventContext,
    PagesEventContext<{ userId: string }>
  >
>;
type _FetchMockInternalContract = Assert<
  IsAssignable<
    typeof fetchMockInternal,
    import("undici").MockAgent
  >
>;
type _SelfInternalContract = Assert<
  IsAssignable<
    typeof SELFInternal,
    {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
      scheduled: (options?: { scheduledTime?: number; cron?: string }) => Promise<void>;
    }
  >
>;
type _ListDurableObjectIdsInternalContract = Assert<
  IsAssignable<
    ListDurableObjectIdsInternalReturn,
    Promise<DurableObjectIdLike[]>
  >
>;
type _RunInDurableObjectInternalContract = Assert<
  IsAssignable<
    RunInDurableObjectInternalReturn,
    Promise<string>
  >
>;
type _RunInDurableObjectInternalStateParamContract = Assert<
  IsAssignable<
    RunInDurableObjectInternalStateParam,
    DurableObjectStateLike | DurableObjectStatePlaceholder
  >
>;
type _EnvInternalReadonlyContract = Assert<
  IsAssignable<
    typeof envInternal,
    Readonly<Record<string, unknown>>
  >
>;

type _WorkersPluginNameContract = Assert<
  IsAssignable<
    typeof WORKERS_RSBUILD_PLUGIN_NAME,
    string
  >
>;

type _DurableObjectNamespaceLikeContract = Assert<
  IsAssignable<
    {
      newUniqueId: () => DurableObjectIdLike;
      idFromName: (_name: string) => DurableObjectIdLike;
      idFromString: (_id: string) => DurableObjectIdLike;
      get: (_id: DurableObjectIdLike) => DurableObjectStubLike;
    },
    DurableObjectNamespaceLike
  >
>;

type _DurableObjectStatePlaceholderContract = Assert<
  IsAssignable<
    DurableObjectStatePlaceholder,
    { __kind: "DurableObjectStatePlaceholder" }
  >
>;

type _DurableObjectStateLikeContract = Assert<
  IsAssignable<
    {
      storage: {
        getAlarm: () => Promise<number | null>;
        deleteAlarm: () => Promise<void>;
      };
    },
    DurableObjectStateLike
  >
>;
type _DurableObjectStateLikeConcurrencyContract = Assert<
  IsAssignable<
    {
      storage: {};
      props: { featureFlag: boolean };
      container: { name: string };
      blockConcurrencyWhile: <Result = unknown>(
        _closure: () => Promise<Result>
      ) => Promise<Result>;
      waitUntil: (_promise: Promise<unknown>) => void;
      id: DurableObjectIdLike;
    },
    DurableObjectStateLike
  >
>;
type _DurableObjectStateLikeWebSocketContract = Assert<
  IsAssignable<
    {
      storage: {};
      acceptWebSocket: (_ws: WebSocket, _tags?: string[]) => void;
      getWebSockets: (_tag?: string) => WebSocket[];
      setWebSocketAutoResponse: (_pair?: WebSocketRequestResponsePairLike) => void;
      getWebSocketAutoResponse: () => WebSocketRequestResponsePairLike | null;
      getWebSocketAutoResponseTimestamp: (_ws: WebSocket) => Date | null;
      setHibernatableWebSocketEventTimeout: (_timeoutMs?: number) => void;
      getHibernatableWebSocketEventTimeout: () => number | null;
      getTags: (_ws: WebSocket) => string[];
      abort: (_reason?: string) => void;
    },
    DurableObjectStateLike
  >
>;
type _DurableObjectStateLikePartialStorageContract = Assert<
  IsAssignable<
    {
      storage: {};
    },
    DurableObjectStateLike
  >
>;
type _DurableObjectStorageGetContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["get"]>,
    {
      <Value = unknown>(
        _key: string
      ): Promise<Value | undefined> | Value | undefined;
      <Value = unknown>(
        _keys: string[]
      ): Promise<Map<string, Value>> | Map<string, Value>;
    }
  >
>;
type _DurableObjectStoragePutContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["put"]>,
    {
      (
        _key: string,
        _value: unknown
      ): Promise<void> | void;
      (
        _entries: Record<string, unknown>
      ): Promise<void> | void;
    }
  >
>;
type _DurableObjectStorageListContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["list"]>,
    <Value = unknown>() => Promise<Map<string, Value>> | Map<string, Value>
  >
>;
type _DurableObjectStorageDeleteContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["delete"]>,
    {
      (_key: string): Promise<boolean> | boolean;
      (_keys: string[]): Promise<number> | number;
    }
  >
>;
type _DurableObjectStorageDeleteAllContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["deleteAll"]>,
    () => Promise<void> | void
  >
>;
type _DurableObjectStorageSetAlarmContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["setAlarm"]>,
    (
      _scheduledTime: number | Date,
      _options?: DurableObjectStorageSetAlarmOptionsLike
    ) => Promise<void> | void
  >
>;
type _DurableObjectStorageGetAlarmContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["getAlarm"]>,
    (
      _options?: DurableObjectStorageGetAlarmOptionsLike
    ) => Promise<number | null> | number | null
  >
>;
type _DurableObjectStorageDeleteAlarmContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["deleteAlarm"]>,
    (
      _options?: DurableObjectStorageSetAlarmOptionsLike
    ) => Promise<void> | void
  >
>;
type _DurableObjectStorageTransactionContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["transaction"]>,
    <Result = unknown>(
      _closure: (txn: DurableObjectTransactionLike) => Promise<Result> | Result
    ) => Promise<Result> | Result
  >
>;
type _DurableObjectStorageTransactionSyncContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["transactionSync"]>,
    <Result = unknown>(_closure: () => Result) => Result
  >
>;
type _DurableObjectStorageBookmarkContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["getCurrentBookmark"]>,
    () => Promise<string> | string
  >
>;
type _DurableObjectTransactionGetContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectTransactionLike["get"]>,
    {
      <Value = unknown>(
        _key: string
      ): Promise<Value | undefined> | Value | undefined;
      <Value = unknown>(
        _keys: string[]
      ): Promise<Map<string, Value>> | Map<string, Value>;
    }
  >
>;
type _DurableObjectTransactionPutContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectTransactionLike["put"]>,
    {
      (
        _key: string,
        _value: unknown
      ): Promise<void> | void;
      (
        _entries: Record<string, unknown>
      ): Promise<void> | void;
    }
  >
>;
type _DurableObjectTransactionDeleteContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectTransactionLike["delete"]>,
    {
      (_key: string): Promise<boolean> | boolean;
      (_keys: string[]): Promise<number> | number;
    }
  >
>;
type _DurableObjectTransactionRollbackContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectTransactionLike["rollback"]>,
    () => void
  >
>;
type _DurableObjectTransactionAlarmContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectTransactionLike["setAlarm"]>,
    (
      _scheduledTime: number | Date,
      _options?: DurableObjectStorageSetAlarmOptionsLike
    ) => Promise<void> | void
  >
>;
type _DurableObjectTransactionGetAlarmContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectTransactionLike["getAlarm"]>,
    (
      _options?: DurableObjectStorageGetAlarmOptionsLike
    ) => Promise<number | null> | number | null
  >
>;
type _DurableObjectTransactionDeleteAlarmContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectTransactionLike["deleteAlarm"]>,
    (
      _options?: DurableObjectStorageSetAlarmOptionsLike
    ) => Promise<void> | void
  >
>;

// @ts-expect-error `env` is readonly.
env.SHOULD_NOT_BE_ASSIGNABLE = 1;

export {};
