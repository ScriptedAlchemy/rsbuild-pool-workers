import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Miniflare, createFetchMock } from "miniflare";
import type { MockAgent } from "undici";
import type { WorkersRuntimeOptions } from "./options";
import { readRawWorkersOptionsFromDefine, resolveRuntimeOptions } from "./options";

type SnapshotEntry = {
  snapshotPath: string;
  persistPaths: string[];
};

function ensureAbsoluteUrl(input: string): string {
  if (/^https?:\/\//.test(input)) {
    return input;
  }
  const normalized = input.startsWith("/") ? input : `/${input}`;
  return `http://localhost${normalized}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function requestToDispatchArgs(request: Request): Promise<{
  url: string;
  init: RequestInit;
}> {
  const normalizedMethod = request.method.toUpperCase();
  const canIncludeBody = normalizedMethod !== "GET" && normalizedMethod !== "HEAD";
  const body = canIncludeBody && request.body !== null
    ? Buffer.from(await request.arrayBuffer())
    : undefined;

  return {
    url: request.url,
    init: {
      method: request.method,
      headers: request.headers,
      body
    }
  };
}

function isDurableObjectNamespaceLike(value: unknown): value is {
  idFromString(id: string): unknown;
} {
  const constructorName =
    (value as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof constructorName === "string" &&
    /^(?:Loopback)?DurableObjectNamespace$/.test(constructorName) &&
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

export class WorkersRuntimeState {
  private miniflare: Miniflare | undefined;
  private envCache: Record<string, unknown> | undefined;
  private setupReady = false;
  private singleWorker = true;
  private isolatedStorage = true;
  private resolvedOptions: WorkersRuntimeOptions | undefined;
  private snapshotRootPath: string | undefined;
  private snapshots: SnapshotEntry[] = [];
  private mockAgent = createFetchMock();

  constructor() {
    this.mockAgent.enableNetConnect();
  }

  private async closeMockAgent(): Promise<void> {
    try {
      await this.mockAgent.close();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        (error.name !== "ClientDestroyedError" &&
          !error.message.includes("client is destroyed"))
      ) {
        throw error;
      }
    }
  }

  private createMiniflareOptionsWithMockAgent(
    base: WorkersRuntimeOptions["miniflare"]
  ): WorkersRuntimeOptions["miniflare"] {
    return {
      ...base,
      fetchMock: this.mockAgent
    };
  }

  private async recreateFetchMock(): Promise<void> {
    await this.closeMockAgent();
    this.mockAgent = createFetchMock();
    this.mockAgent.enableNetConnect();
  }

  async setup(): Promise<void> {
    if (this.setupReady) {
      return;
    }

    const rawOptions = readRawWorkersOptionsFromDefine();
    const options = await resolveRuntimeOptions(rawOptions);
    this.resolvedOptions = options;
    this.singleWorker = options.singleWorker;
    this.isolatedStorage = options.isolatedStorage;

    await this.recreateFetchMock();
    this.miniflare = new Miniflare(
      this.createMiniflareOptionsWithMockAgent(options.miniflare)
    );
    await this.miniflare.ready;
    this.envCache = (await this.miniflare.getBindings()) as Record<string, unknown>;
    this.setupReady = true;
  }

  async teardown(): Promise<void> {
    await this.closeMockAgent();

    const mf = this.miniflare;
    this.miniflare = undefined;
    this.envCache = undefined;
    this.setupReady = false;
    this.singleWorker = true;
    this.isolatedStorage = true;
    this.resolvedOptions = undefined;

    if (mf) {
      await mf.dispose();
    }

    if (this.snapshotRootPath) {
      await fs.rm(this.snapshotRootPath, { recursive: true, force: true });
      this.snapshotRootPath = undefined;
      this.snapshots = [];
    }
  }

  async resetFetchMock(): Promise<void> {
    await this.recreateFetchMock();

    if (this.miniflare && this.resolvedOptions) {
      await this.miniflare.setOptions(
        this.createMiniflareOptionsWithMockAgent(this.resolvedOptions.miniflare)
      );
      this.envCache = (await this.miniflare.getBindings()) as Record<string, unknown>;
    }
  }

  getFetchMock(): MockAgent {
    return this.mockAgent as unknown as MockAgent;
  }

  isIsolatedStorageEnabled(): boolean {
    return this.isolatedStorage;
  }

  isSingleWorkerEnabled(): boolean {
    return this.singleWorker;
  }

  getEnvSync(): Record<string, unknown> {
    if (!this.envCache) {
      throw new Error(
        "Workers runtime is not initialized. Ensure `defineWorkersConfig()` is used and setup files are loaded."
      );
    }
    return this.envCache;
  }

  getSameIsolateDurableObjectNamespaces(): unknown[] {
    const bindings = this.getEnvSync();
    const miniflareOptions = this.resolvedOptions?.miniflare as
      | { durableObjects?: Record<string, unknown> }
      | undefined;
    const designators = miniflareOptions?.durableObjects;

    if (!designators) {
      return Object.values(bindings).filter(isDurableObjectNamespaceLike);
    }

    const namespaces: unknown[] = [];
    for (const [bindingName, designator] of Object.entries(designators)) {
      const maybeScriptName =
        typeof designator === "object" && designator !== null
          ? (designator as { scriptName?: unknown }).scriptName
          : undefined;
      if (typeof maybeScriptName === "string" && maybeScriptName.trim().length > 0) {
        continue;
      }

      const binding = bindings[bindingName];
      if (!isDurableObjectNamespaceLike(binding)) {
        throw new Error(
          `Expected ${bindingName} to be a DurableObjectNamespace binding`
        );
      }
      namespaces.push(binding);
    }

    return namespaces;
  }

  private getMiniflare(): Miniflare {
    if (!this.miniflare) {
      throw new Error(
        "Workers runtime is not initialized. Ensure `defineWorkersConfig()` is used and setup files are loaded."
      );
    }
    return this.miniflare;
  }

  async dispatchFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    await this.setup();
    const mf = this.getMiniflare();

    if (input instanceof Request) {
      const request = new Request(input, init);
      const dispatchArgs = await requestToDispatchArgs(request);
      return (await mf.dispatchFetch(
        dispatchArgs.url as never,
        dispatchArgs.init as never
      )) as unknown as Response;
    }

    if (input instanceof URL) {
      return (await mf.dispatchFetch(input.toString() as never, init as never)) as unknown as Response;
    }

    return (await mf.dispatchFetch(ensureAbsoluteUrl(input) as never, init as never)) as unknown as Response;
  }

  async dispatchScheduled(options?: {
    scheduledTime?: number;
    cron?: string;
  }): Promise<void> {
    await this.setup();
    const mf = this.getMiniflare() as unknown as {
      dispatchScheduled?: (opts?: { scheduledTime?: number; cron?: string }) => Promise<void>;
      getWorker?: () => Promise<{ scheduled?: (opts: { scheduledTime: number; cron: string }) => unknown }>;
    };

    if (mf.dispatchScheduled) {
      await mf.dispatchScheduled(options);
      return;
    }

    const worker = await mf.getWorker?.();
    if (worker && typeof worker.scheduled === "function") {
      await worker.scheduled({
        scheduledTime: options?.scheduledTime ?? Date.now(),
        cron: options?.cron ?? ""
      });
      return;
    }

    throw new Error("Current Miniflare version does not support scheduled dispatch.");
  }

  async listDurableObjectIds(namespace: unknown): Promise<unknown[]> {
    if (!isDurableObjectNamespaceLike(namespace)) {
      throw new TypeError(
        "Failed to execute 'listDurableObjectIds': parameter 1 is not of type 'DurableObjectNamespace'."
      );
    }

    await this.setup();

    const bindings = this.getEnvSync();
    const bindingName = Object.entries(bindings).find(([, value]) => value === namespace)?.[0];
    if (!bindingName) {
      throw new Error("Could not resolve Durable Object binding name for provided namespace.");
    }

    const miniflareOptions = this.resolvedOptions?.miniflare as
      | { durableObjects?: Record<string, unknown>; name?: string }
      | undefined;
    const designators = miniflareOptions?.durableObjects;
    if (!designators || !(bindingName in designators)) {
      throw new Error(
        `Could not resolve Durable Object designator for binding "${bindingName}".`
      );
    }
    const designator = designators[bindingName];

    let className: string | undefined;
    let scriptName: string | undefined;
    let unsafeUniqueKey: string | undefined;

    if (typeof designator === "string" && designator.trim().length > 0) {
      className = designator;
    } else if (designator && typeof designator === "object") {
      const maybeClassName = (designator as { className?: unknown }).className;
      if (typeof maybeClassName === "string" && maybeClassName.trim().length > 0) {
        className = maybeClassName;
      }
      const maybeScript = (designator as { scriptName?: unknown }).scriptName;
      if (typeof maybeScript === "string" && maybeScript.trim().length > 0) {
        scriptName = maybeScript;
      }
      const maybeUnsafeUniqueKey = (designator as { unsafeUniqueKey?: unknown }).unsafeUniqueKey;
      if (
        typeof maybeUnsafeUniqueKey === "string" &&
        maybeUnsafeUniqueKey.trim().length > 0
      ) {
        unsafeUniqueKey = maybeUnsafeUniqueKey;
      }
    }

    if (!className) {
      throw new Error(
        `Could not infer Durable Object class for binding "${bindingName}".`
      );
    }

    const resolvedUniqueKey =
      unsafeUniqueKey ??
      `${(scriptName ?? miniflareOptions?.name ?? "worker")}-${className}`;

    const durablePersistPath = (this.getMiniflare() as unknown as {
      unsafeGetPersistPaths?: () => Map<string, string>;
    }).unsafeGetPersistPaths?.()?.get("do");
    if (!durablePersistPath) {
      return [];
    }

    const namespaceKeys = [resolvedUniqueKey];

    const ids = new Set<string>();
    for (const namespaceKey of namespaceKeys) {
      const namespacePath = path.join(durablePersistPath, namespaceKey);
      let files: string[] = [];
      try {
        files = await fs.readdir(namespacePath);
      } catch {
        continue;
      }

      for (const name of files) {
        if (!name.endsWith(".sqlite")) {
          continue;
        }
        ids.add(name.slice(0, -".sqlite".length));
      }
    }

    const idFromString = namespace.idFromString;
    return Array.from(ids)
      .sort((a, b) => a.localeCompare(b))
      .map((id) => idFromString(id));
  }

  private getPersistPaths(): string[] {
    const mf = this.getMiniflare() as unknown as {
      unsafeGetPersistPaths?: () => Map<string, string>;
    };
    const map = mf.unsafeGetPersistPaths?.();
    if (!map) {
      return [];
    }
    return Array.from(new Set(map.values()));
  }

  async pushStorageSnapshot(): Promise<void> {
    await this.setup();
    if (!this.isolatedStorage) {
      return;
    }

    const persistPaths = this.getPersistPaths();
    if (persistPaths.length === 0) {
      return;
    }

    if (!this.snapshotRootPath) {
      this.snapshotRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-stack-"));
    }

    const snapshotPath = path.join(this.snapshotRootPath, `${Date.now()}-${this.snapshots.length}`);
    await fs.mkdir(snapshotPath, { recursive: true });

    for (const persistPath of persistPaths) {
      const targetPath = path.join(snapshotPath, persistPath.replaceAll(path.sep, "__"));
      if (await pathExists(persistPath)) {
        await fs.cp(persistPath, targetPath, { recursive: true, force: true });
      } else {
        await fs.mkdir(targetPath, { recursive: true });
      }
    }

    this.snapshots.push({ snapshotPath, persistPaths });
  }

  async popStorageSnapshot(): Promise<void> {
    if (!this.isolatedStorage) {
      return;
    }

    const snapshot = this.snapshots.pop();
    if (!snapshot) {
      return;
    }

    const existingMf = this.miniflare;
    if (existingMf) {
      await existingMf.dispose();
    }

    for (const persistPath of snapshot.persistPaths) {
      await fs.rm(persistPath, { recursive: true, force: true });

      const sourcePath = path.join(snapshot.snapshotPath, persistPath.replaceAll(path.sep, "__"));
      if (await pathExists(sourcePath)) {
        await fs.cp(sourcePath, persistPath, { recursive: true, force: true });
      }
    }

    const rawOptions = readRawWorkersOptionsFromDefine();
    const options = await resolveRuntimeOptions(rawOptions);
    this.resolvedOptions = options;
    this.miniflare = new Miniflare(
      this.createMiniflareOptionsWithMockAgent(options.miniflare)
    );
    await this.miniflare.ready;
    this.envCache = (await this.miniflare.getBindings()) as Record<string, unknown>;

    await fs.rm(snapshot.snapshotPath, { recursive: true, force: true });
  }

  async recreateWorkerInstance(): Promise<void> {
    await this.setup();

    const existingMf = this.miniflare;
    if (existingMf) {
      await existingMf.dispose();
    }

    const rawOptions = readRawWorkersOptionsFromDefine();
    const options = await resolveRuntimeOptions(rawOptions);
    this.resolvedOptions = options;
    this.singleWorker = options.singleWorker;
    this.isolatedStorage = options.isolatedStorage;
    this.miniflare = new Miniflare(
      this.createMiniflareOptionsWithMockAgent(options.miniflare)
    );
    await this.miniflare.ready;
    this.envCache = (await this.miniflare.getBindings()) as Record<string, unknown>;
  }
}

const RUNTIME_KEY = Symbol.for("@cloudflare/rstest-pool-workers/runtime-state");

type RuntimeHolder = {
  [RUNTIME_KEY]?: WorkersRuntimeState;
};

export function getWorkersRuntimeState(): WorkersRuntimeState {
  const holder = globalThis as RuntimeHolder;
  if (!holder[RUNTIME_KEY]) {
    holder[RUNTIME_KEY] = new WorkersRuntimeState();
  }
  return holder[RUNTIME_KEY];
}
