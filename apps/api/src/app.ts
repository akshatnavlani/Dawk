import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Sql } from "postgres";
import { z } from "zod";
import { exchangeGoogleCode, type GoogleTokenClient } from "./auth/google";
import { createMailer, type Mailer } from "./auth/mail";
import { createRateLimiter, type RateLimiter } from "./auth/rate-limit";
import { createAuthRoutes } from "./auth/routes";
import { createChannelRoutes } from "./channels/routes";
import { createCredentialRoutes } from "./credentials/routes";
import { ping } from "./db";
import { createDecisionRoutes } from "./decisions/routes";
import type { Env } from "./env";
import { createInviteRoutes } from "./invites/routes";
import { createProjectRoutes } from "./projects/routes";
import {
  drainProject,
  enqueueRun,
  executeRun,
  publishSpend,
  startContinuation,
} from "./worker/loop";
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

  const mailer = deps.mailer ?? createMailer(deps.env);
  app.route(
    "/",
    createAuthRoutes({
      sql: deps.sql,
      sessionSecret: deps.env.SESSION_SECRET,
      appUrl: deps.env.APP_URL,
      mailer,
      rateLimiter: deps.rateLimiter ?? createRateLimiter(),
      googleClientId: deps.env.GOOGLE_CLIENT_ID,
      googleClientSecret: deps.env.GOOGLE_CLIENT_SECRET,
      googleTokenClient: deps.googleTokenClient ?? exchangeGoogleCode,
    }),
  );
  app.route(
    "/",
    createInviteRoutes({
      sql: deps.sql,
      sessionSecret: deps.env.SESSION_SECRET,
      appUrl: deps.env.APP_URL,
      mailer,
      rateLimiter: deps.rateLimiter ?? createRateLimiter(),
    }),
  );
  let notifySpend: (projectId: string) => Promise<void> = async () => {};
  app.route(
    "/",
    createProjectRoutes({
      sql: deps.sql,
      sessionSecret: deps.env.SESSION_SECRET,
      onSpendChange: (projectId) => notifySpend(projectId),
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
  const schedule = (runId: string) => {
    if (deps.scheduleRun) {
      deps.scheduleRun(runId);
      return;
    }
    void executeRun(workerDeps, runId).catch(() => {
      console.error("agent run failed");
    });
  };
  notifySpend = async (projectId) => {
    await publishSpend(deps.sql, projectId);
    const project = await deps.sql<
      { llm_paused: boolean; spend_cap: string | null; spend_used: string }[]
    >`
      select llm_paused, spend_cap::text as spend_cap, spend_used::text as spend_used
      from projects
      where id = ${projectId}::uuid
    `;
    const row = project[0];
    const blocked =
      !row ||
      row.llm_paused ||
      (row.spend_cap !== null &&
        Number(row.spend_used) >= Number(row.spend_cap));
    if (blocked) {
      return;
    }
    const started = await drainProject(workerDeps, projectId);
    for (const runId of started) {
      schedule(runId);
    }
  };
  const startFromMessage = async (
    channelId: string,
    userId: string,
    message: { id: string; body: string; intent?: "work" | "question" },
    consumeLimit: boolean,
  ) => {
    const started = await enqueueRun(
      {
        ...workerDeps,
        allow: (key) => runLimiter.allow(key),
      },
      {
        channelId,
        userId,
        messageId: message.id,
        body: message.body,
        intent: message.intent,
        consumeLimit,
      },
    );
    if (started.kind === "started" && "id" in started.run) {
      schedule(started.run.id);
    }
    return started.run;
  };
  app.route(
    "/",
    createChannelRoutes({
      sql: deps.sql,
      sessionSecret: deps.env.SESSION_SECRET,
      startRun: (channelId, userId, message) =>
        startFromMessage(channelId, userId, message, true),
      applyIntent: (channelId, userId, message) =>
        startFromMessage(channelId, userId, message, false),
    }),
  );
  app.route(
    "/",
    createRunRoutes({
      sql: deps.sql,
      sessionSecret: deps.env.SESSION_SECRET,
      continueAfterPlan: async (agentId, requestText) => {
        const started = await startContinuation(
          workerDeps,
          agentId,
          requestText,
        );
        if (started.kind === "started" && "id" in started.run) {
          schedule(started.run.id);
        }
      },
    }),
  );
  app.route(
    "/",
    createDecisionRoutes({
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
