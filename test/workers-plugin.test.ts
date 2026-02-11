import { describe, expect, test } from "@rstest/core";
import {
  WORKERS_RSBUILD_PLUGIN_NAME,
  workersRsbuildPlugin
} from "../src/plugin/workers-plugin";

describe("workersRsbuildPlugin", () => {
  test("registers module resolution aliases for cloudflare:test modules", () => {
    const plugin = workersRsbuildPlugin();
    expect(plugin.name).toBe(WORKERS_RSBUILD_PLUGIN_NAME);

    let resolveHook:
      | ((args: { resolveData: { request: string } }) => void)
      | undefined;
    let modifyEnvironmentConfigHook:
      | ((config: unknown, helpers: { mergeEnvironmentConfig: (...args: unknown[]) => unknown }) => unknown)
      | undefined;

    plugin.setup?.({
      resolve(callback: unknown) {
        resolveHook = callback as typeof resolveHook;
      },
      modifyEnvironmentConfig(callback: unknown) {
        modifyEnvironmentConfigHook = callback as typeof modifyEnvironmentConfigHook;
      }
    } as unknown as Parameters<NonNullable<typeof plugin.setup>>[0]);

    if (!resolveHook || !modifyEnvironmentConfigHook) {
      throw new Error("Expected plugin setup hooks to be registered");
    }

    const testResolveData = { request: "cloudflare:test" };
    resolveHook({ resolveData: testResolveData });
    expect(testResolveData.request).toContain("cloudflare-test/index.");

    const internalResolveData = { request: "cloudflare:test-internal" };
    resolveHook({ resolveData: internalResolveData });
    expect(internalResolveData.request).toContain("cloudflare-test/index.");

    const passthroughResolveData = { request: "other-module" };
    resolveHook({ resolveData: passthroughResolveData });
    expect(passthroughResolveData.request).toBe("other-module");
  });

  test("adds workerd resolve conditions and removes node", () => {
    const plugin = workersRsbuildPlugin();

    let modifyEnvironmentConfigHook:
      | ((config: unknown, helpers: { mergeEnvironmentConfig: (...args: unknown[]) => unknown }) => unknown)
      | undefined;

    plugin.setup?.({
      resolve() {},
      modifyEnvironmentConfig(callback: unknown) {
        modifyEnvironmentConfigHook = callback as typeof modifyEnvironmentConfigHook;
      }
    } as unknown as Parameters<NonNullable<typeof plugin.setup>>[0]);

    if (!modifyEnvironmentConfigHook) {
      throw new Error("Expected modifyEnvironmentConfig hook to be registered");
    }

    const mergeEnvironmentConfig = (base: unknown, extension: unknown) => {
      const baseObject = (base ?? {}) as Record<string, unknown>;
      const extensionObject = extension as Record<string, unknown>;
      return {
        ...baseObject,
        ...extensionObject,
        resolve: {
          ...(baseObject.resolve as Record<string, unknown> | undefined),
          ...(extensionObject.resolve as Record<string, unknown> | undefined),
          alias: {
            ...((baseObject.resolve as { alias?: Record<string, string> } | undefined)?.alias ?? {}),
            ...((extensionObject.resolve as { alias?: Record<string, string> } | undefined)?.alias ?? {})
          }
        }
      };
    };

    const initialConfig = {
      resolve: {
        conditions: ["node", "custom", "worker"]
      }
    };

    const result = modifyEnvironmentConfigHook(initialConfig, { mergeEnvironmentConfig }) as {
      resolve?: {
        alias?: Record<string, string>;
        conditions?: string[];
      };
    };

    const alias = result.resolve?.alias ?? {};
    expect(alias["cloudflare:test"]).toContain("cloudflare-test/index.");
    expect(alias["cloudflare:test-internal"]).toContain("cloudflare-test/index.");

    const conditions = result.resolve?.conditions ?? [];
    expect(conditions).toContain("custom");
    expect(conditions).toContain("workerd");
    expect(conditions).toContain("worker");
    expect(conditions).toContain("browser");
    expect(conditions).not.toContain("node");
    expect(conditions.filter((value) => value === "worker").length).toBe(1);
  });
});
