import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RsbuildPlugin } from "@rstest/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLOUDFLARE_TEST_MODULE_PATH = path.resolve(__dirname, "../cloudflare-test/index.js");

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
    name: "@cloudflare/rstest-pool-workers:config",
    setup(api) {
      api.modifyEnvironmentConfig((config, { mergeEnvironmentConfig }) => {
        const next = mergeEnvironmentConfig(config, {
          resolve: {
            alias: {
              "cloudflare:test": CLOUDFLARE_TEST_MODULE_PATH,
              "cloudflare:test-internal": CLOUDFLARE_TEST_MODULE_PATH
            }
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
