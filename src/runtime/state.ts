import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Miniflare } from "miniflare";
import { Agent, MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
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

export class WorkersRuntimeState {
  private miniflare: Miniflare | undefined;
  private envCache: Record<string, unknown> | undefined;
  private setupReady = false;
  private isolatedStorage = true;
  private snapshotRootPath: string | undefined;
  private snapshots: SnapshotEntry[] = [];
  private readonly originalDispatcher = getGlobalDispatcher();
  private mockAgent: MockAgent = new MockAgent({ agent: new Agent() });

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

  async setup(): Promise<void> {
    if (this.setupReady) {
      return;
    }

    const rawOptions = readRawWorkersOptionsFromDefine();
    const options = await resolveRuntimeOptions(rawOptions);
    this.isolatedStorage = options.isolatedStorage;
    this.miniflare = new Miniflare(options.miniflare);
    await this.miniflare.ready;
    this.envCache = (await this.miniflare.getBindings()) as Record<string, unknown>;

    await this.resetFetchMock();
    this.setupReady = true;
  }

  async teardown(): Promise<void> {
    await this.closeMockAgent();
    setGlobalDispatcher(this.originalDispatcher);

    const mf = this.miniflare;
    this.miniflare = undefined;
    this.envCache = undefined;
    this.setupReady = false;
    this.isolatedStorage = true;

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
    await this.closeMockAgent();
    this.mockAgent = new MockAgent({ agent: new Agent() });
    this.mockAgent.enableNetConnect();
    setGlobalDispatcher(this.mockAgent);
  }

  getFetchMock(): MockAgent {
    return this.mockAgent;
  }

  isIsolatedStorageEnabled(): boolean {
    return this.isolatedStorage;
  }

  getEnvSync(): Record<string, unknown> {
    if (!this.envCache) {
      throw new Error(
        "Workers runtime is not initialized. Ensure `defineWorkersConfig()` is used and setup files are loaded."
      );
    }
    return this.envCache;
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
      return (await mf.dispatchFetch(input as never, init as never)) as unknown as Response;
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
    };

    if (!mf.dispatchScheduled) {
      throw new Error("Current Miniflare version does not support scheduled dispatch.");
    }

    await mf.dispatchScheduled(options);
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
    this.miniflare = new Miniflare(options.miniflare);
    await this.miniflare.ready;
    this.envCache = (await this.miniflare.getBindings()) as Record<string, unknown>;

    await fs.rm(snapshot.snapshotPath, { recursive: true, force: true });
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
