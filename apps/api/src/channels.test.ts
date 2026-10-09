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
  return `user-${crypto.randomUUID()}@channel-test.local`;
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

async function createProject(
  app: ReturnType<typeof createApp>,
  cookie: string,
) {
  const response = await app.request("/projects", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Chat" }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    id: string;
    orchestrator: { channelId: string };
  };
}

describe("channels", () => {
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
        where users.email like '%@channel-test.local'
      )
    `;
    await sql`delete from users where email like '%@channel-test.local'`;
    await sql.end({ timeout: 2 });
  });

  test("a posted message is still there for a new app instance", async () => {
    const cookie = await signup(app, emailAddress());
    const project = await createProject(app, cookie);
    const channelId = project.orchestrator.channelId;
    const posted = await app.request(`/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ body: "Hello orchestrator" }),
    });
    expect(posted.status).toBe(201);
    const message = (await posted.json()) as { id: string; body: string };
    expect(message.body).toBe("Hello orchestrator");

    const reloaded = createApp({
      env: testEnv(),
      sql,
      rateLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }),
    });
    const history = await reloaded.request(`/channels/${channelId}/messages`, {
      headers: { cookie },
    });
    expect(history.status).toBe(200);
    const page = (await history.json()) as {
      messages: { id: string; body: string; authorKind: string }[];
    };
    expect(page.messages.some((item) => item.id === message.id)).toBe(true);
    expect(page.messages[0]?.authorKind).toBe("user");
  });

  test("the same idempotency key does not insert twice", async () => {
    const cookie = await signup(app, emailAddress());
    const project = await createProject(app, cookie);
    const channelId = project.orchestrator.channelId;
    const headers = {
      "content-type": "application/json",
      cookie,
      "idempotency-key": `key-${crypto.randomUUID()}`,
    };
    const first = await app.request(`/channels/${channelId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "Once" }),
    });
    const second = await app.request(`/channels/${channelId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "Once" }),
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { id: string };
    const secondBody = (await second.json()) as { id: string };
    expect(secondBody.id).toBe(firstBody.id);

    const conflict = await app.request(`/channels/${channelId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: "Different" }),
    });
    expect(conflict.status).toBe(409);

    const count = await sql<{ n: number }[]>`
      select count(*)::int as n from messages where channel_id = ${channelId}::uuid
    `;
    expect(count[0]?.n).toBe(1);
  });

  test("another project's member cannot read or post", async () => {
    const ownerCookie = await signup(app, emailAddress());
    const strangerCookie = await signup(app, emailAddress());
    const project = await createProject(app, ownerCookie);
    const channelId = project.orchestrator.channelId;
    const hidden = await app.request(`/channels/${channelId}/messages`, {
      headers: { cookie: strangerCookie },
    });
    expect(hidden.status).toBe(404);
    const posted = await app.request(`/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: strangerCookie,
      },
      body: JSON.stringify({ body: "Nope" }),
    });
    expect(posted.status).toBe(404);
  });

  test("a member can post, empty text is 400, and no cookie is 401", async () => {
    const ownerCookie = await signup(app, emailAddress());
    const memberEmail = emailAddress();
    const memberCookie = await signup(app, memberEmail);
    const project = await createProject(app, ownerCookie);
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
    const channelId = project.orchestrator.channelId;
    const posted = await app.request(`/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: memberCookie },
      body: JSON.stringify({ body: "From a member" }),
    });
    expect(posted.status).toBe(201);

    const empty = await app.request(`/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: memberCookie },
      body: JSON.stringify({ body: "   " }),
    });
    expect(empty.status).toBe(400);

    const anonymous = await app.request(`/channels/${channelId}/messages`);
    expect(anonymous.status).toBe(401);

    const listed = await app.request(`/projects/${project.id}/channels`, {
      headers: { cookie: memberCookie },
    });
    expect(listed.status).toBe(200);
    const channels = (await listed.json()) as { channels: { id: string }[] };
    expect(channels.channels.some((channel) => channel.id === channelId)).toBe(
      true,
    );
  });

  test("two members receive message.created and a stranger cannot subscribe", async () => {
    const ownerCookie = await signup(app, emailAddress());
    const memberEmail = emailAddress();
    const memberCookie = await signup(app, memberEmail);
    const strangerCookie = await signup(app, emailAddress());
    const project = await createProject(app, ownerCookie);
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
    const channelId = project.orchestrator.channelId;

    const denied = await app.request(`/channels/${channelId}/events`, {
      headers: { cookie: strangerCookie },
    });
    expect(denied.status).toBe(404);
    const anonymous = await app.request(`/channels/${channelId}/events`);
    expect(anonymous.status).toBe(401);

    const ownerStream = await app.request(`/channels/${channelId}/events`, {
      headers: { cookie: ownerCookie },
    });
    const memberStream = await app.request(`/channels/${channelId}/events`, {
      headers: { cookie: memberCookie },
    });
    expect(ownerStream.status).toBe(200);
    expect(memberStream.status).toBe(200);
    const ownerEvent = readEvent(ownerStream);
    const memberEvent = readEvent(memberStream);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const posted = await app.request(`/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ body: "Live hello" }),
    });
    expect(posted.status).toBe(201);
    const saved = (await posted.json()) as { id: string; body: string };
    const [ownerText, memberText] = await Promise.all([
      ownerEvent,
      memberEvent,
    ]);
    expect(ownerText).toContain("event: message.created");
    expect(memberText).toContain(saved.id);
    expect(memberText).toContain("Live hello");

    const key = `replay-${crypto.randomUUID()}`;
    const replayStream = await app.request(`/channels/${channelId}/events`, {
      headers: { cookie: memberCookie },
    });
    const replayText = collectFor(replayStream, 700);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await app.request(`/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: ownerCookie,
        "idempotency-key": key,
      },
      body: JSON.stringify({ body: "Only once" }),
    });
    await app.request(`/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: ownerCookie,
        "idempotency-key": key,
      },
      body: JSON.stringify({ body: "Only once" }),
    });
    expect((await replayText).split("event: message.created").length - 1).toBe(
      1,
    );
  });
});

async function collectFor(
  response: Response,
  timeoutMs: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("missing stream");
  }
  const decoder = new TextDecoder();
  let text = "";
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const next = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    if (next === null) {
      continue;
    }
    if (next.done) {
      break;
    }
    text += decoder.decode(next.value);
  }
  await reader.cancel();
  return text;
}

async function readEvent(
  response: Response,
  timeoutMs = 3000,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("missing stream");
  }
  const decoder = new TextDecoder();
  let text = "";
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const next = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ]);
    if (next === null) {
      continue;
    }
    if (next.done) {
      break;
    }
    text += decoder.decode(next.value);
    if (text.includes("event: message.created")) {
      await reader.cancel();
      return text;
    }
  }
  await reader.cancel();
  return text;
}
