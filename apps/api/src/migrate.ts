import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql, TransactionSql } from "postgres";
import { createSql } from "./db";
import { loadDatabaseEnv } from "./env";

const MIGRATIONS_DIR = join(import.meta.dir, "../migrations");
const UP_PATTERN = /^\d+_.+\.up\.sql$/;

type Migration = {
  version: string;
  upSql: string;
  downSql: string;
};

type Query = Sql | TransactionSql;

export async function loadMigrations(): Promise<Migration[]> {
  const names = await readdir(MIGRATIONS_DIR);
  const ups = names.filter((name) => UP_PATTERN.test(name)).sort();
  const migrations: Migration[] = [];

  for (const name of ups) {
    const version = name.slice(0, -".up.sql".length);
    const downName = `${version}.down.sql`;
    if (!names.includes(downName)) {
      throw new Error(`Missing down migration for ${version}`);
    }
    migrations.push({
      version,
      upSql: await readFile(join(MIGRATIONS_DIR, name), "utf8"),
      downSql: await readFile(join(MIGRATIONS_DIR, downName), "utf8"),
    });
  }

  return migrations;
}

async function ensureMigrationsTable(sql: Sql): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `;
}

async function appliedVersions(sql: Query): Promise<string[]> {
  const rows = await sql<{ version: string }[]>`
    select version from schema_migrations order by version
  `;
  return rows.map((row) => row.version);
}

async function domainRowCount(sql: Query): Promise<number> {
  const tables = await sql<{ tablename: string }[]>`
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename <> 'schema_migrations'
  `;

  let total = 0;
  for (const table of tables) {
    if (!/^[a-z_]+$/.test(table.tablename)) {
      throw new Error("Unexpected table name in public schema");
    }
    const rows = await sql.unsafe<{ n: number | string }[]>(
      `select count(*)::int as n from ${table.tablename}`,
    );
    total += Number(rows[0]?.n ?? 0);
  }
  return total;
}

export async function migrateUp(sql: Sql): Promise<string[]> {
  await ensureMigrationsTable(sql);
  const applied = new Set(await appliedVersions(sql));
  const appliedNow: string[] = [];

  for (const migration of await loadMigrations()) {
    if (applied.has(migration.version)) {
      continue;
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(migration.upSql);
      await tx`
        insert into schema_migrations (version)
        values (${migration.version})
      `;
    });
    appliedNow.push(migration.version);
  }

  return appliedNow;
}

export async function migrateDown(
  sql: Sql,
  options: { force?: boolean } = {},
): Promise<string | null> {
  await ensureMigrationsTable(sql);
  const applied = await appliedVersions(sql);
  const latest = applied.at(-1);
  if (!latest) {
    return null;
  }

  const migration = (await loadMigrations()).find(
    (item) => item.version === latest,
  );
  if (!migration) {
    throw new Error(`Applied migration ${latest} has no file`);
  }

  const rows = await domainRowCount(sql);
  if (rows > 0 && !options.force) {
    throw new Error(
      "Refusing to roll back while domain tables have rows. Pass --force to drop them.",
    );
  }

  await sql.begin(async (tx) => {
    await tx.unsafe(migration.downSql);
    await tx`
      delete from schema_migrations where version = ${migration.version}
    `;
  });

  return migration.version;
}

function publicError(error: unknown): string {
  const text = error instanceof Error ? error.message : "migration failed";
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const force = process.argv.includes("--force");
  const env = loadDatabaseEnv();
  const sql = createSql(env.DATABASE_URL);

  try {
    if (command === "up") {
      const applied = await migrateUp(sql);
      console.log(
        applied.length === 0
          ? "migrations: up to date"
          : `migrations: applied ${applied.join(", ")}`,
      );
      return;
    }

    if (command === "down") {
      const version = await migrateDown(sql, { force });
      console.log(
        version === null
          ? "migrations: nothing to roll back"
          : `migrations: rolled back ${version}`,
      );
      return;
    }

    console.error("Usage: migrate.ts up|down [--force]");
    process.exitCode = 1;
  } catch (error) {
    console.error(publicError(error));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

if (import.meta.main) {
  await main();
}
