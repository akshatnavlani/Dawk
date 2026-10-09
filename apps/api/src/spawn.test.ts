import { afterAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createRateLimiter } from "./auth/rate-limit";
import { createSql } from "./db";
import { type Env, loadDatabaseEnv, loadEnv } from "./env";
import { executeRun } from "./worker/loop";
import type { LlmClient, LlmRequest, LlmResult } from "./worker/provider";

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
const jobs: Promise<void>[] = [];
const seen: LlmRequest[] = [];

const llm: LlmClient = {
  async complete(request) {
    seen.push(request);
    const result: LlmResult = {
      text: JSON.stringify({
        status: "final",
        notes: "Answered in this channel.",
        answer: "The interface stays simple.",
        summary: "Frontend discussed a simple interface.",
      }),
      tokenIn: 4,
      tokenOut: 3,
      costEst: 0.01,
    };
    return result;
  },
};

function testEnv(): Env {
  return loadEnv();
}

function emailAddress(): string {
  return `user-${crypto.randomUUID()}@spawn-test.local`;
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

describe("specialists", () => {
  const app = createApp({
    env: testEnv(),
    sql,
    rateLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }),
    llm,
    scheduleRun(runId) {
      jobs.push(
        executeRun(
          {
            sql,
            encryptionKey: testEnv().CREDENTIALS_ENCRYPTION_KEY,
            llm,
          },
          runId,
        ),
      );
    },
  });

  afterAll(async () => {
    await sql`
      update agent_runs
      set credential_id_used = null
      where project_id in (
        select id from projects
        where owner_user_id in (
          select id from users where email like '%@spawn-test.local'
        )
      )
    `;
    await sql`
      delete from projects
      where owner_user_id in (
        select id from users where email like '%@spawn-test.local'
      )
    `;
    await sql`delete from users where email like '%@spawn-test.local'`;
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
      body: JSON.stringify({ name: "Specialists" }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as {
      id: string;
      orchestrator: { agentId: string; channelId: string };
    };
  }

  test("the owner adds frontend and backend once", async () => {
    const owner = await signup(emailAddress());
    const memberEmail = emailAddress();
    const member = await signup(memberEmail);
    const stranger = await signup(emailAddress());
    const project = await createProject(owner);
    const memberId = await sql<{ id: string }[]>`
      select id from users where email = ${memberEmail}
    `;
    await sql`
      insert into memberships (project_id, user_id, role)
      values (${project.id}::uuid, ${memberId[0]?.id}::uuid, 'member')
    `;

    const hidden = await app.request(`/projects/${project.id}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: stranger },
      body: JSON.stringify({ kind: "frontend" }),
    });
    expect(hidden.status).toBe(404);
    const forbidden = await app.request(`/projects/${project.id}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: member },
      body: JSON.stringify({ kind: "frontend" }),
    });
    expect(forbidden.status).toBe(403);
    const bad = await app.request(`/projects/${project.id}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({ kind: "orchestrator" }),
    });
    expect(bad.status).toBe(400);

    const frontend = await app.request(`/projects/${project.id}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({
        kind: "frontend",
        brief: "Keep the layout calm.",
      }),
    });
    expect(frontend.status).toBe(201);
    const frontendBody = (await frontend.json()) as {
      agentId: string;
      channelId: string;
      name: string;
      kind: string;
    };
    expect(frontendBody.kind).toBe("frontend");
    expect(frontendBody.name).toBe("Frontend");
    const again = await app.request(`/projects/${project.id}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({ kind: "frontend" }),
    });
    expect(again.status).toBe(409);
    const backend = await app.request(`/projects/${project.id}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({ kind: "backend" }),
    });
    expect(backend.status).toBe(201);

    const listed = await app.request(`/projects/${project.id}/channels`, {
      headers: { cookie: member },
    });
    expect(listed.status).toBe(200);
    const channels = (await listed.json()) as {
      channels: { name: string; kind: string }[];
    };
    const names = channels.channels.map((channel) => channel.name).sort();
    expect(names).toEqual(["Backend", "Frontend", "Orchestrator"]);
    const seed = await sql<{ body: string }[]>`
      select body from messages
      where channel_id = ${frontendBody.channelId}::uuid
        and author_kind = 'system'
    `;
    expect(seed[0]?.body).toBe("Keep the layout calm.");
  });

  test("a frontend reply does not insert an orchestrator plan", async () => {
    seen.length = 0;
    const owner = await signup(emailAddress());
    const project = await createProject(owner);
    const key = await app.request(`/projects/${project.id}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({
        provider: "anthropic",
        label: "Claude",
        secret: "sk-test-secret-value",
        isPrimary: true,
      }),
    });
    expect(key.status).toBe(201);
    const spawned = await app.request(`/projects/${project.id}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner },
      body: JSON.stringify({ kind: "frontend" }),
    });
    expect(spawned.status).toBe(201);
    const specialist = (await spawned.json()) as { channelId: string };
    const posted = await app.request(
      `/channels/${specialist.channelId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner },
        body: JSON.stringify({ body: "How should the home screen look?" }),
      },
    );
    expect(posted.status).toBe(201);
    await Promise.all(jobs.splice(0));
    expect(seen[0]?.system.includes("cannot edit a repository")).toBe(true);
    expect(seen[0]?.system.includes("frontend specialist")).toBe(true);
    const plans = await sql<{ n: number }[]>`
      select count(*)::int as n from plans
      where agent_id = ${project.orchestrator.agentId}::uuid
    `;
    expect(plans[0]?.n).toBe(0);
    const replies = await sql<{ body: string }[]>`
      select body from messages
      where channel_id = ${specialist.channelId}::uuid
        and author_kind = 'agent'
    `;
    expect(replies[0]?.body).toBe("The interface stays simple.");
  });
});
