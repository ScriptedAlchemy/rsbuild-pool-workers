import type {
  DurableObjectIdLike,
  DurableObjectNamespaceLike,
  DurableObjectStatePlaceholder,
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
  fetchMock as fetchMockInternal
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
type WaitOnExecutionContextReturn = ReturnType<typeof waitOnExecutionContext>;
type CreatedPagesEventContext = ReturnType<
  typeof createPagesEventContext<{ userId: string }>
>;

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

// @ts-expect-error `env` is readonly.
env.SHOULD_NOT_BE_ASSIGNABLE = 1;

export {};
