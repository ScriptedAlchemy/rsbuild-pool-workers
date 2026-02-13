import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build as esbuildBuild } from "esbuild";
import { mergeWorkerOptions } from "miniflare";
import { z } from "zod";

declare const __RSTEST_POOL_WORKERS_OPTIONS_JSON__: string;

let workersOptionsOverrideForTesting: RawWorkersRuntimeOptions | undefined;

const WorkersOptionsSchema = z.object({
  main: z.string().optional(),
  singleWorker: z.boolean().default(true),
  isolatedStorage: z.boolean().default(true),
  remoteBindings: z.boolean().default(true),
  additionalExports: z
    .record(
      z.string(),
      z.union([
        z.literal("WorkerEntrypoint"),
        z.literal("DurableObject"),
        z.literal("WorkflowEntrypoint")
      ])
    )
    .default({}),
  miniflare: z.record(z.string(), z.unknown()).optional(),
  wrangler: z
    .object({
      configPath: z.string().optional(),
      environment: z.string().optional()
    })
    .optional()
});

export type RawWorkersRuntimeOptions = z.input<typeof WorkersOptionsSchema>;
export type WorkersRuntimeOptions = z.output<typeof WorkersOptionsSchema> & {
  miniflare: Record<string, unknown>;
};

const TYPESCRIPT_ENTRYPOINT_REGEXP = /\.(?:cts|mts|ts|tsx)$/i;

function parseDateOrThrow(dateValue: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    throw new Error(`Invalid compatibilityDate "${dateValue}".`);
  }

  const parsed = new Date(`${dateValue}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid compatibilityDate "${dateValue}".`);
  }
  if (parsed.toISOString().slice(0, 10) !== dateValue) {
    throw new Error(`Invalid compatibilityDate "${dateValue}".`);
  }
  return parsed;
}

function isDateAtLeast(compatibilityDate: string | undefined, minDate: string): boolean {
  if (!compatibilityDate) {
    return false;
  }
  return parseDateOrThrow(compatibilityDate) >= parseDateOrThrow(minDate);
}

function assertCompatibilityFlags(options: WorkersRuntimeOptions): void {
  const flagsValue = options.miniflare.compatibilityFlags;
  const optionsPath = "workers.miniflare";
  if (flagsValue !== undefined && !Array.isArray(flagsValue)) {
    throw new Error(
      `${optionsPath}.compatibilityFlags must be an array of strings.`
    );
  }
  const flags = (flagsValue ?? []) as unknown[];
  const nonStringFlag = flags.find((flag) => typeof flag !== "string");
  if (nonStringFlag !== undefined) {
    throw new Error(
      `${optionsPath}.compatibilityFlags must be an array of strings.`
    );
  }
  const normalizedFlags = Array.from(
    new Set((flags as string[]).map((flag) => flag.trim()))
  );
  if (normalizedFlags.some((flag) => flag.length === 0)) {
    throw new Error(
      `${optionsPath}.compatibilityFlags must not contain empty entries.`
    );
  }
  options.miniflare.compatibilityFlags = normalizedFlags;

  const compatibilityDateValue = options.miniflare.compatibilityDate;
  if (
    compatibilityDateValue !== undefined &&
    typeof compatibilityDateValue !== "string"
  ) {
    throw new Error(
      `${optionsPath}.compatibilityDate must be a string in YYYY-MM-DD format.`
    );
  }

  const requiredEnableFlag = "export_commonjs_default";
  const incompatibleDisableFlag = "export_commonjs_namespace";
  const defaultOnDate = "2022-10-31";

  if (normalizedFlags.includes(incompatibleDisableFlag)) {
    throw new Error(
      `${optionsPath}.compatibilityFlags must not contain "${incompatibleDisableFlag}". ` +
        `This flag is incompatible with @cloudflare/rstest-pool-workers.`
    );
  }

  const hasEnableFlag = normalizedFlags.includes(requiredEnableFlag);
  const hasSufficientDate = isDateAtLeast(
    compatibilityDateValue,
    defaultOnDate
  );
  if (!hasEnableFlag && !hasSufficientDate) {
    throw new Error(
      `${optionsPath}.compatibilityFlags must contain "${requiredEnableFlag}", ` +
        `or ${optionsPath}.compatibilityDate must be >= "${defaultOnDate}". ` +
        `This flag is required to use @cloudflare/rstest-pool-workers.`
    );
  }
}

async function bundleWorkerEntrypoint(mainPath: string): Promise<string> {
  const result = await esbuildBuild({
    entryPoints: [mainPath],
    absWorkingDir: path.dirname(mainPath),
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: "inline",
    legalComments: "none",
    charset: "utf8",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "workerd:*", "node:*"],
    outfile: path.join(os.tmpdir(), "worker-bundle.mjs")
  });

  const file = result.outputFiles.find((entry) => entry.path.endsWith(".mjs"));
  if (!file) {
    throw new Error(`Failed to bundle worker entrypoint ${mainPath}: no output file produced.`);
  }

  return file.text;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function readDefineJson(): string {
  try {
    return __RSTEST_POOL_WORKERS_OPTIONS_JSON__;
  } catch {
    return "{}";
  }
}

export function readRawWorkersOptionsFromDefine(): RawWorkersRuntimeOptions {
  if (workersOptionsOverrideForTesting) {
    return workersOptionsOverrideForTesting;
  }

  const json = readDefineJson();
  if (!json) {
    return {};
  }

  const parsed = JSON.parse(json) as RawWorkersRuntimeOptions;
  return parsed;
}

/**
 * Testing helper to bypass compile-time define values.
 * Do not use in production runtime code.
 */
export function setWorkersRuntimeOptionsForTesting(
  options: RawWorkersRuntimeOptions | undefined
): void {
  workersOptionsOverrideForTesting = options;
}

function resolvePathMaybe(root: string, maybePath: string | undefined): string | undefined {
  if (!maybePath) {
    return undefined;
  }
  if (path.isAbsolute(maybePath)) {
    return maybePath;
  }
  return path.resolve(root, maybePath);
}

export async function resolveRuntimeOptions(
  rawOptions: RawWorkersRuntimeOptions,
  rootPath: string = process.cwd()
): Promise<WorkersRuntimeOptions> {
  const parsed = WorkersOptionsSchema.parse(rawOptions);
  const resolved: WorkersRuntimeOptions = {
    ...parsed,
    main: resolvePathMaybe(rootPath, parsed.main),
    miniflare: { ...(parsed.miniflare ?? {}) },
    wrangler: parsed.wrangler
      ? {
          ...parsed.wrangler,
          configPath: resolvePathMaybe(rootPath, parsed.wrangler.configPath)
        }
      : undefined
  };

  if (resolved.wrangler?.configPath) {
    const wrangler = await import("wrangler");
    const { workerOptions, main } = wrangler.unstable_getMiniflareWorkerOptions(
      resolved.wrangler.configPath,
      resolved.wrangler.environment,
      {}
    );

    resolved.main ??= resolvePathMaybe(rootPath, main);
    resolved.miniflare = mergeWorkerOptions(workerOptions, resolved.miniflare);
  }

  const hasExplicitScript =
    "script" in resolved.miniflare ||
    "scriptPath" in resolved.miniflare ||
    "modules" in resolved.miniflare;

  if (!hasExplicitScript && resolved.main) {
    if (
      TYPESCRIPT_ENTRYPOINT_REGEXP.test(resolved.main) &&
      (await fileExists(resolved.main))
    ) {
      resolved.miniflare.modules = true;
      resolved.miniflare.script = await bundleWorkerEntrypoint(resolved.main);
    } else {
      resolved.miniflare.modules = true;
      resolved.miniflare.scriptPath = resolved.main;
    }
  }

  if (!("compatibilityDate" in resolved.miniflare)) {
    resolved.miniflare.compatibilityDate = "2024-01-01";
  }

  assertCompatibilityFlags(resolved);

  return resolved;
}
