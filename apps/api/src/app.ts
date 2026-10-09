import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Sql } from "postgres";
import { z } from "zod";
import { exchangeGoogleCode, type GoogleTokenClient } from "./auth/google";
import { consoleMailer, type Mailer } from "./auth/mail";
import { createRateLimiter, type RateLimiter } from "./auth/rate-limit";
import { createAuthRoutes } from "./auth/routes";
import { createChannelRoutes } from "./channels/routes";
import { createCredentialRoutes } from "./credentials/routes";
import { ping } from "./db";
import type { Env } from "./env";
import { createProjectRoutes } from "./projects/routes";
import { enqueueRun, executeRun } from "./worker/loop";
import { createLiveClient, type LlmClient } from "./worker/provider";
import { createRunRoutes } from "./worker/routes";

const healthBody = z.object({
  ok: z.boolean(),
  service: z.literal("dawk-api"),
  db: z.enum(["up", "down"]),
});

export type AppDeps = {
  env: Env;
  sql: Sql;
  mailer?: Mailer;
  rateLimiter?: RateLimiter;
  runLimiter?: RateLimiter;
  llm?: LlmClient;
  scheduleRun?: (runId: string) => void;
  googleTokenClient?: GoogleTokenClient;
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: deps.env.APP_URL,
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Idempotency-Key"],
    }),
  );

  app.get("/health", async (c) => {
    const dbUp = await ping(deps.sql);
    const body = healthBody.parse({
      ok: dbUp,
      service: "dawk-api",
      db: dbUp ? "up" : "down",
    });
    return c.json(body, dbUp ? 200 : 503);
  });

  app.route(
    "/",
    createAuthRoutes({
      sql: deps.sql,
      sessionSecret: deps.env.SESSION_SECRET,
      appUrl: deps.env.APP_URL,
      mailer: deps.mailer ?? consoleMailer,
      rateLimiter: deps.rateLimiter ?? createRateLimiter(),
      googleClientId: deps.env.GOOGLE_CLIENT_ID,
      googleClientSecret: deps.env.GOOGLE_CLIENT_SECRET,
      googleTokenClient: deps.googleTokenClient ?? exchangeGoogleCode,
    }),
  );
  app.route(
    "/",
    createProjectRoutes({
      sql: deps.sql,
      sessionSecret: deps.env.SESSION_SECRET,
    }),
  );
  const runLimiter =
    deps.runLimiter ??
    createRateLimiter({ limit: 30, windowMs: 10 * 60 * 1000 });
  const llm = deps.llm ?? createLiveClient();
  const workerDeps = {
    sql: deps.sql,
    encryptionKey: deps.env.CREDENTIALS_ENCRYPTION_KEY,
    llm,
  };
  app.route(
    "/",
    createChannelRoutes({
      sql: deps.sql,
      sessionSecret: deps.env.SESSION_SECRET,
      startRun: async (channelId, userId) => {
        const started = await enqueueRun(
          {
            ...workerDeps,
            allow: (key) => runLimiter.allow(key),
          },
          { channelId, userId },
        );
        if (started.kind === "started" && "id" in started.run) {
          const runId = started.run.id;
          if (deps.scheduleRun) {
            deps.scheduleRun(runId);
          } else {
            void executeRun(workerDeps, runId).catch(() => {
              console.error("agent run failed");
            });
          }
        }
        return started.run;
      },
    }),
  );
  app.route(
    "/",
    createRunRoutes({
      sql: deps.sql,
      sessionSecret: deps.env.SESSION_SECRET,
    }),
  );
  app.route(
    "/",
    createCredentialRoutes({
      sql: deps.sql,
      sessionSecret: deps.env.SESSION_SECRET,
      encryptionKey: deps.env.CREDENTIALS_ENCRYPTION_KEY,
    }),
  );

  return app;
}
