import { createSql, ping } from "./db";
import { loadDatabaseEnv } from "./env";

const env = loadDatabaseEnv();
const sql = createSql(env.DATABASE_URL);
const up = await ping(sql);

try {
  await sql.end({ timeout: 2 });
} catch {
  console.error("Database connection did not close cleanly");
}

if (up) {
  console.log("db: up");
  process.exit(0);
}

console.error("db: down");
process.exit(1);
