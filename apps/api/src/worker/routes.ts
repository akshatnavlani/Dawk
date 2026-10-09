import type { Context } from "hono";
import { Hono } from "hono";
import type { Sql } from "postgres";
import { z } from "zod";
import { currentUser } from "../auth/routes";
import { publish, publishMessageCreated } from "../channels/hub";

type StepPayload = {
  notes?: string;
  model?: string;
  tokenIn?: number;
  tokenOut?: number;
  costEst?: number;
  reason?: string;
};

type RunRow = {
  id: string;
  status: string;
  model_used: string | null;
  token_in: number;
  token_out: number;
  cost_est: string;
};

type StepRow = {
  step_index: number;
  iteration: number;
  type: string;
  payload: StepPayload;
};

function jsonError(c: Context, status: 401 | 403 | 404 | 409, error: string) {
  return c.json({ error }, status);
}

function toRun(run: RunRow, steps: StepRow[]) {
  const failure = [...steps]
    .reverse()
    .find((step) => typeof step.payload.reason === "string");
  return {
    id: run.id,
    status: run.status,
    model: run.model_used,
    tokenIn: run.token_in,
    tokenOut: run.token_out,
    costEst: Number(run.cost_est),
    failureReason: failure?.payload.reason ?? null,
    steps: steps.map((step) => ({
      stepIndex: step.step_index,
      iteration: step.iteration,
      type: step.type,
      notes: step.payload.notes ?? null,
      model: step.payload.model ?? null,
      tokenIn: step.payload.tokenIn ?? null,
      tokenOut: step.payload.tokenOut ?? null,
      costEst: step.payload.costEst ?? null,
      reason: step.payload.reason ?? null,
    })),
  };
}

async function loadRun(
  sql: Sql,
  runId: string,
): Promise<{ run: RunRow; steps: StepRow[] } | null> {
  const runs = await sql<RunRow[]>`
    select id, status, model_used, token_in, token_out, cost_est::text as cost_est
    from agent_runs
    where id = ${runId}::uuid
  `;
  const run = runs[0];
  if (!run) {
    return null;
  }
  const steps = await sql<StepRow[]>`
    select step_index, iteration, type, payload
    from agent_run_steps
    where run_id = ${runId}::uuid
    order by step_index asc
  `;
  return { run, steps };
}

type PlanBody = {
  summary: string;
  steps: string[];
};

type PlanRow = {
  id: string;
  status: string;
  body: PlanBody;
  agent_id: string;
  project_id: string;
  channel_id: string;
  role: string | null;
};

function toPlan(row: {
  id: string;
  status: string;
  body: PlanBody;
  agent_id: string;
}) {
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    body: row.body,
  };
}

export function createRunRoutes(deps: {
  sql: Sql;
  sessionSecret: string;
  continueAfterPlan: (agentId: string) => Promise<void>;
}): Hono {
  const app = new Hono();

  app.get("/channels/:id/runs/latest", async (c) => {
    const user = await currentUser(c, deps.sql, deps.sessionSecret);
    if (!user) {
      return jsonError(c, 401, "unauthorized");
    }
    const channelId = z.string().uuid().safeParse(c.req.param("id"));
    if (!channelId.success) {
      return jsonError(c, 404, "not_found");
    }
    const member = await deps.sql<{ id: string }[]>`
      select channels.id
      from channels
      join memberships on memberships.project_id = channels.project_id
      where channels.id = ${channelId.data}::uuid
        and memberships.user_id = ${user.id}::uuid
    `;
    if (!member[0]) {
      return jsonError(c, 404, "not_found");
    }
    const latest = await deps.sql<{ id: string }[]>`
      select id
      from agent_runs
      where channel_id = ${channelId.data}::uuid
      order by created_at desc, id desc
      limit 1
    `;
    const id = latest[0]?.id;
    if (!id) {
      return c.json({ run: null });
    }
    const loaded = await loadRun(deps.sql, id);
    return c.json({ run: loaded ? toRun(loaded.run, loaded.steps) : null });
  });

  app.get("/agents/:id/runs/:runId", async (c) => {
    const user = await currentUser(c, deps.sql, deps.sessionSecret);
    if (!user) {
      return jsonError(c, 401, "unauthorized");
    }
    const agentId = z.string().uuid().safeParse(c.req.param("id"));
    const runId = z.string().uuid().safeParse(c.req.param("runId"));
    if (!agentId.success || !runId.success) {
      return jsonError(c, 404, "not_found");
    }
    const member = await deps.sql<{ id: string }[]>`
      select agents.id
      from agents
      join memberships on memberships.project_id = agents.project_id
      where agents.id = ${agentId.data}::uuid
        and memberships.user_id = ${user.id}::uuid
    `;
    if (!member[0]) {
      return jsonError(c, 404, "not_found");
    }
    const owned = await deps.sql<{ id: string }[]>`
      select id
      from agent_runs
      where id = ${runId.data}::uuid
        and agent_id = ${agentId.data}::uuid
    `;
    if (!owned[0]) {
      return jsonError(c, 404, "not_found");
    }
    const loaded = await loadRun(deps.sql, runId.data);
    if (!loaded) {
      return jsonError(c, 404, "not_found");
    }
    return c.json({ run: toRun(loaded.run, loaded.steps) });
  });

  app.get("/agents/:id/plans/latest", async (c) => {
    const user = await currentUser(c, deps.sql, deps.sessionSecret);
    if (!user) {
      return jsonError(c, 401, "unauthorized");
    }
    const agentId = z.string().uuid().safeParse(c.req.param("id"));
    if (!agentId.success) {
      return jsonError(c, 404, "not_found");
    }
    const member = await deps.sql<{ id: string }[]>`
      select agents.id
      from agents
      join memberships on memberships.project_id = agents.project_id
      where agents.id = ${agentId.data}::uuid
        and memberships.user_id = ${user.id}::uuid
    `;
    if (!member[0]) {
      return jsonError(c, 404, "not_found");
    }
    const rows = await deps.sql<
      { id: string; status: string; body: PlanBody; agent_id: string }[]
    >`
      select id, status, body, agent_id
      from plans
      where agent_id = ${agentId.data}::uuid
      order by created_at desc, id desc
      limit 1
    `;
    const row = rows[0];
    return c.json({ plan: row ? toPlan(row) : null });
  });

  app.post("/plans/:id/approve", (c) => resolvePlan(c, deps, "approved"));
  app.post("/plans/:id/reject", (c) => resolvePlan(c, deps, "rejected"));

  return app;
}

async function resolvePlan(
  c: Context,
  deps: {
    sql: Sql;
    sessionSecret: string;
    continueAfterPlan: (agentId: string) => Promise<void>;
  },
  nextStatus: "approved" | "rejected",
) {
  const user = await currentUser(c, deps.sql, deps.sessionSecret);
  if (!user) {
    return jsonError(c, 401, "unauthorized");
  }
  const planId = z.string().uuid().safeParse(c.req.param("id"));
  if (!planId.success) {
    return jsonError(c, 404, "not_found");
  }
  const rows = await deps.sql<PlanRow[]>`
    select
      plans.id,
      plans.status,
      plans.body,
      plans.agent_id,
      agents.project_id,
      channels.id as channel_id,
      memberships.role
    from plans
    join agents on agents.id = plans.agent_id
    join channels on channels.agent_id = agents.id
    left join memberships
      on memberships.project_id = agents.project_id
      and memberships.user_id = ${user.id}::uuid
    where plans.id = ${planId.data}::uuid
  `;
  const plan = rows[0];
  if (!plan?.role) {
    return jsonError(c, 404, "not_found");
  }
  if (plan.role !== "owner") {
    return jsonError(c, 403, "forbidden");
  }
  if (plan.status === "draft") {
    return jsonError(c, 409, "plan_superseded");
  }
  if (plan.status === "approved" || plan.status === "rejected") {
    return c.json({ plan: toPlan(plan) });
  }
  const notice =
    nextStatus === "approved"
      ? "Owner approved the plan."
      : "Owner rejected the plan.";
  const updated = await deps.sql.begin(async (tx) => {
    const changed = await tx<
      { id: string; status: string; body: PlanBody; agent_id: string }[]
    >`
      update plans
      set
        status = ${nextStatus},
        resolved_by_user_id = ${user.id}::uuid,
        updated_at = now()
      where id = ${plan.id}::uuid
        and status = 'awaiting'
      returning id, status, body, agent_id
    `;
    const row = changed[0];
    if (!row) {
      return null;
    }
    await tx`
      update agents
      set status = 'idle', updated_at = now()
      where id = ${plan.agent_id}::uuid
    `;
    const messages = await tx<{ id: string; created_at: Date }[]>`
      insert into messages (channel_id, author_kind, body)
      values (${plan.channel_id}::uuid, 'system', ${notice})
      returning id, created_at
    `;
    return { row, message: messages[0] };
  });
  if (!updated) {
    const again = await deps.sql<PlanRow[]>`
      select
        plans.id,
        plans.status,
        plans.body,
        plans.agent_id,
        agents.project_id,
        channels.id as channel_id,
        memberships.role
      from plans
      join agents on agents.id = plans.agent_id
      join channels on channels.agent_id = agents.id
      left join memberships
        on memberships.project_id = agents.project_id
        and memberships.user_id = ${user.id}::uuid
      where plans.id = ${plan.id}::uuid
    `;
    const current = again[0];
    if (!current) {
      return jsonError(c, 404, "not_found");
    }
    if (current.status === "draft") {
      return jsonError(c, 409, "plan_superseded");
    }
    return c.json({ plan: toPlan(current) });
  }
  publish(plan.channel_id, "plan.updated", {
    planId: updated.row.id,
    agentId: updated.row.agent_id,
    status: updated.row.status,
    body: updated.row.body,
  });
  if (updated.message) {
    publishMessageCreated(plan.channel_id, {
      id: updated.message.id,
      body: notice,
      authorKind: "system",
      authorUserId: null,
      createdAt: updated.message.created_at.toISOString(),
    });
  }
  await deps.continueAfterPlan(plan.agent_id);
  return c.json({ plan: toPlan(updated.row) });
}
