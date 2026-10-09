import type { Context } from "hono";
import { Hono } from "hono";
import type { Sql } from "postgres";
import { z } from "zod";
import {
  codeChallenge,
  newToken,
  openSession,
  sealSession,
  sha256,
} from "./crypto";
import {
  GOOGLE_REDIRECT_URI,
  type GoogleTokenClient,
  googleAuthorizeUrl,
} from "./google";
import type { Mailer } from "./mail";
import { hashPassword, verifyPassword } from "./passwords";
import type { RateLimiter } from "./rate-limit";

const API_ORIGIN = "http://127.0.0.1:3001";
const SESSION_SECONDS = 14 * 24 * 60 * 60;
const SESSION_COOKIE = "dawk_session";

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), {
    message: "invalid_email",
  });

const credentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(12).max(200),
});

const emailBodySchema = z.object({
  email: emailSchema,
});

type AuthDeps = {
  sql: Sql;
  sessionSecret: string;
  appUrl: string;
  mailer: Mailer;
  rateLimiter: RateLimiter;
  googleClientId?: string;
  googleClientSecret?: string;
  googleTokenClient: GoogleTokenClient;
};

export type SessionUser = {
  id: string;
  email: string;
};

function jsonError(
  c: Context,
  status: 400 | 401 | 409 | 429 | 503,
  error: string,
) {
  return c.json({ error }, status);
}

function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (!forwarded) {
    return "local";
  }
  return forwarded.split(",")[0]?.trim() || "local";
}

function sessionCookie(value: string, secure: boolean): string {
  const sameSite = secure ? "None" : "Lax";
  const secureFlag = secure ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${SESSION_SECONDS}${secureFlag}`;
}

function clearSessionCookie(secure: boolean): string {
  const sameSite = secure ? "None" : "Lax";
  const secureFlag = secure ? "; Secure" : "";
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${secureFlag}`;
}

function readCookie(c: Context): string | null {
  const header = c.req.header("cookie");
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (trimmed.slice(0, eq) === SESSION_COOKIE) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

async function issueSession(
  c: Context,
  sql: Sql,
  sessionSecret: string,
  userId: string,
  secure: boolean,
): Promise<void> {
  const sealed = sealSession(sessionSecret);
  await sql`
    insert into sessions (user_id, token_hash, expires_at)
    values (
      ${userId}::uuid,
      ${sealed.tokenHash},
      now() + interval '14 days'
    )
  `;
  c.header("Set-Cookie", sessionCookie(sealed.cookieValue, secure));
}

export async function currentUser(
  c: Context,
  sql: Sql,
  sessionSecret: string,
): Promise<SessionUser | null> {
  const cookie = readCookie(c);
  if (!cookie) {
    return null;
  }
  const tokenHash = openSession(sessionSecret, cookie);
  if (!tokenHash) {
    return null;
  }
  const rows = await sql<{ id: string; email: string; expires_at: Date }[]>`
    select users.id, users.email, sessions.expires_at
    from sessions
    join users on users.id = sessions.user_id
    where sessions.token_hash = ${tokenHash}
  `;
  const row = rows[0];
  if (!row) {
    return null;
  }
  if (row.expires_at.getTime() <= Date.now()) {
    await sql`delete from sessions where token_hash = ${tokenHash}`;
    return null;
  }
  return { id: row.id, email: row.email };
}

async function consumeToken(input: {
  sql: Sql;
  hash: string;
  table: "magic_link_tokens" | "email_change_tokens";
}): Promise<"ok" | "missing" | "used" | "expired"> {
  if (input.table === "magic_link_tokens") {
    const updated = await input.sql<{ email: string }[]>`
      update magic_link_tokens
      set used_at = now()
      where token_hash = ${input.hash}
        and used_at is null
        and expires_at > now()
      returning email
    `;
    if (updated[0]) {
      return "ok";
    }
  } else {
    const updated = await input.sql<{ new_email: string }[]>`
      update email_change_tokens
      set used_at = now()
      where token_hash = ${input.hash}
        and used_at is null
        and expires_at > now()
      returning new_email
    `;
    if (updated[0]) {
      return "ok";
    }
  }

  const existing =
    input.table === "magic_link_tokens"
      ? await input.sql<{ used_at: Date | null; expires_at: Date }[]>`
          select used_at, expires_at
          from magic_link_tokens
          where token_hash = ${input.hash}
        `
      : await input.sql<{ used_at: Date | null; expires_at: Date }[]>`
          select used_at, expires_at
          from email_change_tokens
          where token_hash = ${input.hash}
        `;
  const row = existing[0];
  if (!row) {
    return "missing";
  }
  if (row.used_at) {
    return "used";
  }
  return "expired";
}

export function createAuthRoutes(deps: AuthDeps): Hono {
  const app = new Hono();

  app.post("/auth/signup", async (c) => {
    if (!deps.rateLimiter.allow(`signup:${clientIp(c)}`)) {
      return jsonError(c, 429, "rate_limited");
    }
    const parsed = credentialsSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request");
    }
    const passwordHash = await hashPassword(parsed.data.password);
    const inserted = await deps.sql<{ id: string }[]>`
      insert into users (email, password_hash)
      values (${parsed.data.email}, ${passwordHash})
      on conflict (email) do nothing
      returning id
    `;
    const user = inserted[0];
    if (!user) {
      return jsonError(c, 409, "email_taken");
    }
    await issueSession(
      c,
      deps.sql,
      deps.sessionSecret,
      user.id,
      deps.appUrl.startsWith("https://"),
    );
    return c.json({ email: parsed.data.email }, 201);
  });

  app.post("/auth/login", async (c) => {
    if (!deps.rateLimiter.allow(`login:${clientIp(c)}`)) {
      return jsonError(c, 429, "rate_limited");
    }
    const parsed = credentialsSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request");
    }
    const rows = await deps.sql<{ id: string; password_hash: string | null }[]>`
      select id, password_hash from users where email = ${parsed.data.email}
    `;
    const user = rows[0];
    const matches =
      user?.password_hash !== null &&
      user?.password_hash !== undefined &&
      (await verifyPassword(parsed.data.password, user.password_hash));
    if (!user || !matches) {
      return jsonError(c, 401, "invalid_credentials");
    }
    await issueSession(
      c,
      deps.sql,
      deps.sessionSecret,
      user.id,
      deps.appUrl.startsWith("https://"),
    );
    return c.json({ email: parsed.data.email }, 200);
  });

  app.post("/auth/magic-link", async (c) => {
    if (!deps.rateLimiter.allow(`magic-link:${clientIp(c)}`)) {
      return jsonError(c, 429, "rate_limited");
    }
    const parsed = emailBodySchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request");
    }
    const token = newToken();
    await deps.sql`
      insert into magic_link_tokens (email, token_hash, expires_at)
      values (
        ${parsed.data.email},
        ${sha256(token)},
        now() + interval '15 minutes'
      )
    `;
    const link = `${API_ORIGIN}/auth/magic-link/consume?token=${encodeURIComponent(token)}`;
    await deps.mailer.send({
      to: parsed.data.email,
      subject: "Your Dawk sign-in link",
      text: `Sign in to Dawk:\n${link}\n\nThis link expires in 15 minutes and works once.`,
    });
    return c.json({ ok: true }, 202);
  });

  app.get("/auth/magic-link/consume", async (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.redirect(`${deps.appUrl}/login?error=magic_invalid`);
    }
    const hash = sha256(token);
    const outcome = await consumeToken({
      sql: deps.sql,
      hash,
      table: "magic_link_tokens",
    });
    if (outcome !== "ok") {
      const error =
        outcome === "used"
          ? "magic_used"
          : outcome === "expired"
            ? "magic_expired"
            : "magic_invalid";
      return c.redirect(`${deps.appUrl}/login?error=${error}`);
    }
    const rows = await deps.sql<{ email: string }[]>`
      select email from magic_link_tokens where token_hash = ${hash}
    `;
    const email = rows[0]?.email;
    if (!email) {
      return c.redirect(`${deps.appUrl}/login?error=magic_invalid`);
    }
    const existing = await deps.sql<{ id: string }[]>`
      select id from users where email = ${email}
    `;
    let userId = existing[0]?.id;
    if (!userId) {
      const created = await deps.sql<{ id: string }[]>`
        insert into users (email)
        values (${email})
        on conflict (email) do nothing
        returning id
      `;
      userId = created[0]?.id ?? existing[0]?.id;
      if (!userId) {
        const again = await deps.sql<{ id: string }[]>`
          select id from users where email = ${email}
        `;
        userId = again[0]?.id;
      }
    }
    if (!userId) {
      return c.redirect(`${deps.appUrl}/login?error=magic_invalid`);
    }
    await issueSession(
      c,
      deps.sql,
      deps.sessionSecret,
      userId,
      deps.appUrl.startsWith("https://"),
    );
    return c.redirect(`${deps.appUrl}/account`);
  });

  app.get("/auth/google/start", async (c) => {
    if (!deps.googleClientId || !deps.googleClientSecret) {
      return jsonError(c, 503, "google_not_configured");
    }
    const state = newToken();
    const verifier = newToken();
    await deps.sql`
      insert into oauth_states (state_hash, code_verifier, expires_at)
      values (
        ${sha256(state)},
        ${verifier},
        now() + interval '10 minutes'
      )
    `;
    return c.redirect(
      googleAuthorizeUrl({
        clientId: deps.googleClientId,
        state,
        codeChallenge: codeChallenge(verifier),
      }),
    );
  });

  app.get("/auth/google/callback", async (c) => {
    if (c.req.query("error") === "access_denied") {
      return c.redirect(`${deps.appUrl}/login?error=oauth_cancelled`);
    }
    if (!deps.googleClientId || !deps.googleClientSecret) {
      return jsonError(c, 503, "google_not_configured");
    }
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state || !code) {
      return c.redirect(`${deps.appUrl}/login?error=oauth_state`);
    }
    const claimed = await deps.sql<{ code_verifier: string }[]>`
      update oauth_states
      set used_at = now()
      where state_hash = ${sha256(state)}
        and used_at is null
        and expires_at > now()
      returning code_verifier
    `;
    const verifier = claimed[0]?.code_verifier;
    if (!verifier) {
      return c.redirect(`${deps.appUrl}/login?error=oauth_state`);
    }

    let profile: Awaited<ReturnType<GoogleTokenClient>>;
    try {
      profile = await deps.googleTokenClient({
        code,
        codeVerifier: verifier,
        redirectUri: GOOGLE_REDIRECT_URI,
        clientId: deps.googleClientId,
        clientSecret: deps.googleClientSecret,
      });
    } catch {
      return c.redirect(`${deps.appUrl}/login?error=oauth_failed`);
    }

    const emailParse = emailSchema.safeParse(profile.email);
    if (!emailParse.success || !profile.emailVerified) {
      return c.redirect(`${deps.appUrl}/login?error=email_unverified`);
    }
    const email = emailParse.data;

    const bySub = await deps.sql<{ id: string }[]>`
      select id from users where google_sub = ${profile.sub}
    `;
    let userId = bySub[0]?.id;
    if (!userId) {
      const byEmail = await deps.sql<
        { id: string; google_sub: string | null }[]
      >`
        select id, google_sub from users where email = ${email}
      `;
      const existing = byEmail[0];
      if (existing?.google_sub && existing.google_sub !== profile.sub) {
        return c.redirect(`${deps.appUrl}/login?error=oauth_account_mismatch`);
      }
      if (existing) {
        await deps.sql`
          update users
          set google_sub = ${profile.sub}, updated_at = now()
          where id = ${existing.id}::uuid
            and (google_sub is null or google_sub = ${profile.sub})
        `;
        userId = existing.id;
      } else {
        const created = await deps.sql<{ id: string }[]>`
          insert into users (email, google_sub)
          values (${email}, ${profile.sub})
          on conflict (email) do nothing
          returning id
        `;
        userId = created[0]?.id;
        if (!userId) {
          return c.redirect(`${deps.appUrl}/login?error=oauth_failed`);
        }
      }
    }

    await issueSession(
      c,
      deps.sql,
      deps.sessionSecret,
      userId,
      deps.appUrl.startsWith("https://"),
    );
    return c.redirect(`${deps.appUrl}/account`);
  });

  app.get("/auth/session", async (c) => {
    const user = await currentUser(c, deps.sql, deps.sessionSecret);
    if (!user) {
      return jsonError(c, 401, "unauthorized");
    }
    return c.json({ email: user.email }, 200);
  });

  app.post("/auth/logout", async (c) => {
    const cookie = readCookie(c);
    if (cookie) {
      const tokenHash = openSession(deps.sessionSecret, cookie);
      if (tokenHash) {
        await deps.sql`delete from sessions where token_hash = ${tokenHash}`;
      }
    }
    c.header(
      "Set-Cookie",
      clearSessionCookie(deps.appUrl.startsWith("https://")),
    );
    return c.json({ ok: true }, 200);
  });

  app.patch("/auth/email", async (c) => {
    const user = await currentUser(c, deps.sql, deps.sessionSecret);
    if (!user) {
      return jsonError(c, 401, "unauthorized");
    }
    const parsed = emailBodySchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request");
    }
    if (parsed.data.email === user.email) {
      return jsonError(c, 400, "invalid_request");
    }
    const taken = await deps.sql<{ id: string }[]>`
      select id from users where email = ${parsed.data.email}
    `;
    if (taken[0]) {
      return jsonError(c, 409, "email_taken");
    }
    const token = newToken();
    await deps.sql`
      insert into email_change_tokens (user_id, new_email, token_hash, expires_at)
      values (
        ${user.id}::uuid,
        ${parsed.data.email},
        ${sha256(token)},
        now() + interval '15 minutes'
      )
    `;
    const link = `${API_ORIGIN}/auth/email/verify?token=${encodeURIComponent(token)}`;
    await deps.mailer.send({
      to: parsed.data.email,
      subject: "Confirm your new Dawk email",
      text: `Confirm this email for Dawk:\n${link}\n\nThis link expires in 15 minutes and works once.`,
    });
    return c.json({ ok: true }, 202);
  });

  app.get("/auth/email/verify", async (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.redirect(`${deps.appUrl}/login?error=email_verify_invalid`);
    }
    const hash = sha256(token);
    const outcome = await consumeToken({
      sql: deps.sql,
      hash,
      table: "email_change_tokens",
    });
    if (outcome !== "ok") {
      const error =
        outcome === "used"
          ? "email_verify_used"
          : outcome === "expired"
            ? "email_verify_expired"
            : "email_verify_invalid";
      return c.redirect(`${deps.appUrl}/account?error=${error}`);
    }
    const rows = await deps.sql<{ user_id: string; new_email: string }[]>`
      select user_id, new_email
      from email_change_tokens
      where token_hash = ${hash}
    `;
    const change = rows[0];
    if (!change) {
      return c.redirect(`${deps.appUrl}/account?error=email_verify_invalid`);
    }
    const updated = await deps.sql<{ id: string }[]>`
      update users
      set email = ${change.new_email}, updated_at = now()
      where id = ${change.user_id}::uuid
        and not exists (
          select 1 from users existing
          where existing.email = ${change.new_email}
            and existing.id <> ${change.user_id}::uuid
        )
      returning id
    `;
    if (!updated[0]) {
      return c.redirect(`${deps.appUrl}/account?error=email_taken`);
    }
    return c.redirect(`${deps.appUrl}/account`);
  });

  return app;
}
