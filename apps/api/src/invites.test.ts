import { afterAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { sha256 } from "./auth/crypto";
import type { Mail } from "./auth/mail";
import { createRateLimiter } from "./auth/rate-limit";
import { createSql } from "./db";
import { type Env, loadDatabaseEnv, loadEnv } from "./env";

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

function testEnv(): Env {
  return loadEnv();
}

function emailAddress(label: string): string {
  return `${label}-${crypto.randomUUID()}@invite-test.local`;
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

function tokenFrom(text: string): string {
  const match = /token=([^\s]+)/.exec(text);
  const value = match?.[1];
  if (!value) {
    throw new Error("missing invite token");
  }
  return decodeURIComponent(value);
}

describe("invites", () => {
  const sent: Mail[] = [];
  let failMail = false;
  const app = createApp({
    env: testEnv(),
    sql,
    rateLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }),
    mailer: {
      async send(message) {
        if (failMail) {
          throw new Error("mail_failed");
        }
        sent.push(message);
      },
    },
  });

  afterAll(async () => {
    await sql`
      delete from projects
      where owner_user_id in (
        select id from users where email like '%@invite-test.local'
      )
    `;
    await sql`delete from users where email like '%@invite-test.local'`;
    await sql.end();
  });

  async function signup(email: string) {
    const response = await app.request("/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "test-password-12" }),
    });
    expect(response.status).toBe(201);
    return cookieFrom(response);
  }

  async function createProject(cookie: string) {
    const response = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Invites" }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string };
  }

  test("stores the hash and puts the token only in the mail", async () => {
    const owner = await signup(emailAddress("owner"));
    const project = await createProject(owner);
    sent.length = 0;
    const response = await app.request(`/projects/${project.id}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({ email: "Guest@Invite-Test.local" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      id: string;
      email: string;
      status: string;
    };
    expect(body.email).toBe("guest@invite-test.local");
    expect(body.status).toBe("pending");
    const text = sent[0]?.text ?? "";
    const token = tokenFrom(text);
    expect(text.split(token).length - 1).toBe(1);
    expect(JSON.stringify(body).includes(token)).toBe(false);
    const rows = await sql<{ token_hash: string }[]>`
      select token_hash from invites where id = ${body.id}::uuid
    `;
    expect(rows[0]?.token_hash).toBe(sha256(token));
    expect(rows[0]?.token_hash.includes(token)).toBe(false);
    expect(text.includes(process.env.SESSION_SECRET ?? "missing-secret")).toBe(
      false,
    );
    expect(
      text.includes(process.env.CREDENTIALS_ENCRYPTION_KEY ?? "missing-key"),
    ).toBe(false);
  });

  test("a new signup accepts once and stays a single member", async () => {
    const owner = await signup(emailAddress("owner"));
    const project = await createProject(owner);
    const guest = emailAddress("guest");
    sent.length = 0;
    const created = await app.request(`/projects/${project.id}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({ email: guest }),
    });
    expect(created.status).toBe(201);
    const token = tokenFrom(sent[0]?.text ?? "");
    const cookie = await signup(guest);
    const accepted = await app.request("/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ token }),
    });
    expect(accepted.status).toBe(200);
    const again = await app.request("/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ token }),
    });
    expect(again.status).toBe(200);
    const members = await sql<{ role: string }[]>`
      select memberships.role
      from memberships
      join users on users.id = memberships.user_id
      where memberships.project_id = ${project.id}::uuid
        and users.email = ${guest}
    `;
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe("member");
  });

  test("an existing user accepts from the list and can open the project", async () => {
    const owner = await signup(emailAddress("owner"));
    const guestEmail = emailAddress("guest");
    const guest = await signup(guestEmail);
    const project = await createProject(owner);
    sent.length = 0;
    const created = await app.request(`/projects/${project.id}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({ email: guestEmail }),
    });
    expect(created.status).toBe(201);
    const listed = await app.request("/invites", {
      headers: { cookie: guest },
    });
    expect(listed.status).toBe(200);
    const list = (await listed.json()) as {
      invites: { id: string; projectId: string }[];
    };
    expect(list.invites[0]?.projectId).toBe(project.id);
    expect(JSON.stringify(list).includes(tokenFrom(sent[0]?.text ?? ""))).toBe(
      false,
    );
    const accepted = await app.request(
      `/invites/${list.invites[0]?.id}/accept`,
      { method: "POST", headers: { cookie: guest } },
    );
    expect(accepted.status).toBe(200);
    const opened = await app.request(`/projects/${project.id}`, {
      headers: { cookie: guest },
    });
    expect(opened.status).toBe(200);
    const role = (await opened.json()) as { role: string };
    expect(role.role).toBe("member");
  });

  test("decline creates no membership", async () => {
    const owner = await signup(emailAddress("owner"));
    const guestEmail = emailAddress("guest");
    const guest = await signup(guestEmail);
    const project = await createProject(owner);
    const created = await app.request(`/projects/${project.id}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({ email: guestEmail }),
    });
    const invite = (await created.json()) as { id: string };
    const declined = await app.request("/invites/decline", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: guest },
      body: JSON.stringify({ inviteId: invite.id }),
    });
    expect(declined.status).toBe(200);
    const members = await sql<{ id: string }[]>`
      select memberships.user_id as id
      from memberships
      join users on users.id = memberships.user_id
      where memberships.project_id = ${project.id}::uuid
        and users.email = ${guestEmail}
    `;
    expect(members).toHaveLength(0);
  });

  test("a member cannot invite or revoke, and a stranger is hidden", async () => {
    const owner = await signup(emailAddress("owner"));
    const memberEmail = emailAddress("member");
    const member = await signup(memberEmail);
    const stranger = await signup(emailAddress("stranger"));
    const project = await createProject(owner);
    await app.request(`/projects/${project.id}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({ email: memberEmail }),
    });
    const listed = await app.request("/invites", {
      headers: { cookie: member },
    });
    const invite = ((await listed.json()) as { invites: { id: string }[] })
      .invites[0];
    await app.request(`/invites/${invite?.id}/accept`, {
      method: "POST",
      headers: { cookie: member },
    });
    const forbidden = await app.request(`/projects/${project.id}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: member },
      body: JSON.stringify({ email: emailAddress("other") }),
    });
    expect(forbidden.status).toBe(403);
    const revoke = await app.request(
      `/projects/${project.id}/invites/${invite?.id}`,
      { method: "DELETE", headers: { cookie: member } },
    );
    expect(revoke.status).toBe(403);
    const hidden = await app.request(`/projects/${project.id}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: stranger },
      body: JSON.stringify({ email: emailAddress("other") }),
    });
    expect(hidden.status).toBe(404);
  });

  test("a different account cannot accept the token", async () => {
    const owner = await signup(emailAddress("owner"));
    const project = await createProject(owner);
    sent.length = 0;
    await app.request(`/projects/${project.id}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({ email: emailAddress("guest") }),
    });
    const other = await signup(emailAddress("other"));
    const accepted = await app.request("/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: other },
      body: JSON.stringify({ token: tokenFrom(sent[0]?.text ?? "") }),
    });
    expect(accepted.status).toBe(403);
    const body = (await accepted.json()) as { error: string };
    expect(body.error).toBe("invite_email_mismatch");
  });

  test("expired and revoked tokens do not join", async () => {
    const owner = await signup(emailAddress("owner"));
    const guestEmail = emailAddress("guest");
    const guest = await signup(guestEmail);
    const project = await createProject(owner);
    sent.length = 0;
    const created = await app.request(`/projects/${project.id}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({ email: guestEmail }),
    });
    const invite = (await created.json()) as { id: string };
    const token = tokenFrom(sent[0]?.text ?? "");
    await sql`
      update invites
      set created_at = now() - interval '8 days',
          expires_at = now() - interval '1 minute'
      where id = ${invite.id}::uuid
    `;
    const expired = await app.request("/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: guest },
      body: JSON.stringify({ token }),
    });
    expect(expired.status).toBe(409);
    expect(((await expired.json()) as { error: string }).error).toBe(
      "invite_expired",
    );

    const otherEmail = emailAddress("other");
    const other = await signup(otherEmail);
    sent.length = 0;
    const second = await app.request(`/projects/${project.id}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({ email: otherEmail }),
    });
    const secondInvite = (await second.json()) as { id: string };
    const secondToken = tokenFrom(sent[0]?.text ?? "");
    const revoked = await app.request(
      `/projects/${project.id}/invites/${secondInvite.id}`,
      { method: "DELETE", headers: { cookie: owner } },
    );
    expect(revoked.status).toBe(200);
    const blocked = await app.request("/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: other },
      body: JSON.stringify({ token: secondToken }),
    });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toBe(
      "invite_revoked",
    );
  });

  test("resend replaces the previous token", async () => {
    const owner = await signup(emailAddress("owner"));
    const guestEmail = emailAddress("guest");
    const guest = await signup(guestEmail);
    const project = await createProject(owner);
    sent.length = 0;
    const first = await app.request(`/projects/${project.id}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({ email: guestEmail }),
    });
    expect(first.status).toBe(201);
    const oldToken = tokenFrom(sent[0]?.text ?? "");
    sent.length = 0;
    const resent = await app.request(`/projects/${project.id}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({ email: guestEmail }),
    });
    expect(resent.status).toBe(200);
    const fresh = tokenFrom(sent[0]?.text ?? "");
    const stale = await app.request("/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: guest },
      body: JSON.stringify({ token: oldToken }),
    });
    expect(stale.status).toBe(404);
    const joined = await app.request("/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: guest },
      body: JSON.stringify({ token: fresh }),
    });
    expect(joined.status).toBe(200);
  });

  test("a mail failure leaves the invite pending", async () => {
    const owner = await signup(emailAddress("owner"));
    const project = await createProject(owner);
    failMail = true;
    const response = await app.request(`/projects/${project.id}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({ email: emailAddress("guest") }),
    });
    failMail = false;
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("mail_failed");
    expect(JSON.stringify(body).includes("token")).toBe(false);
    const rows = await sql<{ status: string }[]>`
      select status from invites where project_id = ${project.id}::uuid
    `;
    expect(rows[0]?.status).toBe("pending");
  });
});
