import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "@rstest/core";
import { buildPagesASSETSBinding, readD1Migrations } from "../src/config/index";

describe("config utilities", () => {
  test("readD1Migrations sorts by migration number and splits statements", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-d1-"));
    await fs.writeFile(
      path.join(tempDir, "2_add_name.sql"),
      `
        ALTER TABLE users ADD COLUMN name TEXT;
      `
    );
    await fs.writeFile(
      path.join(tempDir, "1_init.sql"),
      `
        CREATE TABLE users(id INTEGER PRIMARY KEY);
        CREATE TABLE posts(id INTEGER PRIMARY KEY);
      `
    );
    await fs.writeFile(
      path.join(tempDir, "misc.sql"),
      `
        CREATE INDEX IF NOT EXISTS idx_users_name ON users(name);
      `
    );

    const migrations = await readD1Migrations(tempDir);
    expect(migrations.map((migration) => migration.name)).toEqual([
      "1_init.sql",
      "2_add_name.sql",
      "misc.sql"
    ]);
    expect(migrations[0]?.queries.length).toBe(2);
    expect(migrations[0]?.queries[0]).toContain("CREATE TABLE users");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("buildPagesASSETSBinding serves static files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rstest-workers-assets-"));
    await fs.writeFile(path.join(tempDir, "index.html"), "<h1>Hello Pages</h1>");

    const assetsBinding = await buildPagesASSETSBinding(tempDir);
    let response = await assetsBinding(new Request("http://example.com/index.html"));
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      response = await assetsBinding(
        new Request(`http://example.com${location ?? "/index.html/"}`)
      );
    }

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Hello Pages");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("readD1Migrations throws on non-string input", async () => {
    await expect(
      readD1Migrations(123 as unknown as string)
    ).rejects.toThrow(
      "Failed to execute 'readD1Migrations': parameter 1 is not of type 'string'."
    );
  });

  test("buildPagesASSETSBinding throws on non-string input", async () => {
    await expect(
      buildPagesASSETSBinding(123 as unknown as string)
    ).rejects.toThrow(
      "Failed to execute 'buildPagesASSETSBinding': parameter 1 is not of type 'string'."
    );
  });
});
