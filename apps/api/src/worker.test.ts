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
      "spend.updated",
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
    expect(busyBody.run.error).toBe("queued");
    const count = await sql<{ n: number }[]>`
      select count(*)::int as n from agent_runs
      where channel_id = ${heldProject.orchestrator.channelId}::uuid
    `;
    expect(count[0]?.n).toBe(1);
    const queued = await sql<{ n: number }[]>`
      select count(*)::int as n
      from instruction_queue_items
      where channel_id = ${heldProject.orchestrator.channelId}::uuid
        and status = 'pending'
    `;
    expect(queued[0]?.n).toBe(1);
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

  test("a plan pauses the agent until the owner approves", async () => {
    seen.length = 0;
    let calls = 0;
    handler = () => {
      calls += 1;
      if (calls === 1) {
        return {
          text: JSON.stringify({
            status: "plan",
            notes: "Drafting the plan.",
            plan: {
              summary: "Ship a table.",
              steps: ["Draw the layout", "Pick the cards"],
            },
          }),
          tokenIn: 8,
          tokenOut: 6,
          costEst: 0.01,
        };
      }
      return finalResult("Continuing the approved plan.");
    };
    const ownerEmail = emailAddress();
    const ownerCookie = await signup(app, ownerEmail);
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
    await saveKey(app, ownerCookie, project.id, {
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
      ownerCookie,
      project.orchestrator.channelId,
      "Make a plan",
    );
    expect(posted.status).toBe(201);
    await settle();
    stop();
    expect(seen).toHaveLength(1);
    expect(events).toContain("plan.updated");
    const agent = await sql<{ status: string }[]>`
      select status from agents where id = ${project.orchestrator.agentId}::uuid
    `;
    expect(agent[0]?.status).toBe("awaiting_approval");
    const plans = await app.request(
      `/agents/${project.orchestrator.agentId}/plans/latest`,
      { headers: { cookie: memberCookie } },
    );
    expect(plans.status).toBe(200);
    const planBody = (await plans.json()) as {
      plan: { id: string; status: string };
    };
    expect(planBody.plan.status).toBe("awaiting");

    const comment = await postMessage(
      app,
      memberCookie,
      project.orchestrator.channelId,
      "Please keep it small",
    );
    const commentBody = (await comment.json()) as { run: { error?: string } };
    expect(commentBody.run.error).toBe("queued");
    await settle();
    expect(seen).toHaveLength(1);

    const memberApprove = await app.request(
      `/plans/${planBody.plan.id}/approve`,
      { method: "POST", headers: { cookie: memberCookie } },
    );
    expect(memberApprove.status).toBe(403);
    const memberReject = await app.request(
      `/plans/${planBody.plan.id}/reject`,
      { method: "POST", headers: { cookie: memberCookie } },
    );
    expect(memberReject.status).toBe(403);
    const strangerApprove = await app.request(
      `/plans/${planBody.plan.id}/approve`,
      { method: "POST", headers: { cookie: strangerCookie } },
    );
    expect(strangerApprove.status).toBe(404);

    const approved = await app.request(`/plans/${planBody.plan.id}/approve`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    expect(approved.status).toBe(200);
    await settle();
    expect(seen).toHaveLength(3);
    expect(seen[1]?.user.includes("approved:")).toBe(true);
    expect(seen[1]?.user.includes("Ship a table.")).toBe(true);
    expect(
      seen[2]?.user.includes("Current request:\nPlease keep it small"),
    ).toBe(true);
    const owner = await sql<{ user_id: string }[]>`
      select user_id from memberships
      where project_id = ${project.id}::uuid and role = 'owner'
    `;
    const stored = await sql<{ status: string; resolved_by_user_id: string }[]>`
      select status, resolved_by_user_id
      from plans
      where id = ${planBody.plan.id}::uuid
    `;
    expect(stored[0]?.status).toBe("approved");
    expect(stored[0]?.resolved_by_user_id).toBe(owner[0]?.user_id);

    const again = await app.request(`/plans/${planBody.plan.id}/approve`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    expect(again.status).toBe(200);
    await settle();
    expect(seen).toHaveLength(3);
  });

  test("owner reject starts one revision and a second reject does not", async () => {
    seen.length = 0;
    let calls = 0;
    handler = () => {
      calls += 1;
      if (calls === 1) {
        return {
          text: JSON.stringify({
            status: "plan",
            notes: "Drafting the plan.",
            plan: { summary: "Try again.", steps: ["Revise the layout"] },
          }),
          tokenIn: 8,
          tokenOut: 6,
          costEst: 0.01,
        };
      }
      return finalResult("Stopping after rejection.");
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
      "Plan it",
    );
    expect(posted.status).toBe(201);
    await settle();
    const latest = await app.request(
      `/agents/${project.orchestrator.agentId}/plans/latest`,
      { headers: { cookie } },
    );
    const plan = (await latest.json()) as { plan: { id: string } };
    const rejected = await app.request(`/plans/${plan.plan.id}/reject`, {
      method: "POST",
      headers: { cookie },
    });
    expect(rejected.status).toBe(200);
    await settle();
    expect(seen).toHaveLength(2);
    const second = await app.request(`/plans/${plan.plan.id}/reject`, {
      method: "POST",
      headers: { cookie },
    });
    expect(second.status).toBe(200);
    await settle();
    expect(seen).toHaveLength(2);
    const stored = await sql<{ status: string }[]>`
      select status from plans where id = ${plan.plan.id}::uuid
    `;
    expect(stored[0]?.status).toBe("rejected");
  });

  test("approve of a superseded draft is rejected both times", async () => {
    seen.length = 0;
    handler = () => finalResult();
    const cookie = await signup(app, emailAddress());
    const project = await createProject(app, cookie);
    const inserted = await sql<{ id: string }[]>`
      insert into plans (agent_id, status, body)
      values (
        ${project.orchestrator.agentId}::uuid,
        'draft',
        ${sql.json({ summary: "Old", steps: ["one"] })}
      )
      returning id
    `;
    const planId = inserted[0]?.id;
    if (!planId) {
      throw new Error("plan missing");
    }
    const first = await app.request(`/plans/${planId}/approve`, {
      method: "POST",
      headers: { cookie },
    });
    expect(first.status).toBe(409);
    const body = (await first.json()) as { error: string };
    expect(body.error).toBe("plan_superseded");
    const second = await app.request(`/plans/${planId}/approve`, {
      method: "POST",
      headers: { cookie },
    });
    expect(second.status).toBe(409);
    await settle();
    expect(seen).toHaveLength(0);
  });

  test("a pending decision is not packed as a fact", async () => {
    seen.length = 0;
    handler = () => finalResult("Noted.");
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
    await saveKey(app, ownerCookie, project.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    const proposed = await app.request(`/projects/${project.id}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: memberCookie },
      body: JSON.stringify({
        proposal: "Support light and dark theme.",
        originChannelId: project.orchestrator.channelId,
      }),
    });
    expect(proposed.status).toBe(201);
    const created = (await proposed.json()) as {
      decision: { id: string; status: string };
    };
    expect(created.decision.status).toBe("pending");
    const posted = await postMessage(
      app,
      ownerCookie,
      project.orchestrator.channelId,
      "What is decided?",
    );
    expect(posted.status).toBe(201);
    await settle();
    expect(seen[0]?.user.includes("Support light and dark theme.")).toBe(false);
    const brief = await app.request(`/projects/${project.id}/brief`, {
      headers: { cookie: memberCookie },
    });
    const briefBody = (await brief.json()) as { brief: { pins?: unknown[] } };
    expect(briefBody.brief.pins ?? []).toHaveLength(0);

    const memberAccept = await app.request(
      `/decisions/${created.decision.id}/accept`,
      { method: "POST", headers: { cookie: memberCookie } },
    );
    expect(memberAccept.status).toBe(403);
    const memberReject = await app.request(
      `/decisions/${created.decision.id}/reject`,
      { method: "POST", headers: { cookie: memberCookie } },
    );
    expect(memberReject.status).toBe(403);
    const support = await app.request(
      `/decisions/${created.decision.id}/support`,
      { method: "POST", headers: { cookie: memberCookie } },
    );
    expect(support.status).toBe(200);
    const supportAgain = await app.request(
      `/decisions/${created.decision.id}/support`,
      { method: "POST", headers: { cookie: memberCookie } },
    );
    expect(supportAgain.status).toBe(200);
    const ownerSupport = await app.request(
      `/decisions/${created.decision.id}/support`,
      { method: "POST", headers: { cookie: ownerCookie } },
    );
    expect(ownerSupport.status).toBe(200);
    const supports = await sql<{ n: number }[]>`
      select count(*)::int as n from decision_supports
      where decision_id = ${created.decision.id}::uuid
    `;
    expect(supports[0]?.n).toBe(2);
    const still = await sql<{ status: string }[]>`
      select status from decisions where id = ${created.decision.id}::uuid
    `;
    expect(still[0]?.status).toBe("pending");

    const accepted = await app.request(
      `/decisions/${created.decision.id}/accept`,
      { method: "POST", headers: { cookie: ownerCookie } },
    );
    expect(accepted.status).toBe(200);
    const owner = await sql<{ user_id: string }[]>`
      select user_id from memberships
      where project_id = ${project.id}::uuid and role = 'owner'
    `;
    const stored = await sql<{ status: string; accepted_by_user_id: string }[]>`
      select status, accepted_by_user_id
      from decisions
      where id = ${created.decision.id}::uuid
    `;
    expect(stored[0]?.status).toBe("accepted");
    expect(stored[0]?.accepted_by_user_id).toBe(owner[0]?.user_id);
    const notices = await sql<{ n: number }[]>`
      select count(*)::int as n from messages
      where channel_id = ${project.orchestrator.channelId}::uuid
        and author_kind = 'system'
        and body = 'Decision accepted: Support light and dark theme.'
    `;
    expect(notices[0]?.n).toBe(1);
    const pinned = await sql<{ content: { pins?: { proposal: string }[] } }[]>`
      select content from project_briefs where project_id = ${project.id}::uuid
    `;
    expect(pinned[0]?.content.pins).toHaveLength(1);

    seen.length = 0;
    const follow = await postMessage(
      app,
      ownerCookie,
      project.orchestrator.channelId,
      "Use the decision.",
    );
    expect(follow.status).toBe(201);
    await settle();
    expect(seen[0]?.user.includes("Accepted decisions:")).toBe(true);
    expect(seen[0]?.user.includes("Support light and dark theme.")).toBe(true);
    expect(seen[0]?.user.includes('"pins"')).toBe(true);

    const again = await app.request(
      `/decisions/${created.decision.id}/accept`,
      { method: "POST", headers: { cookie: ownerCookie } },
    );
    expect(again.status).toBe(200);
    const noticesAfter = await sql<{ n: number }[]>`
      select count(*)::int as n from messages
      where channel_id = ${project.orchestrator.channelId}::uuid
        and body = 'Decision accepted: Support light and dark theme.'
    `;
    expect(noticesAfter[0]?.n).toBe(1);
    const pinsAfter = await sql<{ content: { pins?: unknown[] } }[]>`
      select content from project_briefs where project_id = ${project.id}::uuid
    `;
    expect(pinsAfter[0]?.content.pins).toHaveLength(1);

    const stranger = await app.request(`/projects/${project.id}/decisions`, {
      headers: { cookie: strangerCookie },
    });
    expect(stranger.status).toBe(404);
  });

  test("a decision turn stays pending and idle", async () => {
    seen.length = 0;
    handler = () => ({
      text: JSON.stringify({
        status: "decision",
        notes: "Proposing a theme.",
        proposal: "The app supports a dark theme.",
      }),
      tokenIn: 5,
      tokenOut: 4,
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
      "Record a decision",
    );
    expect(posted.status).toBe(201);
    await settle();
    const agent = await sql<{ status: string }[]>`
      select status from agents where id = ${project.orchestrator.agentId}::uuid
    `;
    expect(agent[0]?.status).toBe("idle");
    const decision = await sql<
      { status: string; proposed_by_agent_id: string }[]
    >`
      select status, proposed_by_agent_id
      from decisions
      where project_id = ${project.id}::uuid
    `;
    expect(decision[0]?.status).toBe("pending");
    expect(decision[0]?.proposed_by_agent_id).toBe(
      project.orchestrator.agentId,
    );
    const run = await sql<{ status: string }[]>`
      select status from agent_runs
      where channel_id = ${project.orchestrator.channelId}::uuid
    `;
    expect(run[0]?.status).toBe("succeeded");
  });

  test("owner reject does not pin the brief or post an accepted notice", async () => {
    const ownerCookie = await signup(app, emailAddress());
    const project = await createProject(app, ownerCookie);
    const proposed = await app.request(`/projects/${project.id}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({
        proposal: "Ship without accounts.",
        originChannelId: project.orchestrator.channelId,
      }),
    });
    expect(proposed.status).toBe(201);
    const created = (await proposed.json()) as { decision: { id: string } };
    const rejected = await app.request(
      `/decisions/${created.decision.id}/reject`,
      { method: "POST", headers: { cookie: ownerCookie } },
    );
    expect(rejected.status).toBe(200);
    const brief = await sql<{ content: { pins?: unknown[] } }[]>`
      select content from project_briefs where project_id = ${project.id}::uuid
    `;
    expect(brief[0]?.content.pins ?? []).toHaveLength(0);
    const acceptedNotices = await sql<{ n: number }[]>`
      select count(*)::int as n from messages
      where channel_id = ${project.orchestrator.channelId}::uuid
        and body like 'Decision accepted:%'
    `;
    expect(acceptedNotices[0]?.n).toBe(0);
    const rejectedNotices = await sql<{ n: number }[]>`
      select count(*)::int as n from messages
      where channel_id = ${project.orchestrator.channelId}::uuid
        and body = 'Decision rejected: Ship without accounts.'
    `;
    expect(rejectedNotices[0]?.n).toBe(1);
    const again = await app.request(
      `/decisions/${created.decision.id}/reject`,
      {
        method: "POST",
        headers: { cookie: ownerCookie },
      },
    );
    expect(again.status).toBe(200);
    const rejectedAfter = await sql<{ n: number }[]>`
      select count(*)::int as n from messages
      where channel_id = ${project.orchestrator.channelId}::uuid
        and body = 'Decision rejected: Ship without accounts.'
    `;
    expect(rejectedAfter[0]?.n).toBe(1);
  });

  test("a queued change runs after the main run finishes", async () => {
    seen.length = 0;
    handler = () => finalResult("First answer.");
    const held = createTestApp({ hold: true });
    const cookie = await signup(held, emailAddress());
    const project = await createProject(held, cookie);
    await saveKey(held, cookie, project.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    const started = await postMessage(
      held,
      cookie,
      project.orchestrator.channelId,
      "Hold this",
    );
    const first = (await started.json()) as { run: { id: string } };
    const queued = await postMessage(
      held,
      cookie,
      project.orchestrator.channelId,
      "Add a chair",
    );
    const queuedBody = (await queued.json()) as { run: { error?: string } };
    expect(queuedBody.run.error).toBe("queued");
    await executeRun(
      {
        sql,
        encryptionKey: testEnv().CREDENTIALS_ENCRYPTION_KEY,
        llm,
      },
      first.run.id,
    );
    expect(seen.at(-1)?.user.includes("Current request:\nAdd a chair")).toBe(
      true,
    );
    const rows = await sql<{ status: string }[]>`
      select status from instruction_queue_items
      where channel_id = ${project.orchestrator.channelId}::uuid
    `;
    expect(rows[0]?.status).toBe("completed");
    const runs = await sql<{ n: number }[]>`
      select count(*)::int as n from agent_runs
      where channel_id = ${project.orchestrator.channelId}::uuid
        and kind = 'main'
    `;
    expect(runs[0]?.n).toBe(2);
  });

  test("a question while busy stays a short side run", async () => {
    seen.length = 0;
    handler = () => ({
      text: JSON.stringify({
        status: "plan",
        notes: "Trying to change the plan.",
        plan: { summary: "Do not save this.", steps: ["One"] },
      }),
      tokenIn: 3,
      tokenOut: 2,
      costEst: 0.01,
    });
    const held = createTestApp({ hold: true });
    const cookie = await signup(held, emailAddress());
    const project = await createProject(held, cookie);
    await saveKey(held, cookie, project.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    const started = await postMessage(
      held,
      cookie,
      project.orchestrator.channelId,
      "Hold this",
    );
    const first = (await started.json()) as { run: { id: string } };
    const asked = await postMessage(
      held,
      cookie,
      project.orchestrator.channelId,
      "What is the budget?",
    );
    const askedBody = (await asked.json()) as { run: { id?: string } };
    const qaId = askedBody.run.id;
    if (!qaId) {
      throw new Error("missing qa run");
    }
    await executeRun(
      {
        sql,
        encryptionKey: testEnv().CREDENTIALS_ENCRYPTION_KEY,
        llm,
      },
      qaId,
    );
    expect(seen.length).toBeLessThanOrEqual(3);
    const plans = await sql<{ n: number }[]>`
      select count(*)::int as n from plans
      where agent_id = ${project.orchestrator.agentId}::uuid
    `;
    expect(plans[0]?.n).toBe(0);
    const kinds = await sql<{ kind: string }[]>`
      select kind from agent_runs where id = ${qaId}::uuid
    `;
    expect(kinds[0]?.kind).toBe("qa");
    const status = await sql<{ status: string }[]>`
      select status from agents where id = ${project.orchestrator.agentId}::uuid
    `;
    expect(status[0]?.status).toBe("working");
    handler = () => finalResult("Main answer.");
    await executeRun(
      {
        sql,
        encryptionKey: testEnv().CREDENTIALS_ENCRYPTION_KEY,
        llm,
      },
      first.run.id,
    );
    const after = await sql<{ status: string }[]>`
      select status from agents where id = ${project.orchestrator.agentId}::uuid
    `;
    expect(after[0]?.status).toBe("idle");
  });

  test("an ambiguous request can be queued by intent", async () => {
    const held = createTestApp({ hold: true });
    const cookie = await signup(held, emailAddress());
    const project = await createProject(held, cookie);
    await saveKey(held, cookie, project.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    await postMessage(
      held,
      cookie,
      project.orchestrator.channelId,
      "Hold this",
    );
    const asked = await postMessage(
      held,
      cookie,
      project.orchestrator.channelId,
      "Add animations?",
    );
    const askedBody = (await asked.json()) as {
      id: string;
      run: { error?: string };
    };
    expect(askedBody.run.error).toBe("intent_required");
    const chosen = await held.request(
      `/channels/${project.orchestrator.channelId}/messages/${askedBody.id}/intent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ intent: "work" }),
      },
    );
    const chosenBody = (await chosen.json()) as { run: { error?: string } };
    expect(chosenBody.run.error).toBe("queued");
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n
      from instruction_queue_items
      where channel_id = ${project.orchestrator.channelId}::uuid
        and status = 'pending'
    `;
    expect(rows[0]?.n).toBe(1);
  });

  test("the twenty-first queued request is refused", async () => {
    const held = createTestApp({ hold: true });
    const cookie = await signup(held, emailAddress());
    const project = await createProject(held, cookie);
    await saveKey(held, cookie, project.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    await postMessage(
      held,
      cookie,
      project.orchestrator.channelId,
      "Hold this",
    );
    for (let index = 0; index < 20; index += 1) {
      const queued = await postMessage(
        held,
        cookie,
        project.orchestrator.channelId,
        `Task ${index}`,
      );
      const body = (await queued.json()) as { run: { error?: string } };
      expect(body.run.error).toBe("queued");
    }
    const extra = await postMessage(
      held,
      cookie,
      project.orchestrator.channelId,
      "Task overflow",
    );
    const extraBody = (await extra.json()) as { run: { error?: string } };
    expect(extraBody.run.error).toBe("queue_full");
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n
      from instruction_queue_items
      where channel_id = ${project.orchestrator.channelId}::uuid
        and status = 'pending'
    `;
    expect(rows[0]?.n).toBe(20);
  });

  test("only the owner can resolve a conflict", async () => {
    seen.length = 0;
    let opened = false;
    handler = () => {
      if (!opened) {
        opened = true;
        return {
          text: JSON.stringify({
            status: "conflict",
            notes: "Two instructions disagree.",
            conflict: {
              options: [{ label: "Keep it plain" }, { label: "Add motion" }],
            },
          }),
          tokenIn: 5,
          tokenOut: 4,
          costEst: 0.01,
        };
      }
      return finalResult("Following the owner.");
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
      "Keep the button plain",
    );
    expect(posted.status).toBe(201);
    await settle();
    const open = await app.request(
      `/channels/${project.orchestrator.channelId}/conflicts/open`,
      { headers: { cookie } },
    );
    const openBody = (await open.json()) as {
      conflict: { id: string; options: { label: string }[] } | null;
    };
    expect(openBody.conflict?.options).toHaveLength(2);
    const conflictId = openBody.conflict?.id ?? "";
    const blocked = await postMessage(
      app,
      cookie,
      project.orchestrator.channelId,
      "Change the color",
    );
    const blockedBody = (await blocked.json()) as { run: { error?: string } };
    expect(blockedBody.run.error).toBe("conflict_open");
    const memberEmail = emailAddress();
    const memberCookie = await signup(app, memberEmail);
    const member = await sql<{ id: string }[]>`
      select id from users where email = ${memberEmail}
    `;
    await sql`
      insert into memberships (project_id, user_id, role)
      values (${project.id}::uuid, ${member[0]?.id}::uuid, 'member')
    `;
    const memberResolve = await app.request(
      `/conflicts/${conflictId}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: memberCookie },
        body: JSON.stringify({ optionIndex: 0 }),
      },
    );
    expect(memberResolve.status).toBe(403);
    const stranger = await signup(app, emailAddress());
    const hidden = await app.request(`/conflicts/${conflictId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: stranger },
      body: JSON.stringify({ optionIndex: 0 }),
    });
    expect(hidden.status).toBe(404);
    const resolved = await app.request(`/conflicts/${conflictId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ optionIndex: 0 }),
    });
    expect(resolved.status).toBe(200);
    await settle();
    expect(seen.some((request) => request.user.includes("Keep it plain"))).toBe(
      true,
    );
    const runs = await sql<{ n: number }[]>`
      select count(*)::int as n from agent_runs
      where channel_id = ${project.orchestrator.channelId}::uuid
        and kind = 'main'
    `;
    expect(runs[0]?.n).toBe(2);
    const again = await app.request(`/conflicts/${conflictId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ optionIndex: 0 }),
    });
    expect(again.status).toBe(200);
    await settle();
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from agent_runs
      where channel_id = ${project.orchestrator.channelId}::uuid
        and kind = 'main'
    `;
    expect(after[0]?.n).toBe(2);
  });

  test("pause and a cap emit spend updates and a resume drains the queue", async () => {
    seen.length = 0;
    handler = () => finalResult("After resume.");
    const cookie = await signup(app, emailAddress());
    const paused = await createProject(app, cookie);
    await saveKey(app, cookie, paused.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    const events: string[] = [];
    const stop = subscribe(paused.orchestrator.channelId, (event) => {
      events.push(event.event);
    });
    const pause = await app.request(`/projects/${paused.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ llmPaused: true }),
    });
    expect(pause.status).toBe(200);
    expect(events).toContain("spend.updated");
    const pausedPost = await postMessage(
      app,
      cookie,
      paused.orchestrator.channelId,
      "Paused",
    );
    const pausedBody = (await pausedPost.json()) as { run: { error?: string } };
    expect(pausedBody.run.error).toBe("spend_paused");
    expect(seen).toHaveLength(0);
    stop();

    const capped = await createProject(app, cookie);
    await saveKey(app, cookie, capped.id, {
      provider: "anthropic",
      label: "Claude",
      secret,
      isPrimary: true,
    });
    const capEvents: string[] = [];
    const stopCap = subscribe(capped.orchestrator.channelId, (event) => {
      capEvents.push(event.event);
    });
    const cap = await app.request(`/projects/${capped.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ spendCap: 0 }),
    });
    expect(cap.status).toBe(200);
    expect(capEvents).toContain("spend.updated");
    const cappedPost = await postMessage(
      app,
      cookie,
      capped.orchestrator.channelId,
      "Capped",
    );
    const cappedBody = (await cappedPost.json()) as { run: { error?: string } };
    expect(cappedBody.run.error).toBe("spend_cap");
    expect(seen).toHaveLength(0);
    stopCap();

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
      "Hold this",
    );
    const first = (await started.json()) as { run: { id: string } };
    const queued = await postMessage(
      held,
      heldCookie,
      heldProject.orchestrator.channelId,
      "Add a chair",
    );
    expect(
      ((await queued.json()) as { run: { error?: string } }).run.error,
    ).toBe("queued");
    await held.request(`/projects/${heldProject.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: heldCookie },
      body: JSON.stringify({ llmPaused: true }),
    });
    await executeRun(
      {
        sql,
        encryptionKey: testEnv().CREDENTIALS_ENCRYPTION_KEY,
        llm,
      },
      first.run.id,
    );
    expect(seen).toHaveLength(0);
    await held.request(`/projects/${heldProject.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: heldCookie },
      body: JSON.stringify({ llmPaused: false }),
    });
    const pending = await sql<{ id: string }[]>`
      select id from agent_runs
      where channel_id = ${heldProject.orchestrator.channelId}::uuid
        and status = 'pending'
    `;
    expect(pending[0]?.id).toBeTruthy();
    await executeRun(
      {
        sql,
        encryptionKey: testEnv().CREDENTIALS_ENCRYPTION_KEY,
        llm,
      },
      pending[0]?.id ?? "",
    );
    expect(seen.at(-1)?.user.includes("Current request:\nAdd a chair")).toBe(
      true,
    );
    const completed = await sql<{ status: string }[]>`
      select status from instruction_queue_items
      where channel_id = ${heldProject.orchestrator.channelId}::uuid
    `;
    expect(completed[0]?.status).toBe("completed");
  });
});
