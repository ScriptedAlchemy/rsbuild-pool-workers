import type {
  ExecutionContext,
  PagesEventContext,
  QueueController,
  QueueResult,
  ScheduledController,
  createExecutionContext,
  createMessageBatch,
  createPagesEventContext,
  createScheduledController,
  getQueueResult,
  waitOnExecutionContext
} from "cloudflare:test";

type Assert<T extends true> = T;
type IsAssignable<T, U> = [T] extends [U] ? true : false;

type CreatedExecutionContext = ReturnType<typeof createExecutionContext>;
type CreatedScheduledController = ReturnType<typeof createScheduledController>;
type CreatedMessageBatch = ReturnType<typeof createMessageBatch<{ value: number }>>;
type GetQueueResultReturn = ReturnType<typeof getQueueResult>;
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

export {};
