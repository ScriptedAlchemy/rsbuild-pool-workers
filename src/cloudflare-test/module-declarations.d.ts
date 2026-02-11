declare module "cloudflare:test" {
  export const env: Record<string, unknown>;

  export const SELF: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    scheduled(options?: { scheduledTime?: number; cron?: string }): Promise<void>;
  };

  export const fetchMock: import("undici").MockAgent;

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
    stub: unknown,
    callback: (_instance: _ObjectType, _state: unknown) => _ReturnType | Promise<_ReturnType>
  ): Promise<_ReturnType>;
  export function runDurableObjectAlarm(stub: unknown): Promise<boolean>;
  export function listDurableObjectIds(namespace: unknown): Promise<unknown[]>;
  export function introspectWorkflowInstance(
    workflow: unknown,
    instanceId: string
  ): Promise<never>;
  export function introspectWorkflow(workflow: unknown): Promise<never>;
}
