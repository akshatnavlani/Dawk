import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
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

function testEnv(): Env {
  return loadEnv();
}

function emailAddress(): string {
  return `user-${crypto.randomUUID()}@project-test.local`;
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

async function signup(app: ReturnType<typeof createApp>, email: string) {
  const response = await app.request("/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "test-password-12" }),
  });
  expect(response.status).toBe(201);
  return cookieFrom(response);
}

describe("projects", () => {
  const app = createApp({
    env: testEnv(),
    sql,
    rateLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }),
  });

  beforeAll(async () => {
    await migrateUp(sql);
  });

  afterAll(async () => {
    await sql`
      delete from projects
      where id in (
        select memberships.project_id
        from memberships
        join users on users.id = memberships.user_id
        where users.email like '%@project-test.local'
      )
    `;
    await sql`delete from users where email like '%@project-test.local'`;
    await sql.end({ timeout: 2 });
  });

  test("create always adds an owner membership and orchestrator channel", async () => {
    const cookie = await signup(app, emailAddress());
    const created = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Poker", spendCap: 12.5 }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      id: string;
      role: string;
      spendCap: number;
      orchestrator: { agentId: string; channelId: string; status: string };
    };
    expect(body.role).toBe("owner");
    expect(body.spendCap).toBe(12.5);
    expect(body.orchestrator.status).toBe("idle");

    const counts = await sql<
      { owners: number; orchestrators: number; channels: number }[]
    >`
      select
        (select count(*)::int from memberships where project_id = ${body.id}::uuid and role = 'owner') as owners,
        (select count(*)::int from agents where project_id = ${body.id}::uuid and kind = 'orchestrator') as orchestrators,
        (select count(*)::int from channels where project_id = ${body.id}::uuid and agent_id = ${body.orchestrator.agentId}::uuid) as channels
    `;
    expect(counts[0]).toEqual({ owners: 1, orchestrators: 1, channels: 1 });

    const listed = await app.request("/projects", { headers: { cookie } });
    expect(listed.status).toBe(200);
    const list = (await listed.json()) as { projects: { id: string }[] };
    expect(list.projects.some((project) => project.id === body.id)).toBe(true);
  });

  test("a member can read a project but cannot patch it", async () => {
    const ownerCookie = await signup(app, emailAddress());
    const memberEmail = emailAddress();
    const memberCookie = await signup(app, memberEmail);
    const created = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ name: "Shared" }),
    });
    const project = (await created.json()) as { id: string };
    const member = await sql<{ id: string }[]>`
      select id from users where email = ${memberEmail}
    `;
    const memberId = member[0]?.id;
    if (!memberId) {
      throw new Error("member missing");
    }
    await sql`
      insert into memberships (project_id, user_id, role)
      values (${project.id}::uuid, ${memberId}::uuid, 'member')
    `;

    const detail = await app.request(`/projects/${project.id}`, {
      headers: { cookie: memberCookie },
    });
    expect(detail.status).toBe(200);
    const members = await app.request(`/projects/${project.id}/members`, {
      headers: { cookie: memberCookie },
    });
    expect(members.status).toBe(200);

    const patch = await app.request(`/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: memberCookie },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(patch.status).toBe(403);
  });

  test("a stranger gets 404 and the owner can rename and pause", async () => {
    const ownerCookie = await signup(app, emailAddress());
    const strangerCookie = await signup(app, emailAddress());
    const created = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ name: "Private" }),
    });
    const project = (await created.json()) as { id: string };

    const hidden = await app.request(`/projects/${project.id}`, {
      headers: { cookie: strangerCookie },
    });
    expect(hidden.status).toBe(404);

    const unauthenticated = await app.request("/projects", { method: "POST" });
    expect(unauthenticated.status).toBe(401);

    const invalid = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ name: "   " }),
    });
    expect(invalid.status).toBe(400);

    const patched = await app.request(`/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ name: "Private renamed", llmPaused: true }),
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as {
      name: string;
      llmPaused: boolean;
    };
    expect(body.name).toBe("Private renamed");
    expect(body.llmPaused).toBe(true);
  });
});
