export interface D1Migration {
  name: string;
  queries: string[];
}

type D1PreparedStatement = {
  bind: (...args: unknown[]) => D1PreparedStatement;
  run: () => Promise<unknown>;
  first?: <T = unknown>() => Promise<T | null>;
  all?: <T = unknown>() => Promise<{ results: T[] }>;
};

type D1DatabaseLike = {
  prepare: (sql: string) => D1PreparedStatement;
};

async function runStatement(db: D1DatabaseLike, sql: string): Promise<void> {
  await db.prepare(sql).run();
}

export async function applyD1Migrations(
  db: D1DatabaseLike,
  migrations: D1Migration[],
  migrationsTableName = "d1_migrations"
): Promise<void> {
  await runStatement(
    db,
    `CREATE TABLE IF NOT EXISTS ${migrationsTableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  for (const migration of migrations) {
    const escapedName = migration.name.replaceAll("'", "''");
    const statement = db
      .prepare(`SELECT name FROM ${migrationsTableName} WHERE name = ? LIMIT 1`)
      .bind(migration.name);
    const existing = statement.first
      ? await statement.first<{ name: string }>()
      : ((await statement.all?.())?.results?.[0] as { name?: string } | undefined);

    if (existing?.name === migration.name) {
      continue;
    }

    for (const query of migration.queries) {
      await runStatement(db, query);
    }

    await runStatement(
      db,
      `INSERT INTO ${migrationsTableName}(name) VALUES ('${escapedName}')`
    );
  }
}
