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
- `cloudflare:test-internal` is also aliased to the same runtime helpers for compatibility.
- `env` bindings exposed by `cloudflare:test` are read-only.
- `fetchMock` state is reset before each test case via runtime setup hooks.
- The package exports `WORKERS_RSBUILD_PLUGIN_NAME` for plugin detection/deduplication scenarios.
- if you preinstall `workersRsbuildPlugin()` yourself, config helpers dedupe it across sync/async/promise/promise-like exports (including function exports returning thenables), with `plugins` provided as a single value or mixed arrays (for example with falsey entries).
- `test.poolOptions.workers` can be an object or function. Function mode supports:
  - `inject(key)` via `RSTEST_INJECT_<key>` / `<key>` environment variables (including promise/promise-like export paths and thenable workers-function returns).
  - when both forms are set, scoped `RSTEST_INJECT_<key>` values take precedence over direct `<key>` fallback values.
  - async workers functions when `defineWorkersConfig()` or `defineWorkersProject()` is used with an async config export.
  - Promise-like return values (thenables), which are normalized like async results.
- top-level `workers` supports the same object/function forms and `inject()` behavior, including scoped `RSTEST_INJECT_<key>` precedence over direct `<key>` fallback values.
- direct-env fallback (`inject("KEY")` reading from `KEY`) is supported across sync/async/promise/promise-like config export forms for both nested and top-level workers functions.
- errors thrown or rejected from config exports or workers option functions (including promise, promise-like/thenable branches, and function export return variants) propagate with actionable messages.
- if both top-level `workers` and `test.poolOptions.workers` are provided, top-level `workers` takes precedence (including sync/async/promise/promise-like config export forms), and nested function-valued workers options are not evaluated.
- `defineWorkersConfig()` supports object, promise/promise-like, sync function, and async function config exports.
- when using function exports (sync, async, or sync functions returning promises/promise-like values), config function arguments and invocation context (`this`) from rstest/rsbuild are forwarded unchanged.
- function exports may also return Promise-like values (thenables); helpers normalize them before applying workers wiring.
- function export failures (sync throw, async rejection, promise rejection, thenable rejection) propagate as test-run failures with surfaced messages.
- `cloudflare:test` currently supports:
  - `env`
  - `SELF.fetch()` (string, `URL`, and `Request` inputs; relative/bare strings are normalized to `http://localhost/...`; `Request` + `init` override semantics are preserved) and `SELF.scheduled()`
  - `fetchMock`
  - `listDurableObjectIds` (deterministic lexicographic ordering)
  - `runInDurableObject` for RPC-callable instance methods (for classes extending `DurableObject`)
  - event/queue helpers and D1 migration helper utilities
- Some advanced `cloudflare:test` APIs are currently stubs in Rstest mode:
  - Durable Object state access within `runInDurableObject` callbacks
  - `runDurableObjectAlarm`
  - workflow introspection helpers

