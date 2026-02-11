import fs from "node:fs";
import path from "node:path";
import type { D1Migration } from "../cloudflare-test/d1";

/**
 * Reads all `.sql` migrations from a directory and splits them into executable
 * D1 queries using Wrangler's SQL splitter.
 */
export async function readD1Migrations(migrationsPath: string): Promise<D1Migration[]> {
  if (typeof migrationsPath !== "string") {
    throw new TypeError(
      "Failed to execute 'readD1Migrations': parameter 1 is not of type 'string'."
    );
  }

  const { unstable_splitSqlQuery } = await import("wrangler");
  const names = fs
    .readdirSync(migrationsPath)
    .filter((name) => name.endsWith(".sql"));

  names.sort((a, b) => {
    const left = Number.parseInt(a.split("_")[0] ?? "", 10);
    const right = Number.parseInt(b.split("_")[0] ?? "", 10);

    if (Number.isNaN(left) && Number.isNaN(right)) {
      return a.localeCompare(b);
    }
    if (Number.isNaN(left)) {
      return 1;
    }
    if (Number.isNaN(right)) {
      return -1;
    }
    return left - right;
  });

  return names.map((name) => {
    const migrationPath = path.join(migrationsPath, name);
    const migrationSql = fs.readFileSync(migrationPath, "utf8");
    const queries = unstable_splitSqlQuery(migrationSql);
    return { name, queries };
  });
}

export type { D1Migration };
