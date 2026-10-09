import type { Context } from "hono";
import { Hono } from "hono";
import type { Sql } from "postgres";
import { z } from "zod";
import { currentUser } from "../auth/routes";

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

function jsonError(c: Context, status: 401 | 404, error: string) {
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

export function createRunRoutes(deps: {
  sql: Sql;
  sessionSecret: string;
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

  return app;
}
