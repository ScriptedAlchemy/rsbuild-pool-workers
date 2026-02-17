const kWaitUntil = Symbol("kWaitUntil");
const kConstructFlag = Symbol("kConstructFlag");

export class ExecutionContext {
  [kWaitUntil]: Promise<unknown>[] = [];

  constructor(flag: symbol) {
    if (flag !== kConstructFlag) {
      throw new TypeError("Illegal constructor");
    }
  }

  waitUntil(promise: Promise<unknown>): void {
    this[kWaitUntil].push(promise);
  }

  passThroughOnException(): void {}
}

export function createExecutionContext(): ExecutionContext {
  return new ExecutionContext(kConstructFlag);
}

async function waitForPromises(waitUntil: Promise<unknown>[]): Promise<void> {
  const errors: unknown[] = [];
  while (waitUntil.length > 0) {
    const chunk = waitUntil.splice(0, waitUntil.length);
    const results = await Promise.allSettled(chunk);
    for (const result of results) {
      if (result.status === "rejected") {
        errors.push(result.reason);
      }
    }
  }

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors);
  }
}

export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void> {
  if (!(ctx instanceof ExecutionContext)) {
    throw new TypeError(
      "Failed to execute 'waitOnExecutionContext': parameter 1 must be an ExecutionContext."
    );
  }
  return waitForPromises(ctx[kWaitUntil]);
}

export class ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;

  constructor(flag: symbol, options?: { scheduledTime?: number; cron?: string }) {
    if (flag !== kConstructFlag) {
      throw new TypeError("Illegal constructor");
    }
    this.scheduledTime = Number(options?.scheduledTime ?? Date.now());
    this.cron = String(options?.cron ?? "");
  }

  noRetry(): void {}
}

export function createScheduledController(options?: {
  scheduledTime?: number;
  cron?: string;
}): ScheduledController {
  return new ScheduledController(kConstructFlag, options);
}

type QueueMessageState<Body = unknown> = {
  id: string;
  timestamp: Date;
  body: Body;
  attempts: number;
  acked: boolean;
  retried: boolean;
};

export class QueueMessage<Body = unknown> {
  constructor(private readonly state: QueueMessageState<Body>) {}

  get id(): string {
    return this.state.id;
  }

  get timestamp(): Date {
    return this.state.timestamp;
  }

  get body(): Body {
    return this.state.body;
  }

  get attempts(): number {
    return this.state.attempts;
  }

  retry(): void {
    this.state.retried = true;
  }

  ack(): void {
    this.state.acked = true;
  }
}

export class QueueController<Body = unknown> {
  private readonly states: QueueMessageState<Body>[];
  readonly messages: QueueMessage<Body>[];
  private ackAllFlag = false;
  private retryAllFlag = false;

  constructor(flag: symbol, readonly queue: string, messages: Array<{ id: string; timestamp: number | Date; body: Body; attempts: number }>) {
    if (flag !== kConstructFlag) {
      throw new TypeError("Illegal constructor");
    }

    this.states = messages.map((message) => ({
      id: String(message.id),
      timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp),
      body: structuredClone(message.body),
      attempts: Number(message.attempts),
      acked: false,
      retried: false
    }));
    this.messages = this.states.map((state) => new QueueMessage(state));
  }

  retryAll(): void {
    this.retryAllFlag = true;
  }

  ackAll(): void {
    this.ackAllFlag = true;
  }

  toResult() {
    return {
      outcome: "ok" as const,
      retryBatch: { retry: this.retryAllFlag },
      ackAll: this.ackAllFlag,
      retryMessages: this.states
        .filter((state) => state.retried)
        .map((state) => ({ msgId: state.id })),
      explicitAcks: this.states.filter((state) => state.acked).map((state) => state.id)
    };
  }
}

export function createMessageBatch<Body = unknown>(
  queueName: string,
  messages: Array<{ id: string; timestamp: number | Date; body: Body; attempts: number }>
): QueueController<Body> {
  if (!Array.isArray(messages)) {
    throw new TypeError(
      "Failed to execute 'createMessageBatch': parameter 2 must be an Array."
    );
  }
  return new QueueController(kConstructFlag, queueName, messages);
}

export async function getQueueResult(batch: QueueController, ctx: ExecutionContext) {
  if (!(batch instanceof QueueController)) {
    throw new TypeError("Failed to execute 'getQueueResult': batch must be a QueueController.");
  }
  await waitOnExecutionContext(ctx);
  return batch.toResult();
}

export function createPagesEventContext<T extends Record<string, unknown>>(init: {
  request: Request;
  functionPath?: string;
  next?: (request: Request) => Promise<Response> | Response;
  params?: Record<string, string | string[]>;
  data?: T;
  env?: Record<string, unknown>;
}) {
  const executionContext = createExecutionContext();
  return {
    request: init.request,
    functionPath: init.functionPath ?? "",
    next: async (request?: Request) => {
      if (!init.next) {
        throw new TypeError("`next` was not supplied to createPagesEventContext().");
      }
      return init.next(request ?? init.request);
    },
    params: init.params ?? {},
    data: init.data ?? ({} as T),
    env: init.env ?? {},
    waitUntil: executionContext.waitUntil.bind(executionContext),
    passThroughOnException: executionContext.passThroughOnException.bind(executionContext),
    [kWaitUntil]: executionContext[kWaitUntil]
  };
}
