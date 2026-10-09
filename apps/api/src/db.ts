import postgres, { type Sql } from "postgres";

export function createSql(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 20,
    onnotice(notice) {
      if (notice.code === "42P07") {
        return;
      }
      console.error(notice.message ?? "database notice");
    },
  });
}

export async function ping(sql: Sql): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    console.error("Database health check failed");
    return false;
  }
}
