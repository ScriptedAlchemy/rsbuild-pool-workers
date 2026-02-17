# `@cloudflare/rstest-pool-workers`

Cloudflare Workers integration for [Rstest](https://rstest.rs/).

This package ports the core ideas of `@cloudflare/vitest-pool-workers` to an
Rstest-native plugin model, using:

- `defineWorkersConfig()` / `defineWorkersProject()` helpers
- automatic Rsbuild plugin wiring
- Miniflare runtime management
- `cloudflare:test` APIs for worker-focused tests

## Install

```bash
pnpm add -D @cloudflare/rstest-pool-workers @rstest/core
```

## Usage

```ts
import { defineWorkersConfig } from "@cloudflare/rstest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        singleWorker: true,
        isolatedStorage: true,
        wrangler: {
          configPath: "./wrangler.jsonc"
        }
      }
    }
  }
});
```

`defineWorkersProject()` is an alias of `defineWorkersConfig()` and supports the
same options/export shapes (object, promise, sync function, async function),
including top-level `workers` configuration:

```ts
import { defineWorkersProject } from "@cloudflare/rstest-pool-workers/config";

export default defineWorkersProject({
  include: ["./test/**/*.test.ts"],
  workers: {
    main: "./src/index.ts"
  }
});

// function-valued workers options + inject() are also supported:
export const withInjectedWorkers = defineWorkersProject({
  workers: ({ inject }) => ({
    main: "./src/index.ts",
    miniflare: {
      bindings: {
        API_ORIGIN: inject("API_ORIGIN")
      }
    }
  })
});

// promise exports can also use top-level workers functions:
export const withPromiseTopLevelWorkers = defineWorkersProject(
  Promise.resolve({
    workers: ({ inject }) => ({
      main: "./src/index.ts",
      miniflare: {
        bindings: {
          API_ORIGIN: inject("API_ORIGIN")
        }
      }
    })
  })
);
```

Then in tests:

```ts
import { env, SELF } from "cloudflare:test";
import { expect, test } from "@rstest/core";

test("integration", async () => {
  const response = await SELF.fetch("http://localhost/");
  expect(response.status).toBe(200);
  expect(env).toBeTruthy();
});

test("Request objects are also supported", async () => {
  const request = new Request("http://localhost/health", { method: "POST" });
  const response = await SELF.fetch(request);
  expect(response.status).toBe(200);
});

test("relative string paths are normalized to localhost", async () => {
  const response = await SELF.fetch("health");
  expect(response.status).toBe(200);
});
```

Durable Object RPC helper example:

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "@rstest/core";

test("can call RPC methods on a Durable Object instance", async () => {
  const id = (env.COUNTER as DurableObjectNamespace).idFromName("singleton");
  const stub = (env.COUNTER as DurableObjectNamespace).get(id);

  const value = await runInDurableObject<{ incrementAndGet: () => Promise<number> }, number>(
    stub,
    (instance) => instance.incrementAndGet()
  );

  expect(value).toBe(1);
});
```

## Config utilities

`@cloudflare/rstest-pool-workers/config` also exports helpers aligned with the
Cloudflare Workers test ecosystem:

- `readD1Migrations(migrationsPath)` — reads and splits SQL migrations via Wrangler.
- `buildPagesASSETSBinding(assetsPath)` — builds a Pages `ASSETS` binding for tests.

Example:

```ts
import {
  buildPagesASSETSBinding,
  readD1Migrations
} from "@cloudflare/rstest-pool-workers/config";
```

## Notes

- TypeScript worker entrypoints in `workers.main` (`.ts`, `.tsx`, `.mts`, `.cts`) are bundled for Miniflare runtime.
- relative `workers.main` and `workers.wrangler.configPath` values are resolved from the calling config file directory.
- compatibility flag prerequisites mirror Workers test-runtime requirements:
  - `export_commonjs_namespace` is rejected as incompatible,
  - if `workers.miniflare.compatibilityDate` is older than `2022-10-31`, include `export_commonjs_default`.
  - `workers.miniflare.compatibilityFlags` must be an array of strings, and `workers.miniflare.compatibilityDate` must be a valid `YYYY-MM-DD` calendar date string.
  - surrounding whitespace in `workers.miniflare.compatibilityDate` is trimmed before validation.
  - old-date compatibility checks (for required `export_commonjs_default`) are evaluated after compatibilityDate normalization.
  - duplicate compatibility flags are normalized away during runtime option resolution (preserving first-seen order), and surrounding whitespace is trimmed.
  - empty compatibility flag entries are rejected.
  - compatibility flag requirement/incompatibility checks run against normalized flag values (for example trimmed `export_commonjs_default`/`export_commonjs_namespace` entries).
  - compatibility validation diagnostics include received type details for malformed flag/date inputs (including `null`, `array`, and `object` labels where applicable).
  - missing `workers.miniflare.compatibilityFlags` values normalize to an empty array.
- `cloudflare:test-internal` is also aliased to the same runtime helpers for compatibility.
- `env` bindings exposed by `cloudflare:test` are read-only.
- `fetchMock` state is reset before each test case via runtime setup hooks.
- `singleWorker` defaults to `true` (shared runtime with snapshot-based storage isolation); when set to `false`, the runtime recreates the worker isolate before each test case for fresh global state.
- The package exports `WORKERS_RSBUILD_PLUGIN_NAME` for plugin detection/deduplication scenarios.
- if you preinstall `workersRsbuildPlugin()` yourself, config helpers dedupe it across sync/async/promise/promise-like exports (including function exports returning thenables), with `plugins` provided as a single value or mixed arrays (for example with falsey entries).
- `test.poolOptions.workers` can be an object or function. Function mode supports:
  - `inject(key)` via `RSTEST_INJECT_<key>` / `<key>` environment variables (including promise/promise-like export paths and thenable workers-function returns).
  - when both forms are set, scoped `RSTEST_INJECT_<key>` values take precedence over direct `<key>` fallback values.
  - async workers functions when `defineWorkersConfig()` or `defineWorkersProject()` is used with an async config export.
  - Promise-like return values (thenables), which are normalized like async results.
- top-level `workers` supports the same object/function forms and `inject()` behavior, including scoped `RSTEST_INJECT_<key>` precedence over direct `<key>` fallback values.
- when top-level `workers` is explicitly `undefined`, it is treated as absent and nested `test.poolOptions.workers` (object or function, if provided) is used.
- direct-env fallback (`inject("KEY")` reading from `KEY`) is supported across sync/async/promise/promise-like config export forms for both nested and top-level workers functions.
- errors thrown or rejected from config exports or workers option functions (including promise, promise-like/thenable branches, and function export return variants) propagate with actionable messages.
- invalid workers options shape validation is source-aware across all export forms (object, promise/promise-like, and sync/async/promise/thenable function exports):
  - raw invalid values are reported from `workers` or `test.poolOptions.workers` (for example: `...received null|array|string|number|boolean`).
  - function-return invalid values are reported from `workers() return value` or `test.poolOptions.workers() return value` (for example: `...received undefined|string|number|boolean|array|null`).
- if both top-level `workers` and `test.poolOptions.workers` are provided, top-level `workers` takes precedence (including sync/async/promise/promise-like config export forms), and nested function-valued workers options are not evaluated.
- `defineWorkersConfig()` supports object, promise/promise-like, sync function, and async function config exports.
- when using function exports (sync, async, or sync functions returning promises/promise-like values), config function arguments and invocation context (`this`) from rstest/rsbuild are forwarded unchanged.
- function exports may also return Promise-like values (thenables); helpers normalize them before applying workers wiring.
- function export failures (sync throw, async rejection, promise rejection, thenable rejection) propagate as test-run failures with surfaced messages.
- repository maintainers can run `pnpm test:matrix` to execute regression guardrails only (coverage parity, no focused/skipped/todo executable tests, guarded suite list invariants, and parser-cache correctness checks).
- CI and preview workflows run typecheck/build quality gates before publishing artifacts; both also enforce the matrix guard for regression coverage drift.
- on constrained Linux hosts, repeated Miniflare/workerd runs may exhaust process/thread limits; if you hit `Worker exited unexpectedly` or `Resource temporarily unavailable`, prefer focused test runs and `pnpm test:matrix` while freeing host resources. If rspack/rstest panics with thread-spawn errors, running with `RAYON_NUM_THREADS=1` can help (`RAYON_NUM_THREADS=1 pnpm test:matrix`).
- default `rstest.config.ts` include patterns are kept in sync with matrix-supported test suffixes (`.test.ts`, `.test.tsx`, `.test.mts`, `.test.cts`, `.test.js`, `.test.jsx`, `.test.mjs`, `.test.cjs`) via guard tests.
- matrix include-parser guards for `rstest.config.ts` cover `defineConfig` calls through direct import, alias import, default-import namespace access, TypeScript `import = require` bindings, namespace/property or namespace-element access, direct `require("@rstest/core").defineConfig(...)`/`["defineConfig"](...)` calls, and CommonJS `require("@rstest/core")` namespace/destructured bindings.
- `defineConfig` call matching is scoped to symbols bound from `@rstest/core`, preventing unrelated local helpers from overriding include extraction.
- include extraction is intentionally literal-only: `include` may be an array of string literals (including static spread array literals) or a single string literal (including quoted/computed `"include"` property keys); dynamic/non-literal values are ignored.
- object spread entries in recognized config objects are handled conservatively: static object-literal spreads can override `include`, while dynamic spreads overriding `include` produce an empty extraction result unless later explicit `include` assignments appear.
- non-assignment `include` members (for example getters/setters/methods) are treated as non-literal overrides unless a later explicit assignment replaces them.
- when `include` is assigned multiple times inside a recognized `defineConfig({...})` object, extraction follows last-assignment object-literal semantics.
- heuristic include fallback scanning is only used when no recognized `defineConfig` call is present, preventing unrelated `include` literals from shadowing authoritative `defineConfig(...)` parsing.
- parser regression fixtures explicitly cover config-file extension variants (`.js`, `.mjs`, `.cjs`, `.mts`, `.cts`) for consistent include extraction behavior.
- when recognized `defineConfig` calls appear in top-level exports (`export default`, `module.exports`, `exports.default`, `module.exports.default`), those exported call sites (including simple identifier references to top-level `defineConfig(...)` results and chained assignment forms) are preferred over non-export helper calls.
- export-target detection accepts equivalent element-access forms with string/no-substitution-template keys (for example `module["exports"]`, `module[\`exports\`]`, `exports["default"]`, and `exports[\`default\`]`).
- for repeated top-level export assignments, include extraction follows last-assignment statement order.
- `cloudflare:test` currently supports:
  - `env`
  - `SELF.fetch()` (string, `URL`, and `Request` inputs; relative/bare strings are normalized to `http://localhost/...`; `Request` + `init` override semantics are preserved) and `SELF.scheduled()`
  - `fetchMock`
  - `listDurableObjectIds` (deterministic lexicographic ordering)
    - requires the namespace to resolve to a configured Miniflare `durableObjects` designator
    - designators must resolve to a non-empty class name (`"ClassName"` or object-form `className`)
    - empty/whitespace-only `scriptName` and `unsafeUniqueKey` values are ignored during namespace key resolution
  - `runInDurableObject` for RPC-callable instance methods (for classes extending `DurableObject`) on stubs from the same worker isolate
    - when a state-like `ctx/state` object is exposed on the stub, callback state receives that object directly (including common `storage` helpers like `get`/`put`/`list`/`delete`/`setAlarm`, transaction helpers, and alarm/bookmark APIs when available)
  - `runDurableObjectAlarm` for same-isolate Durable Object stubs (follows the same same-isolate fallback checks as `runInDurableObject`)
    - when a state-like `ctx/state` object is exposed on the stub, scheduled-alarm semantics are respected (`getAlarm()`/best-effort `deleteAlarm()`), returning `false` when no alarm is scheduled
    - with state-like scheduling data, a scheduled alarm still returns `true` even if no callable `alarm()` method is exposed
    - when no state-like object is exposed, it falls back to direct `alarm()` invocation behavior
    - reserved-RPC alarm diagnostics are translated to actionable guidance only for alarm-specific reserved-method failures that include RPC/callability hints; unrelated accessor errors still propagate
  - Durable Object helper validations intentionally reject plain-object lookalikes (for stubs/namespaces, constructor identity must be non-`Object` and method contracts must match)
  - same-worker Durable Object enforcement prefers runtime durable-object binding metadata and excludes bindings configured with non-empty `scriptName` values (remote worker designators), with fallback to environment namespace discovery if metadata lookup is unavailable/invalid (mismatched stubs still reject)
  - event/queue helpers and D1 migration helper utilities
- Some advanced `cloudflare:test` APIs are currently stubs in Rstest mode:
  - Durable Object state access within `runInDurableObject` callbacks when runtime does not expose a state-like `ctx/state` object on the Durable Object stub
  - invoking `runDurableObjectAlarm()` against runtime Durable Object stubs that expose reserved `alarm()` RPC behavior (an actionable unsupported error is thrown)
  - workflow introspection helpers (argument types are validated before emitting unsupported guidance)

