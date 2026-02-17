import { describe, expect, test } from "@rstest/core";
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  waitOnExecutionContext
} from "../src/cloudflare-test/events";
import { applyD1Migrations } from "../src/cloudflare-test/d1";

describe("cloudflare:test helper utilities", () => {
  test("waitOnExecutionContext resolves waitUntil promises", async () => {
    const ctx = createExecutionContext();
    const calls: string[] = [];

    ctx.waitUntil(
      Promise.resolve().then(() => {
        calls.push("one");
      })
    );
    ctx.waitUntil(
      Promise.resolve().then(() => {
        calls.push("two");
      })
    );

    await waitOnExecutionContext(ctx);
    expect(calls).toEqual(["one", "two"]);
  });

  test("queue helpers collect ack/retry results", async () => {
    const batch = createMessageBatch("jobs", [
      { id: "a", timestamp: Date.now(), body: { one: 1 }, attempts: 1 },
      { id: "b", timestamp: Date.now(), body: { two: 2 }, attempts: 2 }
    ]);
    batch.messages[0]!.ack();
    batch.messages[1]!.retry();

    const ctx = createExecutionContext();
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(["a"]);
    expect(result.retryMessages).toEqual([{ msgId: "b" }]);
    expect(result.ackAll).toBe(false);
  });

  test("scheduled controller exposes normalized values", () => {
    const controller = createScheduledController({ cron: "0 * * * *", scheduledTime: 123 });
    expect(controller.cron).toBe("0 * * * *");
    expect(controller.scheduledTime).toBe(123);
  });

  test("applyD1Migrations runs only unapplied migrations", async () => {
    const executed: string[] = [];
    const seen = new Set<string>();

    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            const name = String(args[0]);
            return {
              first: async () => (seen.has(name) ? { name } : null)
            };
          },
          async run() {
            executed.push(sql);
            const match = sql.match(/INSERT INTO d1_migrations\(name\) VALUES \('([^']+)'\)/);
            if (match?.[1]) {
              seen.add(match[1]);
            }
          }
        };
      }
    };

    await applyD1Migrations(db as any, [
      { name: "001_init", queries: ["CREATE TABLE users(id INTEGER PRIMARY KEY)"] },
      { name: "002_more", queries: ["ALTER TABLE users ADD COLUMN name TEXT"] }
    ]);

    await applyD1Migrations(db as any, [
      { name: "001_init", queries: ["CREATE TABLE users(id INTEGER PRIMARY KEY)"] },
      { name: "002_more", queries: ["ALTER TABLE users ADD COLUMN name TEXT"] }
    ]);

    expect(executed.filter((sql) => sql.includes("CREATE TABLE users")).length).toBe(1);
    expect(executed.filter((sql) => sql.includes("ALTER TABLE users")).length).toBe(1);
  });
});
