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
  introspectWorkflow,
  introspectWorkflowInstance,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext
} from "cloudflare:test";
import type {
  applyD1Migrations as applyD1MigrationsInternal,
  createMessageBatch as createMessageBatchInternal,
  createPagesEventContext as createPagesEventContextInternal,
  createScheduledController as createScheduledControllerInternal,
  createExecutionContext as createExecutionContextInternal,
  env as envInternal,
  fetchMock as fetchMockInternal,
  getQueueResult as getQueueResultInternal,
  introspectWorkflow as introspectWorkflowInternal,
  introspectWorkflowInstance as introspectWorkflowInstanceInternal,
  listDurableObjectIds as listDurableObjectIdsInternal,
  runDurableObjectAlarm as runDurableObjectAlarmInternal,
  runInDurableObject as runInDurableObjectInternal,
  SELF as SELFInternal,
  waitOnExecutionContext as waitOnExecutionContextInternal
} from "cloudflare:test-internal";
import { WORKERS_RSBUILD_PLUGIN_NAME } from "../src/index";

type Assert<T extends true> = T;
type IsAssignable<T, U> = [T] extends [U] ? true : false;

type CreatedExecutionContext = ReturnType<typeof createExecutionContext>;
type CreatedExecutionContextInternal = ReturnType<typeof createExecutionContextInternal>;
type CreatedScheduledController = ReturnType<typeof createScheduledController>;
type CreatedScheduledControllerInternal = ReturnType<typeof createScheduledControllerInternal>;
type CreatedMessageBatch = ReturnType<typeof createMessageBatch<{ value: number }>>;
type CreatedMessageBatchInternal = ReturnType<typeof createMessageBatchInternal<{ value: number }>>;
type GetQueueResultReturn = ReturnType<typeof getQueueResult>;
type GetQueueResultInternalReturn = ReturnType<typeof getQueueResultInternal>;
type ListDurableObjectIdsReturn = ReturnType<typeof listDurableObjectIds>;
type IntrospectWorkflowReturn = ReturnType<typeof introspectWorkflow>;
type IntrospectWorkflowInstanceReturn = ReturnType<typeof introspectWorkflowInstance>;
type RunDurableObjectAlarmReturn = ReturnType<typeof runDurableObjectAlarm>;
type RunInDurableObjectReturn = ReturnType<
  typeof runInDurableObject<{ ping: () => Promise<string> }, string>
>;
type RunInDurableObjectCallback = Parameters<
  typeof runInDurableObject<{ ping: () => Promise<string> }, string>
>[1];
type RunInDurableObjectStateParam = Parameters<RunInDurableObjectCallback>[1];
type RunInDurableObjectCtxStateCallback = Parameters<
  typeof runInDurableObject<
    { ping: () => Promise<string> },
    string,
    DurableObjectStubLike & { ctx: DurableObjectStateLike }
  >
>[1];
type RunInDurableObjectCtxStateParam = Parameters<RunInDurableObjectCtxStateCallback>[1];
type RunInDurableObjectStateStateCallback = Parameters<
  typeof runInDurableObject<
    { ping: () => Promise<string> },
    string,
    DurableObjectStubLike & { state: DurableObjectStateLike }
  >
>[1];
type RunInDurableObjectStateStateParam = Parameters<RunInDurableObjectStateStateCallback>[1];
type TypedCtxStateLike = DurableObjectStateLike<{ featureFlag: boolean }> & {
  marker: "ctx-state";
};
type RunInDurableObjectTypedCtxStateCallback = Parameters<
  typeof runInDurableObject<
    { ping: () => Promise<string> },
    string,
    DurableObjectStubLike & { ctx: TypedCtxStateLike }
  >
>[1];
type RunInDurableObjectTypedCtxStateParam = Parameters<
  RunInDurableObjectTypedCtxStateCallback
>[1];
type RunInDurableObjectNonStateCtxCallback = Parameters<
  typeof runInDurableObject<
    { ping: () => Promise<string> },
    string,
    DurableObjectStubLike & { ctx: { marker: "not-state-like" } }
  >
>[1];
type RunInDurableObjectNonStateCtxParam = Parameters<RunInDurableObjectNonStateCtxCallback>[1];
type RunInDurableObjectOptionalCtxStateCallback = Parameters<
  typeof runInDurableObject<
    { ping: () => Promise<string> },
    string,
    DurableObjectStubLike & { ctx?: DurableObjectStateLike }
  >
>[1];
type RunInDurableObjectOptionalCtxStateParam = Parameters<
  RunInDurableObjectOptionalCtxStateCallback
>[1];
type WaitOnExecutionContextReturn = ReturnType<typeof waitOnExecutionContext>;
type WaitOnExecutionContextInternalReturn = ReturnType<typeof waitOnExecutionContextInternal>;
type CreatedPagesEventContext = ReturnType<
  typeof createPagesEventContext<{ userId: string }>
>;
type CreatedPagesEventContextInternal = ReturnType<
  typeof createPagesEventContextInternal<{ userId: string }>
>;
type ApplyD1MigrationsInternalReturn = ReturnType<typeof applyD1MigrationsInternal>;
type ListDurableObjectIdsInternalReturn = ReturnType<typeof listDurableObjectIdsInternal>;
type IntrospectWorkflowInternalReturn = ReturnType<typeof introspectWorkflowInternal>;
type IntrospectWorkflowInstanceInternalReturn = ReturnType<typeof introspectWorkflowInstanceInternal>;
type RunDurableObjectAlarmInternalReturn = ReturnType<typeof runDurableObjectAlarmInternal>;
type RunInDurableObjectInternalReturn = ReturnType<
  typeof runInDurableObjectInternal<{ ping: () => Promise<string> }, string>
>;
type RunInDurableObjectInternalCallback = Parameters<
  typeof runInDurableObjectInternal<{ ping: () => Promise<string> }, string>
>[1];
type RunInDurableObjectInternalStateParam = Parameters<RunInDurableObjectInternalCallback>[1];
type RunInDurableObjectInternalCtxStateCallback = Parameters<
  typeof runInDurableObjectInternal<
    { ping: () => Promise<string> },
    string,
    DurableObjectStubLike & { ctx: DurableObjectStateLike }
  >
>[1];
type RunInDurableObjectInternalCtxStateParam = Parameters<
  RunInDurableObjectInternalCtxStateCallback
>[1];
type RunInDurableObjectInternalStateStateCallback = Parameters<
  typeof runInDurableObjectInternal<
    { ping: () => Promise<string> },
    string,
    DurableObjectStubLike & { state: DurableObjectStateLike }
  >
>[1];
type RunInDurableObjectInternalStateStateParam = Parameters<
  RunInDurableObjectInternalStateStateCallback
>[1];
type RunInDurableObjectInternalTypedCtxStateCallback = Parameters<
  typeof runInDurableObjectInternal<
    { ping: () => Promise<string> },
    string,
    DurableObjectStubLike & { ctx: TypedCtxStateLike }
  >
>[1];
type RunInDurableObjectInternalTypedCtxStateParam = Parameters<
  RunInDurableObjectInternalTypedCtxStateCallback
>[1];
type RunInDurableObjectInternalNonStateCtxCallback = Parameters<
  typeof runInDurableObjectInternal<
    { ping: () => Promise<string> },
    string,
    DurableObjectStubLike & { ctx: { marker: "not-state-like" } }
  >
>[1];
type RunInDurableObjectInternalNonStateCtxParam = Parameters<
  RunInDurableObjectInternalNonStateCtxCallback
>[1];
type RunInDurableObjectInternalOptionalCtxStateCallback = Parameters<
  typeof runInDurableObjectInternal<
    { ping: () => Promise<string> },
    string,
    DurableObjectStubLike & { ctx?: DurableObjectStateLike }
  >
>[1];
type RunInDurableObjectInternalOptionalCtxStateParam = Parameters<
  RunInDurableObjectInternalOptionalCtxStateCallback
>[1];

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
type _ScheduledControllerInternalContract = Assert<
  IsAssignable<
    CreatedScheduledControllerInternal,
    ScheduledController
  >
>;
type _QueueControllerContract = Assert<
  IsAssignable<
    CreatedMessageBatch,
    QueueController<{ value: number }>
  >
>;
type _QueueControllerInternalContract = Assert<
  IsAssignable<
    CreatedMessageBatchInternal,
    QueueController<{ value: number }>
  >
>;
type _QueueResultContract = Assert<
  IsAssignable<
    GetQueueResultReturn,
    Promise<QueueResult>
  >
>;
type _QueueResultInternalContract = Assert<
  IsAssignable<
    GetQueueResultInternalReturn,
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
type _IntrospectWorkflowContract = Assert<
  IsAssignable<
    IntrospectWorkflowReturn,
    Promise<never>
  >
>;
type _IntrospectWorkflowInstanceContract = Assert<
  IsAssignable<
    IntrospectWorkflowInstanceReturn,
    Promise<never>
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
type _RunInDurableObjectCtxStateParamContract = Assert<
  IsAssignable<
    RunInDurableObjectCtxStateParam,
    DurableObjectStateLike
  >
>;
type _RunInDurableObjectCtxStateParamReverseContract = Assert<
  IsAssignable<
    DurableObjectStateLike,
    RunInDurableObjectCtxStateParam
  >
>;
type _RunInDurableObjectStateStateParamContract = Assert<
  IsAssignable<
    RunInDurableObjectStateStateParam,
    DurableObjectStateLike
  >
>;
type _RunInDurableObjectStateStateParamReverseContract = Assert<
  IsAssignable<
    DurableObjectStateLike,
    RunInDurableObjectStateStateParam
  >
>;
type _RunInDurableObjectTypedCtxStateParamContract = Assert<
  IsAssignable<
    RunInDurableObjectTypedCtxStateParam,
    TypedCtxStateLike
  >
>;
type _RunInDurableObjectTypedCtxStateParamReverseContract = Assert<
  IsAssignable<
    TypedCtxStateLike,
    RunInDurableObjectTypedCtxStateParam
  >
>;
type _RunInDurableObjectNonStateCtxParamContract = Assert<
  IsAssignable<
    RunInDurableObjectNonStateCtxParam,
    DurableObjectStateLike | DurableObjectStatePlaceholder
  >
>;
type _RunInDurableObjectOptionalCtxStateParamContract = Assert<
  IsAssignable<
    RunInDurableObjectOptionalCtxStateParam,
    DurableObjectStateLike
  >
>;
type _RunInDurableObjectCtxStateOverloadContract = Assert<
  IsAssignable<
    typeof runInDurableObject,
    <_ObjectType, _ReturnType>(
      _stub: DurableObjectStubLike & { ctx: DurableObjectStateLike },
      _callback: (
        _instance: _ObjectType,
        _state: DurableObjectStateLike
      ) => _ReturnType | Promise<_ReturnType>
    ) => Promise<_ReturnType>
  >
>;
type _RunInDurableObjectStateStateOverloadContract = Assert<
  IsAssignable<
    typeof runInDurableObject,
    <_ObjectType, _ReturnType>(
      _stub: DurableObjectStubLike & { state: DurableObjectStateLike },
      _callback: (
        _instance: _ObjectType,
        _state: DurableObjectStateLike
      ) => _ReturnType | Promise<_ReturnType>
    ) => Promise<_ReturnType>
  >
>;
type _WaitOnExecutionContextContract = Assert<
  IsAssignable<
    WaitOnExecutionContextReturn,
    Promise<void>
  >
>;
type _WaitOnExecutionContextInternalContract = Assert<
  IsAssignable<
    WaitOnExecutionContextInternalReturn,
    Promise<void>
  >
>;
type _PagesEventContextContract = Assert<
  IsAssignable<
    CreatedPagesEventContext,
    PagesEventContext<{ userId: string }>
  >
>;
type _PagesEventContextInternalContract = Assert<
  IsAssignable<
    CreatedPagesEventContextInternal,
    PagesEventContext<{ userId: string }>
  >
>;
type _ApplyD1MigrationsInternalContract = Assert<
  IsAssignable<
    ApplyD1MigrationsInternalReturn,
    Promise<void>
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
type _IntrospectWorkflowInternalContract = Assert<
  IsAssignable<
    IntrospectWorkflowInternalReturn,
    Promise<never>
  >
>;
type _IntrospectWorkflowInstanceInternalContract = Assert<
  IsAssignable<
    IntrospectWorkflowInstanceInternalReturn,
    Promise<never>
  >
>;
type _RunDurableObjectAlarmInternalContract = Assert<
  IsAssignable<
    RunDurableObjectAlarmInternalReturn,
    Promise<boolean>
  >
>;
type _RunInDurableObjectInternalContract = Assert<
  IsAssignable<
    RunInDurableObjectInternalReturn,
    Promise<string>
  >
>;
type _RunInDurableObjectInternalCtxStateOverloadContract = Assert<
  IsAssignable<
    typeof runInDurableObjectInternal,
    <_ObjectType, _ReturnType>(
      _stub: DurableObjectStubLike & { ctx: DurableObjectStateLike },
      _callback: (
        _instance: _ObjectType,
        _state: DurableObjectStateLike
      ) => _ReturnType | Promise<_ReturnType>
    ) => Promise<_ReturnType>
  >
>;
type _RunInDurableObjectInternalStateStateOverloadContract = Assert<
  IsAssignable<
    typeof runInDurableObjectInternal,
    <_ObjectType, _ReturnType>(
      _stub: DurableObjectStubLike & { state: DurableObjectStateLike },
      _callback: (
        _instance: _ObjectType,
        _state: DurableObjectStateLike
      ) => _ReturnType | Promise<_ReturnType>
    ) => Promise<_ReturnType>
  >
>;
type _RunInDurableObjectInternalStateParamContract = Assert<
  IsAssignable<
    RunInDurableObjectInternalStateParam,
    DurableObjectStateLike | DurableObjectStatePlaceholder
  >
>;
type _RunInDurableObjectInternalCtxStateParamContract = Assert<
  IsAssignable<
    RunInDurableObjectInternalCtxStateParam,
    DurableObjectStateLike
  >
>;
type _RunInDurableObjectInternalCtxStateParamReverseContract = Assert<
  IsAssignable<
    DurableObjectStateLike,
    RunInDurableObjectInternalCtxStateParam
  >
>;
type _RunInDurableObjectInternalStateStateParamContract = Assert<
  IsAssignable<
    RunInDurableObjectInternalStateStateParam,
    DurableObjectStateLike
  >
>;
type _RunInDurableObjectInternalStateStateParamReverseContract = Assert<
  IsAssignable<
    DurableObjectStateLike,
    RunInDurableObjectInternalStateStateParam
  >
>;
type _RunInDurableObjectInternalTypedCtxStateParamContract = Assert<
  IsAssignable<
    RunInDurableObjectInternalTypedCtxStateParam,
    TypedCtxStateLike
  >
>;
type _RunInDurableObjectInternalTypedCtxStateParamReverseContract = Assert<
  IsAssignable<
    TypedCtxStateLike,
    RunInDurableObjectInternalTypedCtxStateParam
  >
>;
type _RunInDurableObjectInternalNonStateCtxParamContract = Assert<
  IsAssignable<
    RunInDurableObjectInternalNonStateCtxParam,
    DurableObjectStateLike | DurableObjectStatePlaceholder
  >
>;
type _RunInDurableObjectInternalOptionalCtxStateParamContract = Assert<
  IsAssignable<
    RunInDurableObjectInternalOptionalCtxStateParam,
    DurableObjectStateLike
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
type _DurableObjectStateLikeGenericPropsContract = Assert<
  IsAssignable<
    DurableObjectStateLike<{ featureFlag: boolean }>["props"],
    { featureFlag: boolean } | undefined
  >
>;
type _DurableObjectStorageGetContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["get"]>,
    {
      <Value = unknown>(
        _key: string
      ): Promise<Value | undefined>;
      <Value = unknown>(
        _keys: string[]
      ): Promise<Map<string, Value>>;
    }
  >
>;
type _DurableObjectStoragePutContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["put"]>,
    {
      <Value = unknown>(
        _key: string,
        _value: Value
      ): Promise<void>;
      <Value = unknown>(
        _entries: Record<string, Value>
      ): Promise<void>;
    }
  >
>;
type _DurableObjectStorageListContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["list"]>,
    <Value = unknown>() => Promise<Map<string, Value>>
  >
>;
type _DurableObjectStorageDeleteContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["delete"]>,
    {
      (_key: string): Promise<boolean>;
      (_keys: string[]): Promise<number>;
    }
  >
>;
type _DurableObjectStorageDeleteAllContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["deleteAll"]>,
    () => Promise<void>
  >
>;
type _DurableObjectStorageSetAlarmContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["setAlarm"]>,
    (
      _scheduledTime: number | Date,
      _options?: DurableObjectStorageSetAlarmOptionsLike
    ) => Promise<void>
  >
>;
type _DurableObjectStorageGetAlarmContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["getAlarm"]>,
    (
      _options?: DurableObjectStorageGetAlarmOptionsLike
    ) => Promise<number | null>
  >
>;
type _DurableObjectStorageDeleteAlarmContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["deleteAlarm"]>,
    (
      _options?: DurableObjectStorageSetAlarmOptionsLike
    ) => Promise<void>
  >
>;
type _DurableObjectStorageTransactionContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["transaction"]>,
    <Result = unknown>(
      _closure: (txn: DurableObjectTransactionLike) => Promise<Result>
    ) => Promise<Result>
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
    () => Promise<string>
  >
>;
type _DurableObjectStorageBookmarkForTimeContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["getBookmarkForTime"]>,
    (_timestamp: number | Date) => Promise<string>
  >
>;
type _DurableObjectStorageRestoreBookmarkContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectStateLike["storage"]["onNextSessionRestoreBookmark"]>,
    (_bookmark: string) => Promise<string>
  >
>;
type _DurableObjectTransactionGetContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectTransactionLike["get"]>,
    {
      <Value = unknown>(
        _key: string
      ): Promise<Value | undefined>;
      <Value = unknown>(
        _keys: string[]
      ): Promise<Map<string, Value>>;
    }
  >
>;
type _DurableObjectTransactionPutContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectTransactionLike["put"]>,
    {
      <Value = unknown>(
        _key: string,
        _value: Value
      ): Promise<void>;
      <Value = unknown>(
        _entries: Record<string, Value>
      ): Promise<void>;
    }
  >
>;
type _DurableObjectTransactionDeleteContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectTransactionLike["delete"]>,
    {
      (_key: string): Promise<boolean>;
      (_keys: string[]): Promise<number>;
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
    ) => Promise<void>
  >
>;
type _DurableObjectTransactionGetAlarmContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectTransactionLike["getAlarm"]>,
    (
      _options?: DurableObjectStorageGetAlarmOptionsLike
    ) => Promise<number | null>
  >
>;
type _DurableObjectTransactionDeleteAlarmContract = Assert<
  IsAssignable<
    NonNullable<DurableObjectTransactionLike["deleteAlarm"]>,
    (
      _options?: DurableObjectStorageSetAlarmOptionsLike
    ) => Promise<void>
  >
>;

// @ts-expect-error `env` is readonly.
env.SHOULD_NOT_BE_ASSIGNABLE = 1;

export {};
