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

  export function applyD1Migrations(
    db: {
      prepare: (sql: string) => {
        bind: (...args: unknown[]) => unknown;
        run: () => Promise<unknown>;
      };
    },
    migrations: D1Migration[],
    migrationsTableName?: string
  ): Promise<void>;

  export function createExecutionContext(): unknown;
  export function waitOnExecutionContext(ctx: unknown): Promise<void>;
  export function createScheduledController(options?: {
    scheduledTime?: number;
    cron?: string;
  }): unknown;
  export function createMessageBatch<Body = unknown>(
    queueName: string,
    messages: Array<{ id: string; timestamp: number | Date; body: Body; attempts: number }>
  ): unknown;
  export function getQueueResult(batch: unknown, ctx: unknown): Promise<unknown>;
  export function createPagesEventContext<T extends Record<string, unknown>>(init: {
    request: Request;
    functionPath?: string;
    next?: (request: Request) => Promise<Response> | Response;
    params?: Record<string, string | string[]>;
    data?: T;
    env?: Record<string, unknown>;
  }): unknown;

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
