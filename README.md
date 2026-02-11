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

Then in tests:

```ts
import { env, SELF } from "cloudflare:test";
import { expect, test } from "@rstest/core";

test("integration", async () => {
  const response = await SELF.fetch("http://localhost/");
  expect(response.status).toBe(200);
  expect(env).toBeTruthy();
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

- TypeScript worker entrypoints in `workers.main` are bundled for Miniflare runtime.
- `test.poolOptions.workers` can be an object or function. Function mode supports:
  - `inject(key)` via `RSTEST_INJECT_<key>` / `<key>` environment variables.
- `cloudflare:test` currently supports:
  - `env`
  - `SELF.fetch()` and `SELF.scheduled()`
  - `fetchMock`
  - `listDurableObjectIds`
  - `runInDurableObject` for RPC-callable instance methods
  - event/queue helpers and D1 migration helper utilities
- Some advanced `cloudflare:test` APIs are currently stubs in Rstest mode:
  - Durable Object state access within `runInDurableObject` callbacks
  - `runDurableObjectAlarm`
  - workflow introspection helpers

