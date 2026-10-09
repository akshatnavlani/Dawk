import type { Context } from "hono";
import { Hono } from "hono";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import { currentUser } from "../auth/routes";
import { publish, publishMessageCreated } from "../channels/hub";

const proposeSchema = z.object({
  proposal: z.string().trim().min(1).max(2000),
  originChannelId: z.string().uuid(),
  impactAgentIds: z.array(z.string().uuid()).max(20).optional(),
});

type DecisionRow = {
  id: string;
  status: string;
  proposal: string;
  project_id: string;
  origin_channel_id: string | null;
  impact_agent_ids: string[];
  proposed_by_user_id: string | null;
  proposed_by_agent_id: string | null;
  accepted_by_user_id: string | null;
  proposer_email: string | null;
  proposer_agent: string | null;
  support_count: number;
};

function jsonError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409,
  error: string,
) {
  return c.json({ error }, status);
}

function toDecision(row: DecisionRow) {
  const proposer = row.proposed_by_agent_id
    ? { kind: "agent" as const, label: row.proposer_agent ?? "Agent" }
    : { kind: "user" as const, label: row.proposer_email ?? "Member" };
  return {
    id: row.id,
    status: row.status,
    proposal: row.proposal,
    originChannelId: row.origin_channel_id,
    impactAgentIds: row.impact_agent_ids ?? [],
    supportCount: Number(row.support_count),
    proposer,
  };
}

async function loadDecision(
  sql: Sql,
  decisionId: string,
  userId: string,
): Promise<(DecisionRow & { role: string | null }) | null> {
  const rows = await sql<(DecisionRow & { role: string | null })[]>`
    select
      decisions.id,
      decisions.status,
      decisions.proposal,
      decisions.project_id,
      decisions.origin_channel_id,
      decisions.impact_agent_ids,
      decisions.proposed_by_user_id,
      decisions.proposed_by_agent_id,
      decisions.accepted_by_user_id,
      users.email as proposer_email,
      agents.name as proposer_agent,
      (
        select count(*)::int
        from decision_supports
        where decision_supports.decision_id = decisions.id
      ) as support_count,
      memberships.role
    from decisions
    left join users on users.id = decisions.proposed_by_user_id
    left join agents on agents.id = decisions.proposed_by_agent_id
    left join memberships
      on memberships.project_id = decisions.project_id
      and memberships.user_id = ${userId}::uuid
    where decisions.id = ${decisionId}::uuid
  `;
  return rows[0] ?? null;
}

async function noticeChannels(
  sql: Sql | TransactionSql,
  projectId: string,
  originChannelId: string | null,
  impactAgentIds: string[],
): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select distinct channels.id
    from channels
    where channels.project_id = ${projectId}::uuid
      and (
        channels.id = ${originChannelId}::uuid
        or channels.agent_id = any(${impactAgentIds}::uuid[])
        or channels.agent_id in (
          select id from agents
          where project_id = ${projectId}::uuid
            and kind = 'orchestrator'
        )
      )
  `;
  return rows.map((row) => row.id);
}

async function postNotice(
  tx: TransactionSql,
  channelId: string,
  body: string,
): Promise<{ id: string; created_at: Date }> {
  const rows = await tx<{ id: string; created_at: Date }[]>`
    insert into messages (channel_id, author_kind, body)
    values (${channelId}::uuid, 'system', ${body})
    returning id, created_at
  `;
  const row = rows[0];
  if (!row) {
    throw new Error("notice insert failed");
  }
  return row;
}

export function createDecisionRoutes(deps: {
  sql: Sql;
  sessionSecret: string;
}): Hono {
  const app = new Hono();

  app.get("/projects/:id/brief", async (c) => {
    const user = await currentUser(c, deps.sql, deps.sessionSecret);
    if (!user) {
      return jsonError(c, 401, "unauthorized");
    }
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    if (!projectId.success) {
      return jsonError(c, 404, "not_found");
    }
    const member = await deps.sql<{ role: string }[]>`
      select role from memberships
      where project_id = ${projectId.data}::uuid
        and user_id = ${user.id}::uuid
    `;
    if (!member[0]) {
      return jsonError(c, 404, "not_found");
    }
    const rows = await deps.sql<{ content: Record<string, unknown> }[]>`
      select content from project_briefs
      where project_id = ${projectId.data}::uuid
    `;
    return c.json({ brief: rows[0]?.content ?? {} });
  });

  app.get("/projects/:id/decisions", async (c) => {
    const user = await currentUser(c, deps.sql, deps.sessionSecret);
    if (!user) {
      return jsonError(c, 401, "unauthorized");
    }
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    if (!projectId.success) {
      return jsonError(c, 404, "not_found");
    }
    const member = await deps.sql<{ role: string }[]>`
      select role from memberships
      where project_id = ${projectId.data}::uuid
        and user_id = ${user.id}::uuid
    `;
    if (!member[0]) {
      return jsonError(c, 404, "not_found");
    }
    const rows = await deps.sql<DecisionRow[]>`
      select
        decisions.id,
        decisions.status,
        decisions.proposal,
        decisions.project_id,
        decisions.origin_channel_id,
        decisions.impact_agent_ids,
        decisions.proposed_by_user_id,
        decisions.proposed_by_agent_id,
        decisions.accepted_by_user_id,
        users.email as proposer_email,
        agents.name as proposer_agent,
        (
          select count(*)::int
          from decision_supports
          where decision_supports.decision_id = decisions.id
        ) as support_count
      from decisions
      left join users on users.id = decisions.proposed_by_user_id
      left join agents on agents.id = decisions.proposed_by_agent_id
      where decisions.project_id = ${projectId.data}::uuid
      order by decisions.created_at desc, decisions.id desc
    `;
    return c.json({ decisions: rows.map(toDecision) });
  });

  app.post("/projects/:id/decisions", async (c) => {
    const user = await currentUser(c, deps.sql, deps.sessionSecret);
    if (!user) {
      return jsonError(c, 401, "unauthorized");
    }
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    if (!projectId.success) {
      return jsonError(c, 404, "not_found");
    }
    const member = await deps.sql<{ role: string }[]>`
      select role from memberships
      where project_id = ${projectId.data}::uuid
        and user_id = ${user.id}::uuid
    `;
    if (!member[0]) {
      return jsonError(c, 404, "not_found");
    }
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const parsed = proposeSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request");
    }
    const channel = await deps.sql<{ id: string }[]>`
      select id from channels
      where id = ${parsed.data.originChannelId}::uuid
        and project_id = ${projectId.data}::uuid
    `;
    if (!channel[0]) {
      return jsonError(c, 400, "invalid_request");
    }
    const impact = parsed.data.impactAgentIds;
    if (impact && impact.length > 0) {
      const found = await deps.sql<{ n: number }[]>`
        select count(*)::int as n from agents
        where project_id = ${projectId.data}::uuid
          and id = any(${impact}::uuid[])
      `;
      if (Number(found[0]?.n ?? 0) !== impact.length) {
        return jsonError(c, 400, "invalid_request");
      }
    }
    const created = await deps.sql<DecisionRow[]>`
      insert into decisions (
        project_id, status, proposal, proposed_by_user_id,
        origin_channel_id, impact_agent_ids
      )
      values (
        ${projectId.data}::uuid,
        'pending',
        ${parsed.data.proposal},
        ${user.id}::uuid,
        ${parsed.data.originChannelId}::uuid,
        coalesce(
          ${impact && impact.length > 0 ? impact : null}::uuid[],
          (
            select array_agg(id)
            from agents
            where project_id = ${projectId.data}::uuid
          ),
          '{}'::uuid[]
        )
      )
      returning
        id, status, proposal, project_id, origin_channel_id, impact_agent_ids,
        proposed_by_user_id, proposed_by_agent_id, accepted_by_user_id
    `;
    const row = created[0];
    if (!row) {
      return jsonError(c, 400, "invalid_request");
    }
    const view = toDecision({
      ...row,
      proposer_email: null,
      proposer_agent: null,
      support_count: 0,
    });
    publish(parsed.data.originChannelId, "decision.updated", {
      decisionId: row.id,
      projectId: projectId.data,
      status: "pending",
      proposal: row.proposal,
    });
    return c.json({ decision: view }, 201);
  });

  app.post("/decisions/:id/support", async (c) => {
    const user = await currentUser(c, deps.sql, deps.sessionSecret);
    if (!user) {
      return jsonError(c, 401, "unauthorized");
    }
    const decisionId = z.string().uuid().safeParse(c.req.param("id"));
    if (!decisionId.success) {
      return jsonError(c, 404, "not_found");
    }
    const decision = await loadDecision(deps.sql, decisionId.data, user.id);
    if (!decision?.role) {
      return jsonError(c, 404, "not_found");
    }
    if (decision.status !== "pending") {
      return jsonError(c, 409, "decision_not_pending");
    }
    await deps.sql`
      insert into decision_supports (decision_id, user_id)
      values (${decision.id}::uuid, ${user.id}::uuid)
      on conflict (decision_id, user_id) do nothing
    `;
    const again = await loadDecision(deps.sql, decision.id, user.id);
    if (decision.origin_channel_id) {
      publish(decision.origin_channel_id, "decision.updated", {
        decisionId: decision.id,
        projectId: decision.project_id,
        status: "pending",
        proposal: decision.proposal,
      });
    }
    return c.json({
      decision: again ? toDecision(again) : toDecision(decision),
    });
  });

  app.post("/decisions/:id/accept", (c) => settle(c, deps, "accepted"));
  app.post("/decisions/:id/reject", (c) => settle(c, deps, "rejected"));

  return app;
}

async function settle(
  c: Context,
  deps: { sql: Sql; sessionSecret: string },
  nextStatus: "accepted" | "rejected",
) {
  const user = await currentUser(c, deps.sql, deps.sessionSecret);
  if (!user) {
    return jsonError(c, 401, "unauthorized");
  }
  const decisionId = z.string().uuid().safeParse(c.req.param("id"));
  if (!decisionId.success) {
    return jsonError(c, 404, "not_found");
  }
  const decision = await loadDecision(deps.sql, decisionId.data, user.id);
  if (!decision?.role) {
    return jsonError(c, 404, "not_found");
  }
  if (decision.role !== "owner") {
    return jsonError(c, 403, "forbidden");
  }
  if (decision.status === nextStatus) {
    return c.json({ decision: toDecision(decision) });
  }
  if (decision.status !== "pending") {
    return jsonError(c, 409, "decision_not_pending");
  }
  const notice =
    nextStatus === "accepted"
      ? `Decision accepted: ${decision.proposal}`
      : `Decision rejected: ${decision.proposal}`;
  const saved = await deps.sql.begin(async (tx) => {
    const changed = await tx<DecisionRow[]>`
      update decisions
      set
        status = ${nextStatus},
        accepted_by_user_id = case
          when ${nextStatus === "accepted"} then ${user.id}::uuid
          else null
        end,
        updated_at = now()
      where id = ${decision.id}::uuid
        and status = 'pending'
      returning
        id, status, proposal, project_id, origin_channel_id, impact_agent_ids,
        proposed_by_user_id, proposed_by_agent_id, accepted_by_user_id
    `;
    const row = changed[0];
    if (!row) {
      return null;
    }
    const channels =
      nextStatus === "accepted"
        ? await noticeChannels(
            tx,
            decision.project_id,
            decision.origin_channel_id,
            decision.impact_agent_ids ?? [],
          )
        : decision.origin_channel_id
          ? [decision.origin_channel_id]
          : [];
    if (nextStatus === "accepted") {
      await tx`
        update project_briefs
        set
          content = jsonb_set(
            content,
            '{pins}',
            coalesce(content->'pins', '[]'::jsonb) || jsonb_build_array(
              jsonb_build_object(
                'decisionId', ${row.id}::text,
                'proposal', ${row.proposal}::text
              )
            ),
            true
          ),
          updated_at = now()
        where project_id = ${decision.project_id}::uuid
      `;
    }
    const messages: { channelId: string; id: string; created_at: Date }[] = [];
    for (const channelId of channels) {
      const message = await postNotice(tx, channelId, notice);
      messages.push({ channelId, ...message });
    }
    return { row, messages };
  });
  if (!saved) {
    const again = await loadDecision(deps.sql, decision.id, user.id);
    if (!again) {
      return jsonError(c, 404, "not_found");
    }
    if (again.status === nextStatus) {
      return c.json({ decision: toDecision(again) });
    }
    return jsonError(c, 409, "decision_not_pending");
  }
  for (const message of saved.messages) {
    publishMessageCreated(message.channelId, {
      id: message.id,
      body: notice,
      authorKind: "system",
      authorUserId: null,
      createdAt: message.created_at.toISOString(),
    });
    publish(message.channelId, "decision.updated", {
      decisionId: saved.row.id,
      projectId: decision.project_id,
      status: nextStatus,
      proposal: decision.proposal,
    });
  }
  const view = await loadDecision(deps.sql, saved.row.id, user.id);
  return c.json({
    decision: view
      ? toDecision(view)
      : toDecision({
          ...saved.row,
          proposer_email: decision.proposer_email,
          proposer_agent: decision.proposer_agent,
          support_count: decision.support_count,
        }),
  });
}
