/// <reference path="../cloudflare-test/module-declarations.d.ts" />

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RstestConfig } from "@rstest/core";
import { workersRsbuildPlugin } from "../plugin/workers-plugin";
import {
  type AnyConfigExport,
  type WorkersPoolOptions,
  type WorkersUserConfig
} from "./types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SETUP_FILE_PATH = path.resolve(__dirname, "../runtime/setup.js");
export const WORKERS_OPTIONS_DEFINE_KEY = "__RSTEST_POOL_WORKERS_OPTIONS_JSON__";

function ensureArrayIncludes<T>(array: T[], items: T[]): void {
  for (const item of items) {
    if (!array.includes(item)) {
      array.push(item);
    }
  }
}

function extractWorkersOptions(config: WorkersUserConfig): {
  flattenedConfig: RstestConfig;
  workersOptions: WorkersPoolOptions;
} {
  const { workers, test, ...rest } = config as WorkersUserConfig & {
    [key: string]: unknown;
  };

  if (typeof test?.poolOptions?.workers === "function") {
    throw new TypeError(
      "Function-valued `test.poolOptions.workers` is not supported in Rstest mode. " +
        "Use a plain object for workers options."
    );
  }

  const flattenedConfig: RstestConfig = {
    ...(test as Record<string, unknown> | undefined),
    ...(rest as RstestConfig)
  };

  const workersOptions = workers ?? test?.poolOptions?.workers ?? {};
  return { flattenedConfig, workersOptions };
}

function ensureWorkersConfig<T extends RstestConfig>(rawConfig: WorkersUserConfig<T>): T {
  const { flattenedConfig, workersOptions } = extractWorkersOptions(rawConfig);

  flattenedConfig.plugins ??= [];
  flattenedConfig.plugins.push(workersRsbuildPlugin());

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

  return flattenedConfig as T;
}

export function defineWorkersConfig(
  config: WorkersUserConfig<RstestConfig>
): WorkersUserConfig<RstestConfig>;
export function defineWorkersConfig(
  config: Promise<WorkersUserConfig<RstestConfig>>
): Promise<WorkersUserConfig<RstestConfig>>;
export function defineWorkersConfig(
  config: () => WorkersUserConfig<RstestConfig> | Promise<WorkersUserConfig<RstestConfig>>
): () => WorkersUserConfig<RstestConfig> | Promise<WorkersUserConfig<RstestConfig>>;
export function defineWorkersConfig(
  config: AnyConfigExport<WorkersUserConfig<RstestConfig>>
): AnyConfigExport<WorkersUserConfig<RstestConfig>> {
  if (typeof config === "function") {
    const fn = config as () => WorkersUserConfig<RstestConfig> | Promise<WorkersUserConfig<RstestConfig>>;
    return (async () => ensureWorkersConfig(await fn())) as () => Promise<WorkersUserConfig<RstestConfig>>;
  }

  if (config instanceof Promise) {
    return config.then((value) => ensureWorkersConfig(value));
  }

  return ensureWorkersConfig(config);
}

export const defineWorkersProject = defineWorkersConfig;

export type {
  AnyConfigExport,
  WorkerPoolOptionsContext,
  WorkersPoolOptions,
  WorkersUserConfig,
  WorkersWranglerOptions
} from "./types";
