import type { RstestConfig } from "@rstest/core";

export interface WorkerPoolOptionsContext {
  inject: <T = unknown>(key: string) => T;
}

export interface WorkersWranglerOptions {
  configPath?: string;
  environment?: string;
}

export interface WorkersPoolOptions {
  main?: string;
  singleWorker?: boolean;
  isolatedStorage?: boolean;
  remoteBindings?: boolean;
  additionalExports?: Record<
    string,
    "WorkerEntrypoint" | "DurableObject" | "WorkflowEntrypoint"
  >;
  miniflare?: Record<string, unknown>;
  wrangler?: WorkersWranglerOptions;
}

export type WorkersTestConfig = Partial<RstestConfig> & {
  poolOptions?: {
    workers?:
      | WorkersPoolOptions
      | ((ctx: WorkerPoolOptionsContext) => WorkersPoolOptions | Promise<WorkersPoolOptions>);
  };
};

export type WorkersUserConfig<T extends RstestConfig = RstestConfig> = T & {
  workers?: WorkersPoolOptions;
  test?: WorkersTestConfig;
};

export type ConfigFn<T extends RstestConfig> = () => T | Promise<T>;
export type AnyConfigExport<T extends RstestConfig> = T | Promise<T> | ConfigFn<T>;

export function mapAnyConfigExport<T extends RstestConfig, U extends RstestConfig>(
  mapper: (value: T) => U,
  config: T
): U;
export function mapAnyConfigExport<T extends RstestConfig, U extends RstestConfig>(
  mapper: (value: T) => U,
  config: Promise<T>
): Promise<U>;
export function mapAnyConfigExport<T extends RstestConfig, U extends RstestConfig>(
  mapper: (value: T) => U,
  config: ConfigFn<T>
): ConfigFn<U>;
export function mapAnyConfigExport<T extends RstestConfig, U extends RstestConfig>(
  mapper: (value: T) => U,
  config: AnyConfigExport<T>
): AnyConfigExport<U> {
  if (typeof config === "function") {
    return (() => Promise.resolve((config as ConfigFn<T>)()).then(mapper)) as ConfigFn<U>;
  }

  if (config instanceof Promise) {
    return config.then(mapper);
  }

  return mapper(config);
}
