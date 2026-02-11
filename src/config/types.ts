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

export type WorkersPoolOptionsInput =
  | WorkersPoolOptions
  | ((ctx: WorkerPoolOptionsContext) => WorkersPoolOptions | Promise<WorkersPoolOptions>);

export type WorkersTestConfig = Partial<RstestConfig> & {
  poolOptions?: {
    workers?: WorkersPoolOptionsInput;
  };
};

export type WorkersUserConfig<T extends RstestConfig = RstestConfig> = T & {
  workers?: WorkersPoolOptionsInput;
  test?: WorkersTestConfig;
};

export type ConfigFn<
  T extends RstestConfig,
  TArgs extends unknown[] = unknown[],
  TThis = unknown
> = (this: TThis, ...args: TArgs) => T | Promise<T>;
export type AnyConfigExport<
  T extends RstestConfig,
  TArgs extends unknown[] = unknown[],
  TThis = unknown
> = T | Promise<T> | ConfigFn<T, TArgs, TThis>;

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
export function mapAnyConfigExport<
  T extends RstestConfig,
  U extends RstestConfig,
  TArgs extends unknown[],
  TThis
>(
  mapper: (value: T) => U,
  config: ConfigFn<T, TArgs, TThis>
): ConfigFn<U, TArgs, TThis>;
export function mapAnyConfigExport<
  T extends RstestConfig,
  U extends RstestConfig,
  TArgs extends unknown[],
  TThis
>(
  mapper: (value: T) => U,
  config: AnyConfigExport<T, TArgs, TThis>
): AnyConfigExport<U, TArgs, TThis> {
  if (typeof config === "function") {
    return (function (this: unknown, ...args: unknown[]) {
      return Promise.resolve((config as ConfigFn<T>).apply(this, args)).then(mapper);
    }) as ConfigFn<U, TArgs, TThis>;
  }

  if (config instanceof Promise) {
    return config.then(mapper);
  }

  return mapper(config);
}
