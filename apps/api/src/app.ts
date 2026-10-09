import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Sql } from "postgres";
import { z } from "zod";
import { exchangeGoogleCode, type GoogleTokenClient } from "./auth/google";
import { consoleMailer, type Mailer } from "./auth/mail";
import { createRateLimiter, type RateLimiter } from "./auth/rate-limit";
import { createAuthRoutes } from "./auth/routes";
import { ping } from "./db";
import type { Env } from "./env";
import { createProjectRoutes } from "./projects/routes";

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
      allowHeaders: ["Content-Type"],
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

  return app;
}
