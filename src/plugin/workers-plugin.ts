import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RsbuildPlugin } from "@rstest/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cloudflareTestJsPath = path.resolve(__dirname, "../cloudflare-test/index.js");
const cloudflareTestTsPath = path.resolve(__dirname, "../cloudflare-test/index.ts");
const CLOUDFLARE_TEST_MODULE_PATH = fs.existsSync(cloudflareTestJsPath)
  ? cloudflareTestJsPath
  : cloudflareTestTsPath;
const CLOUDFLARE_TEST_SPECIFIERS = [
  "cloudflare:test",
  "cloudflare:test-internal"
] as const;
export const WORKERS_RSBUILD_PLUGIN_NAME = "@cloudflare/rstest-pool-workers:config";

function ensureArrayIncludes<T>(array: T[], items: T[]): void {
  for (const item of items) {
    if (!array.includes(item)) {
      array.push(item);
    }
  }
}

function ensureArrayExcludes<T>(array: T[], items: T[]): void {
  for (let i = 0; i < array.length; i++) {
    if (items.includes(array[i]!)) {
      array.splice(i, 1);
      i--;
    }
  }
}

export function workersRsbuildPlugin(): RsbuildPlugin {
  return {
    name: WORKERS_RSBUILD_PLUGIN_NAME,
    setup(api) {
      api.resolve(({ resolveData }) => {
        if (CLOUDFLARE_TEST_SPECIFIERS.includes(resolveData.request as (typeof CLOUDFLARE_TEST_SPECIFIERS)[number])) {
          resolveData.request = CLOUDFLARE_TEST_MODULE_PATH;
        }
      });

      api.modifyEnvironmentConfig((config, { mergeEnvironmentConfig }) => {
        const alias = Object.fromEntries(
          CLOUDFLARE_TEST_SPECIFIERS.map((specifier) => [
            specifier,
            CLOUDFLARE_TEST_MODULE_PATH
          ])
        );
        const next = mergeEnvironmentConfig(config, {
          resolve: {
            alias
          }
        });

        const resolveConfig = (next.resolve ?? {}) as { conditions?: string[] };
        const conditions = resolveConfig.conditions ?? [];
        ensureArrayExcludes(conditions, ["node"]);
        ensureArrayIncludes(conditions, ["workerd", "worker", "browser"]);

        return {
          ...next,
          resolve: {
            ...(next.resolve ?? {}),
            conditions
          }
        };
      });
    }
  };
}
