import { afterEach, beforeEach } from "@rstest/core";
import { getWorkersRuntimeState } from "./state";

const SETUP_FLAG = Symbol.for("@cloudflare/rstest-pool-workers/setup-installed");

type SetupHolder = {
  [SETUP_FLAG]?: boolean;
};

async function installSetup(): Promise<void> {
  const holder = globalThis as SetupHolder;
  if (holder[SETUP_FLAG]) {
    return;
  }
  holder[SETUP_FLAG] = true;

  const runtime = getWorkersRuntimeState();
  await runtime.setup();

  beforeEach(async () => {
    await runtime.resetFetchMock();
    await runtime.pushStorageSnapshot();
  });

  afterEach(async () => {
    await runtime.popStorageSnapshot();
  });

  process.once("beforeExit", () => {
    void runtime.teardown();
  });
}

await installSetup();
