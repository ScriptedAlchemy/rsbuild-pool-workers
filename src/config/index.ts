/// <reference path="../cloudflare-test/module-declarations.d.ts" />

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RstestConfig } from "@rstest/core";
import {
  WORKERS_RSBUILD_PLUGIN_NAME,
  workersRsbuildPlugin
} from "../plugin/workers-plugin";
import {
  type AnyConfigExport,
  type WorkersPoolOptions,
  type WorkersUserConfig
} from "./types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const setupPathJs = path.resolve(__dirname, "../runtime/setup.js");
const setupPathTs = path.resolve(__dirname, "../runtime/setup.ts");
const SETUP_FILE_PATH = fs.existsSync(setupPathJs) ? setupPathJs : setupPathTs;
export const WORKERS_OPTIONS_DEFINE_KEY = "__RSTEST_POOL_WORKERS_OPTIONS_JSON__";

function ensureArrayIncludes<T>(array: T[], items: T[]): void {
  for (const item of items) {
    if (!array.includes(item)) {
      array.push(item);
    }
  }
}

function ensureWorkersPluginInstalled(plugins: unknown[]): void {
  if (
    plugins.some(
      (plugin) =>
        typeof plugin === "object" &&
        plugin !== null &&
        "name" in plugin &&
        (plugin as { name?: unknown }).name === WORKERS_RSBUILD_PLUGIN_NAME
    )
  ) {
    return;
  }
  plugins.push(workersRsbuildPlugin());
}

function applyWorkersWiring(
  flattenedConfig: RstestConfig,
  workersOptions: WorkersPoolOptions
): void {
  const plugins = Array.isArray(flattenedConfig.plugins)
    ? [...flattenedConfig.plugins]
    : flattenedConfig.plugins
      ? [flattenedConfig.plugins]
      : [];
  ensureWorkersPluginInstalled(plugins);
  flattenedConfig.plugins = plugins;

  flattenedConfig.setupFiles = [
    ...(Array.isArray(flattenedConfig.setupFiles)
      ? flattenedConfig.setupFiles
      : flattenedConfig.setupFiles
        ? [flattenedConfig.setupFiles]
        : [])
  ];
  ensureArrayIncludes(flattenedConfig.setupFiles, [SETUP_FILE_PATH]);

  flattenedConfig.source ??= {};
  flattenedConfig.source.define ??= {};
  flattenedConfig.source.define[WORKERS_OPTIONS_DEFINE_KEY] = JSON.stringify(
    JSON.stringify(workersOptions)
  );
}

function getCallerConfigDirectory(): string {
  const stack = new Error().stack?.split("\n") ?? [];
  const thisFilePath = fileURLToPath(import.meta.url);

  for (const line of stack.slice(2)) {
    const match =
      line.match(/\((.+):\d+:\d+\)$/) ??
      line.match(/at (.+):\d+:\d+$/);
    if (!match?.[1]) {
      continue;
    }

    const rawPath = match[1].startsWith("file://")
      ? fileURLToPath(match[1])
      : match[1];
    const candidate = rawPath.replaceAll("\\", "/");
    if (candidate === thisFilePath.replaceAll("\\", "/")) {
      continue;
    }
    if (candidate.includes("/src/config/index.ts")) {
      continue;
    }
    if (candidate.includes("/node_modules/")) {
      continue;
    }
    if (!path.isAbsolute(rawPath)) {
      continue;
    }
    return path.dirname(rawPath);
  }

  return process.cwd();
}

function normalizeWorkersPaths(
  options: WorkersPoolOptions,
  configDirectory: string
): WorkersPoolOptions {
  const next: WorkersPoolOptions = {
    ...options,
    miniflare: options.miniflare ? { ...options.miniflare } : undefined,
    wrangler: options.wrangler ? { ...options.wrangler } : undefined
  };

  if (next.main && !path.isAbsolute(next.main)) {
    next.main = path.resolve(configDirectory, next.main);
  }

  if (next.wrangler?.configPath && !path.isAbsolute(next.wrangler.configPath)) {
    next.wrangler.configPath = path.resolve(configDirectory, next.wrangler.configPath);
  }

  return next;
}

function createInject() {
  return <T = unknown>(key: string): T => {
    const scoped = process.env[`RSTEST_INJECT_${key}`];
    const direct = process.env[key];
    const value = scoped ?? direct;

    if (value === undefined) {
      return undefined as T;
    }

    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  };
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function describeWorkersOptionsValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function ensureWorkersOptionsObject(
  value: unknown,
  sourceLabel: string
): WorkersPoolOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      `Invalid workers options from ${sourceLabel}: expected an object but received ` +
        `${describeWorkersOptionsValue(value)}.`
    );
  }

  return value as WorkersPoolOptions;
}

function selectRawWorkersOptions(config: WorkersUserConfig): {
  rawWorkersOptions: unknown;
  sourceLabel: string;
} {
  if (config.workers !== undefined) {
    return {
      rawWorkersOptions: config.workers,
      sourceLabel: "workers"
    };
  }

  if (config.test?.poolOptions?.workers !== undefined) {
    return {
      rawWorkersOptions: config.test.poolOptions.workers,
      sourceLabel: "test.poolOptions.workers"
    };
  }

  return {
    rawWorkersOptions: {},
    sourceLabel: "default workers options"
  };
}

function extractWorkersOptions(
  config: WorkersUserConfig,
  allowAsyncWorkersFunction: boolean,
  configDirectory: string
): {
  flattenedConfig: RstestConfig;
  workersOptions: WorkersPoolOptions;
} {
  const { workers, test, ...rest } = config as WorkersUserConfig & {
    [key: string]: unknown;
  };

  const flattenedConfig: RstestConfig = {
    ...(test as Record<string, unknown> | undefined),
    ...(rest as RstestConfig)
  };

  const { rawWorkersOptions, sourceLabel } = selectRawWorkersOptions(config);

  if (typeof rawWorkersOptions !== "function") {
    return {
      flattenedConfig,
      workersOptions: normalizeWorkersPaths(
        ensureWorkersOptionsObject(rawWorkersOptions, sourceLabel),
        configDirectory
      )
    };
  }

  const resolved = rawWorkersOptions({ inject: createInject() });
  if (isPromiseLike<WorkersPoolOptions>(resolved)) {
    if (!allowAsyncWorkersFunction) {
      throw new TypeError(
        "Async function-valued workers options require an async config export. " +
          "Wrap your exported workers config in an async function."
      );
    }
    throw new TypeError(
      "Internal invariant: async workers function should be handled in async extraction path."
    );
  }

  const workersOptions = normalizeWorkersPaths(
    ensureWorkersOptionsObject(resolved, `${sourceLabel}() return value`),
    configDirectory
  );
  return { flattenedConfig, workersOptions };
}

function ensureWorkersConfig<T extends RstestConfig>(rawConfig: WorkersUserConfig<T>): T {
  const configDirectory = getCallerConfigDirectory();
  const { flattenedConfig, workersOptions } = extractWorkersOptions(
    rawConfig,
    false,
    configDirectory
  );
  applyWorkersWiring(flattenedConfig, workersOptions);

  return flattenedConfig as T;
}

async function ensureWorkersConfigAsync<T extends RstestConfig>(
  rawConfig: WorkersUserConfig<T>
): Promise<T> {
  const configDirectory = getCallerConfigDirectory();
  const { workers, test, ...rest } = rawConfig as unknown as WorkersUserConfig & {
    [key: string]: unknown;
  };

  const flattenedConfig: RstestConfig = {
    ...(test as Record<string, unknown> | undefined),
    ...(rest as RstestConfig)
  };

  const { rawWorkersOptions, sourceLabel } = selectRawWorkersOptions(rawConfig);
  let workersOptions: WorkersPoolOptions;
  if (typeof rawWorkersOptions === "function") {
    workersOptions = normalizeWorkersPaths(
      ensureWorkersOptionsObject(
        await rawWorkersOptions({ inject: createInject() }),
        `${sourceLabel}() return value`
      ),
      configDirectory
    );
  } else {
    workersOptions = normalizeWorkersPaths(
      ensureWorkersOptionsObject(rawWorkersOptions, sourceLabel),
      configDirectory
    );
  }
  applyWorkersWiring(flattenedConfig, workersOptions);

  return flattenedConfig as T;
}

export function defineWorkersConfig(
  config: WorkersUserConfig<RstestConfig>
): WorkersUserConfig<RstestConfig>;
export function defineWorkersConfig(
  config: PromiseLike<WorkersUserConfig<RstestConfig>>
): Promise<WorkersUserConfig<RstestConfig>>;
export function defineWorkersConfig<
  TArgs extends unknown[],
  TThis
>(
  config: (
    this: TThis,
    ...args: TArgs
  ) =>
    | WorkersUserConfig<RstestConfig>
    | PromiseLike<WorkersUserConfig<RstestConfig>>
): (
  this: TThis,
  ...args: TArgs
) => WorkersUserConfig<RstestConfig> | Promise<WorkersUserConfig<RstestConfig>>;
export function defineWorkersConfig<
  TArgs extends unknown[] = unknown[],
  TThis = unknown
>(
  config: AnyConfigExport<WorkersUserConfig<RstestConfig>, TArgs, TThis>
): AnyConfigExport<WorkersUserConfig<RstestConfig>, TArgs, TThis> {
  if (typeof config === "function") {
    const fn = config as (
      this: TThis,
      ...args: TArgs
    ) =>
      | WorkersUserConfig<RstestConfig>
      | PromiseLike<WorkersUserConfig<RstestConfig>>;
    return (function (this: TThis, ...args: TArgs) {
      const value = fn.apply(this, args);
      if (isPromiseLike<WorkersUserConfig<RstestConfig>>(value)) {
        return Promise.resolve(value).then((resolved) =>
          ensureWorkersConfigAsync(resolved as WorkersUserConfig<RstestConfig>)
        );
      }
      return ensureWorkersConfig(value as WorkersUserConfig<RstestConfig>);
    }) as (
      this: TThis,
      ...args: TArgs
    ) => WorkersUserConfig<RstestConfig> | Promise<WorkersUserConfig<RstestConfig>>;
  }

  if (isPromiseLike<WorkersUserConfig<RstestConfig>>(config)) {
    return Promise.resolve(config).then((value) =>
      ensureWorkersConfigAsync(value as WorkersUserConfig<RstestConfig>)
    );
  }

  return ensureWorkersConfig(config as WorkersUserConfig<RstestConfig>);
}

export const defineWorkersProject = defineWorkersConfig;

export * from "./d1";
export * from "./pages";

export type {
  AnyConfigExport,
  WorkerPoolOptionsContext,
  WorkersPoolOptionsInput,
  WorkersPoolOptions,
  WorkersUserConfig,
  WorkersWranglerOptions
} from "./types";
