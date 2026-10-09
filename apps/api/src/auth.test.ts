import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import type { GoogleProfile } from "./auth/google";
import type { Mail } from "./auth/mail";
import { createRateLimiter } from "./auth/rate-limit";
import { createSql } from "./db";
import { type Env, loadDatabaseEnv, loadEnv } from "./env";
import { migrateUp } from "./migrate";

process.env.APP_URL = "http://127.0.0.1:3000";
if (
  !process.env.SESSION_SECRET ||
  process.env.SESSION_SECRET.trim().length < 32
) {
  process.env.SESSION_SECRET = "test-session-secret-at-least-32-chars";
}
if (
  !process.env.CREDENTIALS_ENCRYPTION_KEY ||
  process.env.CREDENTIALS_ENCRYPTION_KEY.trim().length < 32 ||
  process.env.CREDENTIALS_ENCRYPTION_KEY === process.env.SESSION_SECRET
) {
  process.env.CREDENTIALS_ENCRYPTION_KEY =
    "test-credentials-key-not-the-session-secret";
}

const database = loadDatabaseEnv();
const sql = createSql(database.DATABASE_URL);

function testEnv(overrides?: Partial<Env>): Env {
  return {
    ...loadEnv(),
    GOOGLE_CLIENT_ID: "test-google-client",
    GOOGLE_CLIENT_SECRET: "test-google-secret",
    ...overrides,
  };
}

function emailAddress(): string {
  return `user-${crypto.randomUUID()}@auth-test.local`;
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = /dawk_session=([^;]+)/.exec(setCookie);
  const value = match?.[1];
  if (!value) {
    throw new Error("missing session cookie");
  }
  return `dawk_session=${value}`;
}

async function postJson(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("auth", () => {
  const sent: Mail[] = [];
  const mailer = {
    async send(message: Mail) {
      sent.push(message);
    },
  };
  const app = createApp({
    env: testEnv(),
    sql,
    mailer,
    rateLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }),
    googleTokenClient: async () => {
      throw new Error("google stub not set");
    },
  });

  beforeAll(async () => {
    await migrateUp(sql);
    await sql`delete from magic_link_tokens where email like '%@auth-test.local'`;
    await sql`delete from users where email like '%@auth-test.local'`;
  });

  afterAll(async () => {
    await sql`delete from magic_link_tokens where email like '%@auth-test.local'`;
    await sql`delete from users where email like '%@auth-test.local'`;
    await sql`delete from oauth_states`;
    await sql.end({ timeout: 2 });
  });

  test("signup creates a session and duplicate email is 409", async () => {
    const email = emailAddress();
    const created = await postJson(app, "/auth/signup", {
      email,
      password: "test-password-12",
    });
    expect(created.status).toBe(201);
    const cookie = cookieFrom(created);
    const session = await app.request("/auth/session", {
      headers: { cookie },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ email });

    const duplicate = await postJson(app, "/auth/signup", {
      email,
      password: "test-password-12",
    });
    expect(duplicate.status).toBe(409);
  });

  test("wrong password and unknown email share one error", async () => {
    const email = emailAddress();
    const created = await postJson(app, "/auth/signup", {
      email,
      password: "test-password-12",
    });
    expect(created.status).toBe(201);
    const wrong = await postJson(app, "/auth/login", {
      email,
      password: "not-the-password",
    });
    const unknown = await postJson(app, "/auth/login", {
      email: emailAddress(),
      password: "test-password-12",
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  test("logout invalidates the server session", async () => {
    const email = emailAddress();
    const created = await postJson(app, "/auth/signup", {
      email,
      password: "test-password-12",
    });
    const cookie = cookieFrom(created);
    const loggedOut = await app.request("/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(loggedOut.status).toBe(200);
    const session = await app.request("/auth/session", {
      headers: { cookie },
    });
    expect(session.status).toBe(401);
  });

  test("magic link is single-use and expiry is rejected", async () => {
    const email = emailAddress();
    const requested = await postJson(app, "/auth/magic-link", { email });
    expect(requested.status).toBe(202);
    const link = sent.at(-1)?.text ?? "";
    const token = new URL(link.split("\n")[1] ?? "").searchParams.get("token");
    expect(token).toBeTruthy();

    const consumed = await app.request(
      `/auth/magic-link/consume?token=${encodeURIComponent(token ?? "")}`,
    );
    expect(consumed.status).toBe(302);
    expect(consumed.headers.get("location")).toBe(
      "http://127.0.0.1:3000/account",
    );
    const cookie = cookieFrom(consumed);
    const session = await app.request("/auth/session", {
      headers: { cookie },
    });
    expect(await session.json()).toEqual({ email });

    const reused = await app.request(
      `/auth/magic-link/consume?token=${encodeURIComponent(token ?? "")}`,
    );
    expect(reused.headers.get("location")).toContain("magic_used");

    const expiredEmail = emailAddress();
    await postJson(app, "/auth/magic-link", { email: expiredEmail });
    const expiredLink = sent.at(-1)?.text ?? "";
    const expiredToken = new URL(
      expiredLink.split("\n")[1] ?? "",
    ).searchParams.get("token");
    await sql`
      update magic_link_tokens
      set created_at = now() - interval '2 hours',
          expires_at = now() - interval '1 minute'
      where email = ${expiredEmail}
        and used_at is null
    `;
    const expired = await app.request(
      `/auth/magic-link/consume?token=${encodeURIComponent(expiredToken ?? "")}`,
    );
    expect(expired.headers.get("location")).toContain("magic_expired");
  });

  test("change email waits for verification and rejects reuse", async () => {
    const email = emailAddress();
    const nextEmail = emailAddress();
    const created = await postJson(app, "/auth/signup", {
      email,
      password: "test-password-12",
    });
    const cookie = cookieFrom(created);
    const started = await app.request("/auth/email", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: nextEmail }),
    });
    expect(started.status).toBe(202);
    const before = await app.request("/auth/session", {
      headers: { cookie },
    });
    expect(await before.json()).toEqual({ email });

    const link = sent.at(-1)?.text ?? "";
    const token = new URL(link.split("\n")[1] ?? "").searchParams.get("token");
    const verified = await app.request(
      `/auth/email/verify?token=${encodeURIComponent(token ?? "")}`,
    );
    expect(verified.status).toBe(302);
    const after = await app.request("/auth/session", { headers: { cookie } });
    expect(await after.json()).toEqual({ email: nextEmail });

    const reused = await app.request(
      `/auth/email/verify?token=${encodeURIComponent(token ?? "")}`,
    );
    expect(reused.headers.get("location")).toContain("email_verify_used");
  });

  test("auth routes return 429 after the limit", async () => {
    const limited = createApp({
      env: testEnv(),
      sql,
      mailer,
      rateLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }),
    });
    const headers = { "x-forwarded-for": "203.0.113.10" };
    const first = await postJson(
      limited,
      "/auth/login",
      { email: emailAddress(), password: "test-password-12" },
      headers,
    );
    const second = await postJson(
      limited,
      "/auth/login",
      { email: emailAddress(), password: "test-password-12" },
      headers,
    );
    const third = await postJson(
      limited,
      "/auth/login",
      { email: emailAddress(), password: "test-password-12" },
      headers,
    );
    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(third.status).toBe(429);
  });

  test("google callback rejects a bad state", async () => {
    const response = await app.request(
      "/auth/google/callback?code=abc&state=not-a-real-state",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("oauth_state");
  });

  test("google callback links a verified profile and sets a session", async () => {
    const email = emailAddress();
    const created = await postJson(app, "/auth/signup", {
      email,
      password: "test-password-12",
    });
    expect(created.status).toBe(201);
    const profile: GoogleProfile = {
      sub: `sub-${crypto.randomUUID()}`,
      email,
      emailVerified: true,
    };
    const googleApp = createApp({
      env: testEnv(),
      sql,
      mailer,
      rateLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }),
      googleTokenClient: async () => profile,
    });
    const start = await googleApp.request("/auth/google/start");
    const location = start.headers.get("location") ?? "";
    const state = new URL(location).searchParams.get("state");
    expect(start.status).toBe(302);
    expect(
      location.startsWith("https://accounts.google.com/o/oauth2/v2/auth"),
    ).toBe(true);
    expect(new URL(location).searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:3001/auth/google/callback",
    );

    const callback = await googleApp.request(
      `/auth/google/callback?code=test-code&state=${encodeURIComponent(state ?? "")}`,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(
      "http://127.0.0.1:3000/account",
    );
    const cookie = cookieFrom(callback);
    const session = await googleApp.request("/auth/session", {
      headers: { cookie },
    });
    expect(await session.json()).toEqual({ email });
    const rows = await sql<{ google_sub: string | null }[]>`
      select google_sub from users where email = ${email}
    `;
    expect(rows[0]?.google_sub).toBe(profile.sub);
  });
});
