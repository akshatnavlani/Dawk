import type { Context } from "hono";
import { Hono } from "hono";
import type { Sql } from "postgres";
import { z } from "zod";
import { currentUser, type SessionUser } from "../auth/routes";
import { publishSpecialistCreated, spawnSpecialist } from "./spawn";

const nameSchema = z.string().trim().min(1).max(200);
const spendCapSchema = z.number().nonnegative().nullable();

const createProjectSchema = z.object({
  name: nameSchema,
  spendCap: spendCapSchema.optional(),
});

const spawnSchema = z.object({
  kind: z.enum(["frontend", "backend"]),
  brief: z.string().trim().max(2000).optional(),
});

const patchProjectSchema = z
  .object({
    name: nameSchema.optional(),
    spendCap: spendCapSchema.optional(),
    llmPaused: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.spendCap !== undefined ||
      value.llmPaused !== undefined,
    { message: "empty" },
  );

type ProjectRole = "owner" | "member";

type Orchestrator = {
  agentId: string;
  channelId: string;
  name: string;
  status: string;
};

type ProjectView = {
  id: string;
  name: string;
  role: ProjectRole;
  spendCap: number | null;
  spendUsed: number;
  llmPaused: boolean;
  orchestrator: Orchestrator | null;
};

type ProjectRow = {
  id: string;
  name: string;
  role: ProjectRole;
  spend_cap: string | null;
  spend_used: string;
  llm_paused: boolean;
  agent_id: string | null;
  channel_id: string | null;
  agent_name: string | null;
  agent_status: string | null;
};

function jsonError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409,
  error: string,
) {
  return c.json({ error }, status);
}

function money(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }
  return Number(value);
}

function toProject(row: ProjectRow): ProjectView {
  const orchestrator =
    row.agent_id && row.channel_id && row.agent_name && row.agent_status
      ? {
          agentId: row.agent_id,
          channelId: row.channel_id,
          name: row.agent_name,
          status: row.agent_status,
        }
      : null;
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    spendCap: money(row.spend_cap),
    spendUsed: Number(row.spend_used),
    llmPaused: row.llm_paused,
    orchestrator,
  };
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

async function requireUser(
  c: Context,
  sql: Sql,
  sessionSecret: string,
): Promise<SessionUser | Response> {
  const user = await currentUser(c, sql, sessionSecret);
  if (!user) {
    return jsonError(c, 401, "unauthorized");
  }
  return user;
}

function isResponse(value: SessionUser | Response): value is Response {
  return value instanceof Response;
}

export function createProjectRoutes(deps: {
  sql: Sql;
  sessionSecret: string;
  onSpendChange?: (projectId: string) => Promise<void>;
}): Hono {
  const app = new Hono();

  app.get("/projects", async (c) => {
    const user = await requireUser(c, deps.sql, deps.sessionSecret);
    if (isResponse(user)) {
      return user;
    }
    const rows = await deps.sql<ProjectRow[]>`
      select
        projects.id,
        projects.name,
        memberships.role,
        projects.spend_cap,
        projects.spend_used,
        projects.llm_paused,
        agents.id as agent_id,
        channels.id as channel_id,
        agents.name as agent_name,
        agents.status as agent_status
      from memberships
      join projects on projects.id = memberships.project_id
      left join agents
        on agents.project_id = projects.id
        and agents.kind = 'orchestrator'
      left join channels on channels.agent_id = agents.id
      where memberships.user_id = ${user.id}::uuid
      order by projects.created_at desc
    `;
    return c.json({ projects: rows.map(toProject) });
  });

  app.post("/projects", async (c) => {
    const user = await requireUser(c, deps.sql, deps.sessionSecret);
    if (isResponse(user)) {
      return user;
    }
    const parsed = createProjectSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request");
    }
    const spendCap = parsed.data.spendCap ?? null;
    const created = await deps.sql.begin(async (tx) => {
      const projects = await tx<{ id: string }[]>`
        insert into projects (name, owner_user_id, spend_cap)
        values (${parsed.data.name}, ${user.id}::uuid, ${spendCap})
        returning id
      `;
      const project = projects[0];
      if (!project) {
        throw new Error("project insert failed");
      }
      await tx`
        insert into memberships (project_id, user_id, role)
        values (${project.id}::uuid, ${user.id}::uuid, 'owner')
      `;
      await tx`
        insert into project_briefs (project_id, content)
        values (${project.id}::uuid, '{}'::jsonb)
      `;
      const agents = await tx<{ id: string }[]>`
        insert into agents (project_id, kind, name, status, skill_id)
        select
          ${project.id}::uuid,
          'orchestrator',
          'Orchestrator',
          'idle',
          skills.id
        from skills
        where skills.slug = 'orchestrator'
          and skills.version = 1
        returning id
      `;
      const agent = agents[0];
      if (!agent) {
        throw new Error("orchestrator insert failed");
      }
      const channels = await tx<{ id: string }[]>`
        insert into channels (project_id, agent_id)
        values (${project.id}::uuid, ${agent.id}::uuid)
        returning id
      `;
      const channel = channels[0];
      if (!channel) {
        throw new Error("channel insert failed");
      }
      return {
        id: project.id,
        orchestrator: {
          agentId: agent.id,
          channelId: channel.id,
          name: "Orchestrator",
          status: "idle",
        },
      };
    });
    return c.json(
      {
        id: created.id,
        name: parsed.data.name,
        role: "owner",
        spendCap,
        spendUsed: 0,
        llmPaused: false,
        orchestrator: created.orchestrator,
      },
      201,
    );
  });

  app.get("/projects/:id", async (c) => {
    const user = await requireUser(c, deps.sql, deps.sessionSecret);
    if (isResponse(user)) {
      return user;
    }
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    if (!projectId.success) {
      return jsonError(c, 404, "not_found");
    }
    const rows = await deps.sql<ProjectRow[]>`
      select
        projects.id,
        projects.name,
        memberships.role,
        projects.spend_cap,
        projects.spend_used,
        projects.llm_paused,
        agents.id as agent_id,
        channels.id as channel_id,
        agents.name as agent_name,
        agents.status as agent_status
      from memberships
      join projects on projects.id = memberships.project_id
      left join agents
        on agents.project_id = projects.id
        and agents.kind = 'orchestrator'
      left join channels on channels.agent_id = agents.id
      where projects.id = ${projectId.data}::uuid
        and memberships.user_id = ${user.id}::uuid
    `;
    const row = rows[0];
    if (!row) {
      return jsonError(c, 404, "not_found");
    }
    return c.json(toProject(row));
  });

  app.get("/projects/:id/members", async (c) => {
    const user = await requireUser(c, deps.sql, deps.sessionSecret);
    if (isResponse(user)) {
      return user;
    }
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    if (!projectId.success) {
      return jsonError(c, 404, "not_found");
    }
    const membership = await deps.sql<{ role: ProjectRole }[]>`
      select role from memberships
      where project_id = ${projectId.data}::uuid
        and user_id = ${user.id}::uuid
    `;
    if (!membership[0]) {
      return jsonError(c, 404, "not_found");
    }
    const members = await deps.sql<
      { id: string; email: string; role: ProjectRole }[]
    >`
      select users.id, users.email, memberships.role
      from memberships
      join users on users.id = memberships.user_id
      where memberships.project_id = ${projectId.data}::uuid
      order by memberships.role desc, users.email
    `;
    return c.json({ members });
  });

  app.patch("/projects/:id", async (c) => {
    const user = await requireUser(c, deps.sql, deps.sessionSecret);
    if (isResponse(user)) {
      return user;
    }
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    if (!projectId.success) {
      return jsonError(c, 404, "not_found");
    }
    const parsed = patchProjectSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request");
    }
    const membership = await deps.sql<{ role: ProjectRole }[]>`
      select role from memberships
      where project_id = ${projectId.data}::uuid
        and user_id = ${user.id}::uuid
    `;
    const role = membership[0]?.role;
    if (!role) {
      return jsonError(c, 404, "not_found");
    }
    if (role !== "owner") {
      return jsonError(c, 403, "forbidden");
    }
    await deps.sql`
      update projects
      set
        name = case when ${parsed.data.name !== undefined} then ${parsed.data.name ?? ""} else name end,
        spend_cap = case when ${parsed.data.spendCap !== undefined} then ${parsed.data.spendCap ?? null} else spend_cap end,
        llm_paused = case when ${parsed.data.llmPaused !== undefined} then ${parsed.data.llmPaused ?? false} else llm_paused end,
        updated_at = now()
      where id = ${projectId.data}::uuid
    `;
    const rows = await deps.sql<ProjectRow[]>`
      select
        projects.id,
        projects.name,
        memberships.role,
        projects.spend_cap,
        projects.spend_used,
        projects.llm_paused,
        agents.id as agent_id,
        channels.id as channel_id,
        agents.name as agent_name,
        agents.status as agent_status
      from memberships
      join projects on projects.id = memberships.project_id
      left join agents
        on agents.project_id = projects.id
        and agents.kind = 'orchestrator'
      left join channels on channels.agent_id = agents.id
      where projects.id = ${projectId.data}::uuid
        and memberships.user_id = ${user.id}::uuid
    `;
    const row = rows[0];
    if (!row) {
      return jsonError(c, 404, "not_found");
    }
    if (
      parsed.data.spendCap !== undefined ||
      parsed.data.llmPaused !== undefined
    ) {
      await deps.onSpendChange?.(projectId.data);
    }
    return c.json(toProject(row));
  });

  app.get("/projects/:id/agents", async (c) => {
    const user = await requireUser(c, deps.sql, deps.sessionSecret);
    if (isResponse(user)) {
      return user;
    }
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    if (!projectId.success) {
      return jsonError(c, 404, "not_found");
    }
    const membership = await deps.sql<{ role: ProjectRole }[]>`
      select role from memberships
      where project_id = ${projectId.data}::uuid
        and user_id = ${user.id}::uuid
    `;
    if (!membership[0]) {
      return jsonError(c, 404, "not_found");
    }
    const agents = await deps.sql<
      { id: string; name: string; kind: string; status: string }[]
    >`
      select agents.id, agents.name, skills.slug as kind, agents.status
      from agents
      join skills on skills.id = agents.skill_id
      where agents.project_id = ${projectId.data}::uuid
      order by agents.kind, agents.name
    `;
    return c.json({ agents });
  });

  app.post("/projects/:id/agents", async (c) => {
    const user = await requireUser(c, deps.sql, deps.sessionSecret);
    if (isResponse(user)) {
      return user;
    }
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    if (!projectId.success) {
      return jsonError(c, 404, "not_found");
    }
    const membership = await deps.sql<{ role: ProjectRole }[]>`
      select role from memberships
      where project_id = ${projectId.data}::uuid
        and user_id = ${user.id}::uuid
    `;
    if (!membership[0]) {
      return jsonError(c, 404, "not_found");
    }
    if (membership[0].role !== "owner") {
      return jsonError(c, 403, "forbidden");
    }
    const parsed = spawnSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request");
    }
    const created = await deps.sql.begin((tx) =>
      spawnSpecialist(tx, {
        projectId: projectId.data,
        kind: parsed.data.kind,
        brief: parsed.data.brief,
      }),
    );
    if (!created) {
      return jsonError(c, 409, "specialist_exists");
    }
    await publishSpecialistCreated(deps.sql, projectId.data, created);
    return c.json(
      {
        agentId: created.agentId,
        channelId: created.channelId,
        name: created.name,
        kind: created.kind,
      },
      201,
    );
  });

  return app;
}
