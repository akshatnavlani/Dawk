import { createApp } from "./app";
import { createSql } from "./db";
import { loadEnv } from "./env";
import { recoverStuckRuns } from "./worker/loop";

const env = loadEnv();
const sql = createSql(env.DATABASE_URL);
await recoverStuckRuns(sql);
const app = createApp({ env, sql });

const port = 3001;

console.log(`API listening on http://127.0.0.1:${port}`);

export default {
  port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
