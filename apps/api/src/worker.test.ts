import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { createRateLimiter } from "./auth/rate-limit";
import { subscribe } from "./channels/hub";
import { createSql } from "./db";
import { type Env, loadDatabaseEnv, loadEnv } from "./env";
import { migrateUp } from "./migrate";
import { executeRun } from "./worker/loop";
import {
  classifyProviderFailure,
  type LlmClient,
  LlmError,
  type LlmRequest,
  type LlmResult,
} from "./worker/provider";

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
const jobs: Promise<void>[] = [];
const seen: LlmRequest[] = [];

let handler: (request: LlmRequest) => LlmResult = () => {
  throw new Error("llm not stubbed");
};

const llm: LlmClient = {
  async complete(request) {
    seen.push({
      provider: request.provider,
      apiKey: request.apiKey,
      model: request.model,
      system: request.system,
      user: request.user,
    });
    return handler(request);
  },
};

function testEnv(): Env {
  return loadEnv();
}

function emailAddress(): string {
  return `user-${crypto.randomUUID()}@worker-test.local`;
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

function finalResult(answer = "Ship the poker table."): LlmResult {
  return {
    text: JSON.stringify({
      status: "final",
      notes: "Ready to answer.",
      answer,
      summary: "The team is planning a poker table.",
    }),
    tokenIn: 11,
    tokenOut: 7,
    costEst: 0.02,
  };
}

function workingResult(costEst = 0.01): LlmResult {
  return {
    text: JSON.stringify({
      status: "working",
      notes: "Still thinking.",
    }),
    tokenIn: 4,
    tokenOut: 2,
    costEst,
  };
}

function createTestApp(options?: { runLimit?: number; hold?: boolean }) {
  return createApp({
    env: testEnv(),
    sql,
    rateLimiter: createRateLimiter({ limit: 100, windowMs: 60_000 }),
    runLimiter: createRateLimiter({
      limit: options?.runLimit ?? 100,
      windowMs: 60_000,
    }),
    llm,
    scheduleRun(runId) {
      if (options?.hold) {
        return;
      }
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
}

async function settle(): Promise<void> {
  const pending = jobs.splice(0);
  await Promise.all(pending);
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
    body: JSON.stringify({ name: "Worker" }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    id: string;
    orchestrator: { agentId: string; channelId: string };
  };
}

async function saveKey(
  app: ReturnType<typeof createApp>,
  cookie: string,
  projectId: string,
  body: {
    provider: string;
    label: string;
    secret: string;
    isPrimary?: boolean;
  },
) {
  const response = await app.request(`/projects/${projectId}/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

async function postMessage(
  app: ReturnType<typeof createApp>,
  cookie: string,
  channelId: string,
  body: string,
  idempotencyKey?: string,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    cookie,
  };
  if (idempotencyKey) {
    headers["idempotency-key"] = idempotencyKey;
  }
  return app.request(`/channels/${channelId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body }),
  });
}

describe("worker", () => {
  const app = createTestApp();

  beforeAll(async () => {
    await migrateUp(sql);
  });

  afterAll(async () => {
    await sql`
      update agent_runs
      set credential_id_used = null
      where project_id in (
        select memberships.project_id
        from memberships
        join users on users.id = memberships.user_id
        where users.email like '%@worker-test.local'
      )
    `;
    await sql`
      delete from projects
      where id in (
        select memberships.project_id
        from memberships
        join users on users.id = memberships.user_id
        where users.email like '%@worker-test.local'
      )
    `;
    await sql`delete from users where email like '%@worker-test.local'`;
    await sql.end({ timeout: 2 });
  });

  test("classifyProviderFailure maps auth, quota, and server errors", () => {
    expect(classifyProviderFailure(401, "no")).toBe("auth");
    expect(classifyProviderFailure(429, "slow down")).toBe("rate");
    expect(classifyProviderFailure(400, "insufficient quota")).toBe("quota");
    expect(classifyProviderFailure(503, "down")).toBe("transient");
    expect(classifyProviderFailure(400, "bad model")).toBe("fatal");
  });

  test("a final reply is masked, packed, and stored", async () => {
    seen.length = 0;
    handler = () => finalResult();
    const cookie = await signup(app, emailAddress());
    const project = await createProject(app, cookie);
    const owner = await sql<{ user_id: string }[]>`
      select user_id from memberships
      where project_id = ${project.id}::uuid and role = 'owner'
    `;
    const ownerId = owner[0]?.user_id;
    if (!ownerId) {
      throw new Error("owner missing");
    }
    await sql`
      insert into messages (channel_id, author_kind, author_user_id, body, created_at)
      select
        ${project.orchestrator.channelId}::uuid,
        'user',
        ${ownerId}::uuid,
        'OLD-' || lpad(n::text, 2, '0'),
        now() - ((30 - n) * interval '1 second')
      from generate_series(1, 25) as n
    `;
    await saveKey(app, cookie, project.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    const events: string[] = [];
    const stop = subscribe(project.orchestrator.channelId, (event) => {
      events.push(event.event);
    });
    const posted = await postMessage(
      app,
      cookie,
      project.orchestrator.channelId,
      "NEW-MESSAGE",
    );
    expect(posted.status).toBe(201);
    const body = (await posted.json()) as { body: string; run: { id: string } };
    expect(body.body).toBe("NEW-MESSAGE");
    expect(JSON.stringify(body).includes(secret)).toBe(false);
    await settle();
    stop();
    expect(events).toEqual([
      "message.created",
      "run.started",
      "run.step",
      "message.created",
      "run.completed",
    ]);
    expect(seen).toHaveLength(1);
    const prompt = seen[0];
    if (!prompt) {
      throw new Error("missing prompt");
    }
    expect(prompt.apiKey).toBe(secret);
    expect(prompt.system.includes("cannot edit a repository")).toBe(true);
    expect(prompt.user.includes("NEW-MESSAGE")).toBe(true);
    expect(prompt.user.includes("OLD-01")).toBe(false);
    expect(prompt.user.split("channel_message ").length - 1).toBe(20);

    const stored = await sql<{ encrypted_secret: Buffer }[]>`
      select encrypted_secret from provider_credentials
      where project_id = ${project.id}::uuid
    `;
    expect(stored[0]?.encrypted_secret.toString("utf8").includes(secret)).toBe(
      false,
    );
    const latest = await app.request(
      `/channels/${project.orchestrator.channelId}/runs/latest`,
      { headers: { cookie } },
    );
    expect(latest.status).toBe(200);
    const runBody = (await latest.json()) as {
      run: { id: string; status: string; steps: { notes: string | null }[] };
    };
    expect(runBody.run.status).toBe("succeeded");
    expect(JSON.stringify(runBody).includes(secret)).toBe(false);
    expect(
      runBody.run.steps.some((step) => step.notes === "Ready to answer."),
    ).toBe(true);
    const byId = await app.request(
      `/agents/${project.orchestrator.agentId}/runs/${body.run.id}`,
      { headers: { cookie } },
    );
    expect(byId.status).toBe(200);
    const history = await app.request(
      `/channels/${project.orchestrator.channelId}/messages`,
      { headers: { cookie } },
    );
    const page = (await history.json()) as {
      messages: { body: string; authorKind: string }[];
    };
    expect(
      page.messages.some(
        (message) =>
          message.authorKind === "agent" &&
          message.body === "Ship the poker table.",
      ),
    ).toBe(true);
    const summary = await sql<{ summary: string }[]>`
      select summary from agent_summaries
      where agent_id = ${project.orchestrator.agentId}::uuid
    `;
    expect(summary[0]?.summary).toBe("The team is planning a poker table.");
  });

  test("working then final stops after two calls", async () => {
    seen.length = 0;
    let calls = 0;
    handler = () => {
      calls += 1;
      return calls === 1 ? workingResult() : finalResult("Done.");
    };
    const cookie = await signup(app, emailAddress());
    const project = await createProject(app, cookie);
    await saveKey(app, cookie, project.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    const posted = await postMessage(
      app,
      cookie,
      project.orchestrator.channelId,
      "Continue",
    );
    expect(posted.status).toBe(201);
    await settle();
    expect(seen).toHaveLength(2);
    const run = await sql<{ status: string }[]>`
      select status from agent_runs
      where channel_id = ${project.orchestrator.channelId}::uuid
    `;
    expect(run[0]?.status).toBe("succeeded");
  });

  test("eight working replies stop at the iteration limit", async () => {
    seen.length = 0;
    handler = () => workingResult();
    const cookie = await signup(app, emailAddress());
    const project = await createProject(app, cookie);
    await saveKey(app, cookie, project.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    const posted = await postMessage(
      app,
      cookie,
      project.orchestrator.channelId,
      "Loop",
    );
    expect(posted.status).toBe(201);
    await settle();
    expect(seen).toHaveLength(8);
    const latest = await app.request(
      `/channels/${project.orchestrator.channelId}/runs/latest`,
      { headers: { cookie } },
    );
    const body = (await latest.json()) as {
      run: { status: string; failureReason: string | null };
    };
    expect(body.run.status).toBe("failed");
    expect(body.run.failureReason).toBe("iteration_limit");
  });

  test("invalid JSON retries once and then fails", async () => {
    seen.length = 0;
    handler = () => ({
      text: "not-json",
      tokenIn: 1,
      tokenOut: 1,
      costEst: 0.01,
    });
    const cookie = await signup(app, emailAddress());
    const project = await createProject(app, cookie);
    await saveKey(app, cookie, project.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    const posted = await postMessage(
      app,
      cookie,
      project.orchestrator.channelId,
      "Bad",
    );
    expect(posted.status).toBe(201);
    await settle();
    expect(seen).toHaveLength(2);
    const run = await sql<{ status: string }[]>`
      select agent_runs.status
      from agent_runs
      join agent_run_steps on agent_run_steps.run_id = agent_runs.id
      where agent_runs.channel_id = ${project.orchestrator.channelId}::uuid
        and agent_run_steps.payload->>'reason' = 'invalid_response'
    `;
    expect(run[0]?.status).toBe("failed");
  });

  test("pause and a reached cap do not call the provider", async () => {
    seen.length = 0;
    handler = () => finalResult();
    const cookie = await signup(app, emailAddress());
    const paused = await createProject(app, cookie);
    await saveKey(app, cookie, paused.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    await sql`
      update projects set llm_paused = true where id = ${paused.id}::uuid
    `;
    const pausedPost = await postMessage(
      app,
      cookie,
      paused.orchestrator.channelId,
      "Paused",
    );
    const pausedBody = (await pausedPost.json()) as {
      run: { error?: string };
    };
    expect(pausedBody.run.error).toBe("spend_paused");
    await settle();
    expect(seen).toHaveLength(0);

    const capped = await createProject(app, cookie);
    await saveKey(app, cookie, capped.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    await sql`
      update projects
      set spend_cap = 1, spend_used = 1
      where id = ${capped.id}::uuid
    `;
    const cappedPost = await postMessage(
      app,
      cookie,
      capped.orchestrator.channelId,
      "Capped",
    );
    const cappedBody = (await cappedPost.json()) as {
      run: { error?: string };
    };
    expect(cappedBody.run.error).toBe("spend_cap");
    await settle();
    expect(seen).toHaveLength(0);
  });

  test("a cap crossed after the first call blocks the second", async () => {
    seen.length = 0;
    handler = () => workingResult(1);
    const cookie = await signup(app, emailAddress());
    const project = await createProject(app, cookie);
    await saveKey(app, cookie, project.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    await sql`
      update projects set spend_cap = 1, spend_used = 0
      where id = ${project.id}::uuid
    `;
    const posted = await postMessage(
      app,
      cookie,
      project.orchestrator.channelId,
      "Spend",
    );
    expect(posted.status).toBe(201);
    await settle();
    expect(seen).toHaveLength(1);
    const run = await sql<{ status: string }[]>`
      select agent_runs.status
      from agent_runs
      join agent_run_steps on agent_run_steps.run_id = agent_runs.id
      where agent_runs.channel_id = ${project.orchestrator.channelId}::uuid
        and agent_run_steps.payload->>'reason' = 'spend_cap'
    `;
    expect(run[0]?.status).toBe("failed");
  });

  test("the agent override is used and an auth failure falls back", async () => {
    seen.length = 0;
    const fallbackSecret = "sk-fallback-secret-value";
    handler = (request) => {
      if (request.apiKey === secret) {
        throw new LlmError("auth");
      }
      return finalResult("Used the fallback.");
    };
    const cookie = await signup(app, emailAddress());
    const project = await createProject(app, cookie);
    const primary = await saveKey(app, cookie, project.id, {
      provider: "anthropic",
      label: "Primary",
      secret,
      isPrimary: true,
    });
    const fallback = await saveKey(app, cookie, project.id, {
      provider: "openai",
      label: "Fallback",
      secret: fallbackSecret,
    });
    const routed = await app.request(
      `/projects/${project.id}/agents/${project.orchestrator.agentId}/routing`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          credentialId: fallback.id,
          modelId: "gpt-test",
        }),
      },
    );
    expect(routed.status).toBe(200);
    const overridePost = await postMessage(
      app,
      cookie,
      project.orchestrator.channelId,
      "Route",
    );
    expect(overridePost.status).toBe(201);
    await settle();
    expect(seen.map((call) => call.apiKey)).toEqual([fallbackSecret]);
    expect(seen[0]?.model).toBe("gpt-test");

    await app.request(
      `/projects/${project.id}/agents/${project.orchestrator.agentId}/routing`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ credentialId: null, modelId: null }),
      },
    );
    seen.length = 0;
    handler = (request) => {
      if (request.apiKey === secret) {
        throw new LlmError("auth");
      }
      return finalResult("Used the fallback.");
    };
    const fallbackPost = await postMessage(
      app,
      cookie,
      project.orchestrator.channelId,
      "Fall back",
    );
    expect(fallbackPost.status).toBe(201);
    await settle();
    expect(seen.map((call) => call.apiKey)).toEqual([secret, fallbackSecret]);
    const status = await sql<{ status: string }[]>`
      select status from provider_credentials where id = ${primary.id}::uuid
    `;
    expect(status[0]?.status).toBe("exhausted");
    const used = await sql<{ credential_id_used: string }[]>`
      select credential_id_used
      from agent_runs
      where channel_id = ${project.orchestrator.channelId}::uuid
        and status = 'succeeded'
      order by created_at desc
      limit 1
    `;
    expect(used[0]?.credential_id_used).toBe(fallback.id);
  });

  test("a member post uses the owner credential and a stranger is hidden", async () => {
    seen.length = 0;
    handler = () => finalResult("For the member.");
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
    const credential = await saveKey(app, ownerCookie, project.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    const posted = await postMessage(
      app,
      memberCookie,
      project.orchestrator.channelId,
      "From a member",
    );
    expect(posted.status).toBe(201);
    await settle();
    expect(seen[0]?.apiKey).toBe(secret);
    const used = await sql<{ id: string; credential_id_used: string }[]>`
      select id, credential_id_used
      from agent_runs
      where channel_id = ${project.orchestrator.channelId}::uuid
    `;
    expect(used[0]?.credential_id_used).toBe(credential.id);
    const runId = used[0]?.id;
    if (!runId) {
      throw new Error("run missing");
    }
    const memberView = await app.request(
      `/agents/${project.orchestrator.agentId}/runs/${runId}`,
      { headers: { cookie: memberCookie } },
    );
    expect(memberView.status).toBe(200);
    const strangerPost = await postMessage(
      app,
      strangerCookie,
      project.orchestrator.channelId,
      "Nope",
    );
    expect(strangerPost.status).toBe(404);
    const strangerRun = await app.request(
      `/channels/${project.orchestrator.channelId}/runs/latest`,
      { headers: { cookie: strangerCookie } },
    );
    expect(strangerRun.status).toBe(404);
    const hidden = await app.request(
      `/agents/${project.orchestrator.agentId}/runs/${runId}`,
      { headers: { cookie: strangerCookie } },
    );
    expect(hidden.status).toBe(404);
    const anonymous = await app.request(
      `/channels/${project.orchestrator.channelId}/runs/latest`,
    );
    expect(anonymous.status).toBe(401);
  });

  test("replay and a busy agent do not start a second run", async () => {
    seen.length = 0;
    handler = () => finalResult();
    const cookie = await signup(app, emailAddress());
    const project = await createProject(app, cookie);
    await saveKey(app, cookie, project.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    const key = `replay-${crypto.randomUUID()}`;
    const first = await postMessage(
      app,
      cookie,
      project.orchestrator.channelId,
      "Once",
      key,
    );
    expect(first.status).toBe(201);
    const second = await postMessage(
      app,
      cookie,
      project.orchestrator.channelId,
      "Once",
      key,
    );
    expect(second.status).toBe(200);
    await settle();
    const runs = await sql<{ n: number }[]>`
      select count(*)::int as n from agent_runs
      where channel_id = ${project.orchestrator.channelId}::uuid
    `;
    expect(runs[0]?.n).toBe(1);

    const held = createTestApp({ hold: true });
    const heldCookie = await signup(held, emailAddress());
    const heldProject = await createProject(held, heldCookie);
    await saveKey(held, heldCookie, heldProject.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    const started = await postMessage(
      held,
      heldCookie,
      heldProject.orchestrator.channelId,
      "Hold",
    );
    expect(started.status).toBe(201);
    const busy = await postMessage(
      held,
      heldCookie,
      heldProject.orchestrator.channelId,
      "Again",
    );
    const busyBody = (await busy.json()) as { run: { error?: string } };
    expect(busyBody.run.error).toBe("agent_busy");
    const count = await sql<{ n: number }[]>`
      select count(*)::int as n from agent_runs
      where channel_id = ${heldProject.orchestrator.channelId}::uuid
    `;
    expect(count[0]?.n).toBe(1);
  });

  test("the enqueue limiter does not create a run row", async () => {
    const limited = createTestApp({ runLimit: 1 });
    const cookie = await signup(limited, emailAddress());
    const project = await createProject(limited, cookie);
    const first = await postMessage(
      limited,
      cookie,
      project.orchestrator.channelId,
      "First",
    );
    expect(first.status).toBe(201);
    jobs.splice(0);
    const second = await postMessage(
      limited,
      cookie,
      project.orchestrator.channelId,
      "Second",
    );
    const body = (await second.json()) as {
      run: { id?: string; error?: string };
    };
    expect(body.run.error).toBe("rate_limited");
    expect(body.run.id).toBeUndefined();
    const count = await sql<{ n: number }[]>`
      select count(*)::int as n from agent_runs
      where channel_id = ${project.orchestrator.channelId}::uuid
    `;
    expect(count[0]?.n).toBe(1);
  });
});
