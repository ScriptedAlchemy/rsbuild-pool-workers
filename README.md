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

