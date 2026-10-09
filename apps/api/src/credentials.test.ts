import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createRateLimiter } from "./auth/rate-limit";
import { decryptSecret } from "./credentials/crypto";
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
const secret = "sk-test-secret-value";

function testEnv(): Env {
  return loadEnv();
}

function emailAddress(): string {
  return `user-${crypto.randomUUID()}@credential-test.local`;
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
    body: JSON.stringify({ name: "Keys" }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    id: string;
    orchestrator: { agentId: string };
  };
}

describe("credentials", () => {
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
        where users.email like '%@credential-test.local'
      )
    `;
    await sql`delete from users where email like '%@credential-test.local'`;
    await sql.end({ timeout: 2 });
  });

  test("saved keys are masked and stored as ciphertext", async () => {
    const cookie = await signup(app, emailAddress());
    const project = await createProject(app, cookie);
    const created = await app.request(`/projects/${project.id}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        provider: "anthropic",
        label: "Claude",
        secret,
        isPrimary: true,
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      id: string;
      lastFour: string;
      isPrimary: boolean;
    };
    expect(JSON.stringify(body).includes(secret)).toBe(false);
    expect(body.lastFour).toBe("alue");
    expect(body.isPrimary).toBe(true);

    const stored = await sql<
      { encrypted_secret: Buffer; secret_nonce: Buffer; last_four: string }[]
    >`
      select encrypted_secret, secret_nonce, last_four
      from provider_credentials
      where id = ${body.id}::uuid
    `;
    const row = stored[0];
    if (!row) {
      throw new Error("credential missing");
    }
    expect(row.encrypted_secret.toString("utf8").includes(secret)).toBe(false);
    expect(row.last_four).toBe("alue");
    expect(
      decryptSecret(
        row.encrypted_secret,
        row.secret_nonce,
        testEnv().CREDENTIALS_ENCRYPTION_KEY,
      ),
    ).toBe(secret);

    const listed = await app.request(`/projects/${project.id}/credentials`, {
      headers: { cookie },
    });
    const list = (await listed.json()) as {
      credentials: { lastFour: string }[];
    };
    expect(JSON.stringify(list).includes(secret)).toBe(false);
    expect(list.credentials[0]?.lastFour).toBe("alue");
  });

  test("a new primary clears the old one and fallback order persists", async () => {
    const cookie = await signup(app, emailAddress());
    const project = await createProject(app, cookie);
    const first = await app.request(`/projects/${project.id}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        provider: "openai",
        label: "OpenAI",
        secret: "openai-secret-value",
        isPrimary: true,
      }),
    });
    const firstBody = (await first.json()) as {
      id: string;
      fallbackOrder: number;
    };
    const second = await app.request(`/projects/${project.id}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        provider: "google",
        label: "Gemini",
        secret: "google-secret-value",
        isPrimary: true,
      }),
    });
    const secondBody = (await second.json()) as {
      id: string;
      isPrimary: boolean;
      fallbackOrder: number;
    };
    expect(secondBody.isPrimary).toBe(true);
    expect(secondBody.fallbackOrder).toBe(firstBody.fallbackOrder + 1);

    const listed = await app.request(`/projects/${project.id}/credentials`, {
      headers: { cookie },
    });
    const list = (await listed.json()) as {
      credentials: { id: string; isPrimary: boolean }[];
    };
    expect(
      list.credentials.find((item) => item.id === firstBody.id)?.isPrimary,
    ).toBe(false);

    const swapped = await app.request(
      `/projects/${project.id}/credentials/${secondBody.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ fallbackOrder: firstBody.fallbackOrder }),
      },
    );
    expect(swapped.status).toBe(200);
    const swappedBody = (await swapped.json()) as { fallbackOrder: number };
    expect(swappedBody.fallbackOrder).toBe(firstBody.fallbackOrder);
  });

  test("routing saves the agent credential and rejects another project", async () => {
    const cookie = await signup(app, emailAddress());
    const project = await createProject(app, cookie);
    const other = await createProject(app, cookie);
    const created = await app.request(`/projects/${project.id}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        provider: "anthropic",
        label: "Claude",
        secret,
      }),
    });
    const credential = (await created.json()) as { id: string };
    const otherCredential = await app.request(
      `/projects/${other.id}/credentials`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          provider: "openai",
          label: "Other",
          secret: "other-project-secret",
        }),
      },
    );
    const foreign = (await otherCredential.json()) as { id: string };

    const routed = await app.request(
      `/projects/${project.id}/agents/${project.orchestrator.agentId}/routing`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          credentialId: credential.id,
          modelId: "claude-sonnet",
        }),
      },
    );
    expect(routed.status).toBe(200);
    const stored = await sql<
      { credential_id: string | null; model_id: string | null }[]
    >`
      select credential_id, model_id from agents
      where id = ${project.orchestrator.agentId}::uuid
    `;
    expect(stored[0]?.credential_id).toBe(credential.id);
    expect(stored[0]?.model_id).toBe("claude-sonnet");

    const rejected = await app.request(
      `/projects/${project.id}/agents/${project.orchestrator.agentId}/routing`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          credentialId: foreign.id,
          modelId: "gpt",
        }),
      },
    );
    expect(rejected.status).toBe(400);
  });

  test("a member is forbidden and a stranger is hidden", async () => {
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
    const created = await app.request(`/projects/${project.id}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({
        provider: "xai",
        label: "Grok",
        secret,
      }),
    });
    const credential = (await created.json()) as { id: string };
    const paths = [
      {
        method: "GET",
        path: `/projects/${project.id}/credentials`,
      },
      {
        method: "POST",
        path: `/projects/${project.id}/credentials`,
        body: { provider: "openai", label: "No", secret },
      },
      {
        method: "PATCH",
        path: `/projects/${project.id}/credentials/${credential.id}`,
        body: { status: "disabled" },
      },
      {
        method: "DELETE",
        path: `/projects/${project.id}/credentials/${credential.id}`,
      },
      {
        method: "PATCH",
        path: `/projects/${project.id}/agents/${project.orchestrator.agentId}/routing`,
        body: { credentialId: credential.id, modelId: "grok" },
      },
    ];
    for (const item of paths) {
      const response = await app.request(item.path, {
        method: item.method,
        headers: {
          "content-type": "application/json",
          cookie: memberCookie,
        },
        body: item.body ? JSON.stringify(item.body) : undefined,
      });
      expect(response.status).toBe(403);
      const hidden = await app.request(item.path, {
        method: item.method,
        headers: {
          "content-type": "application/json",
          cookie: strangerCookie,
        },
        body: item.body ? JSON.stringify(item.body) : undefined,
      });
      expect(hidden.status).toBe(404);
    }
  });
});
