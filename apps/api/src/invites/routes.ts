import type { Context } from "hono";
import { Hono } from "hono";
import type { Sql } from "postgres";
import { z } from "zod";
import { newToken, sha256 } from "../auth/crypto";
import { mailErrorCode, type Mailer } from "../auth/mail";
import type { RateLimiter } from "../auth/rate-limit";
import { currentUser, type SessionUser } from "../auth/routes";

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), {
    message: "invalid_email",
  });

const inviteBodySchema = z.object({
  email: emailSchema,
});

const tokenBodySchema = z.object({
  token: z.string().min(1),
});

const declineBodySchema = z
  .object({
    token: z.string().min(1).optional(),
    inviteId: z.string().uuid().optional(),
  })
  .refine(
    (value) => value.token !== undefined || value.inviteId !== undefined,
    {
      message: "empty",
    },
  );

type InviteRow = {
  id: string;
  project_id: string;
  email: string;
  status: string;
  expires_at: Date;
};

function jsonError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 429,
  error: string,
) {
  return c.json({ error }, status);
}

function toInvite(row: InviteRow) {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
  };
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

async function projectRole(
  sql: Sql,
  projectId: string,
  userId: string,
): Promise<string | null> {
  const rows = await sql<{ role: string }[]>`
    select role from memberships
    where project_id = ${projectId}::uuid
      and user_id = ${userId}::uuid
  `;
  return rows[0]?.role ?? null;
}

async function sendInvite(input: {
  mailer: Mailer;
  appUrl: string;
  to: string;
  projectName: string;
  token: string;
}): Promise<void> {
  const link = `${input.appUrl}/invites/accept?token=${encodeURIComponent(input.token)}`;
  await input.mailer.send({
    to: input.to,
    subject: `Join ${input.projectName} on Dawk`,
    text: [
      `You are invited to ${input.projectName} on Dawk.`,
      link,
      "",
      "This link expires in 7 days and works once.",
    ].join("\n"),
  });
}

export function createInviteRoutes(deps: {
  sql: Sql;
  sessionSecret: string;
  appUrl: string;
  mailer: Mailer;
  rateLimiter: RateLimiter;
}): Hono {
  const app = new Hono();

  app.get("/invites", async (c) => {
    const user = await currentUser(c, deps.sql, deps.sessionSecret);
    if (!user) {
      return jsonError(c, 401, "unauthorized");
    }
    const rows = await deps.sql<
      { id: string; project_id: string; name: string; expires_at: Date }[]
    >`
      select invites.id, invites.project_id, projects.name, invites.expires_at
      from invites
      join projects on projects.id = invites.project_id
      where invites.email = ${user.email}
        and invites.status = 'pending'
        and invites.expires_at > now()
      order by invites.created_at desc
    `;
    return c.json({
      invites: rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        projectName: row.name,
        expiresAt: row.expires_at.toISOString(),
      })),
    });
  });

  app.post("/invites/accept", async (c) => {
    const user = await currentUser(c, deps.sql, deps.sessionSecret);
    if (!user) {
      return jsonError(c, 401, "unauthorized");
    }
    const parsed = tokenBodySchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request");
    }
    return acceptInvite(c, deps.sql, user, { token: parsed.data.token });
  });

  app.post("/invites/:inviteId/accept", async (c) => {
    const user = await currentUser(c, deps.sql, deps.sessionSecret);
    if (!user) {
      return jsonError(c, 401, "unauthorized");
    }
    const inviteId = z.string().uuid().safeParse(c.req.param("inviteId"));
    if (!inviteId.success) {
      return jsonError(c, 404, "invite_invalid");
    }
    return acceptInvite(c, deps.sql, user, { inviteId: inviteId.data });
  });

  app.post("/invites/decline", async (c) => {
    const user = await currentUser(c, deps.sql, deps.sessionSecret);
    if (!user) {
      return jsonError(c, 401, "unauthorized");
    }
    const parsed = declineBodySchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request");
    }
    const invite = await findInvite(deps.sql, parsed.data);
    if (!invite) {
      return jsonError(c, 404, "invite_invalid");
    }
    if (invite.email !== user.email) {
      return jsonError(c, 403, "invite_email_mismatch");
    }
    if (invite.status === "declined") {
      return c.json({ ok: true });
    }
    if (invite.status !== "pending") {
      return jsonError(c, 409, statusError(invite.status));
    }
    if (invite.expires_at.getTime() <= Date.now()) {
      await markExpired(deps.sql, invite.id);
      return jsonError(c, 409, "invite_expired");
    }
    await deps.sql`
      update invites
      set status = 'declined'
      where id = ${invite.id}::uuid
        and status = 'pending'
    `;
    return c.json({ ok: true });
  });

  app.get("/projects/:id/invites", async (c) => {
    const user = await currentUser(c, deps.sql, deps.sessionSecret);
    if (!user) {
      return jsonError(c, 401, "unauthorized");
    }
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    if (!projectId.success) {
      return jsonError(c, 404, "not_found");
    }
    const role = await projectRole(deps.sql, projectId.data, user.id);
    if (!role) {
      return jsonError(c, 404, "not_found");
    }
    if (role !== "owner") {
      return jsonError(c, 403, "forbidden");
    }
    const rows = await deps.sql<InviteRow[]>`
      select id, project_id, email, status, expires_at
      from invites
      where project_id = ${projectId.data}::uuid
        and status = 'pending'
        and expires_at > now()
      order by created_at desc
    `;
    return c.json({ invites: rows.map(toInvite) });
  });

  app.post("/projects/:id/invites", async (c) => {
    const user = await currentUser(c, deps.sql, deps.sessionSecret);
    if (!user) {
      return jsonError(c, 401, "unauthorized");
    }
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    if (!projectId.success) {
      return jsonError(c, 404, "not_found");
    }
    const role = await projectRole(deps.sql, projectId.data, user.id);
    if (!role) {
      return jsonError(c, 404, "not_found");
    }
    if (role !== "owner") {
      return jsonError(c, 403, "forbidden");
    }
    if (!deps.rateLimiter.allow(`invite:${user.id}`)) {
      return jsonError(c, 429, "rate_limited");
    }
    const parsed = inviteBodySchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request");
    }
    const project = await deps.sql<{ name: string }[]>`
      select name from projects where id = ${projectId.data}::uuid
    `;
    const projectName = project[0]?.name;
    if (!projectName) {
      return jsonError(c, 404, "not_found");
    }
    const member = await deps.sql<{ id: string }[]>`
      select users.id
      from users
      join memberships on memberships.user_id = users.id
      where users.email = ${parsed.data.email}
        and memberships.project_id = ${projectId.data}::uuid
    `;
    if (member[0]) {
      return jsonError(c, 409, "already_member");
    }
    const token = newToken();
    const hash = sha256(token);
    const pending = await deps.sql<InviteRow[]>`
      update invites
      set token_hash = ${hash}, expires_at = now() + interval '7 days'
      where project_id = ${projectId.data}::uuid
        and email = ${parsed.data.email}
        and status = 'pending'
      returning id, project_id, email, status, expires_at
    `;
    let invite = pending[0];
    if (!invite) {
      const inserted = await deps.sql<InviteRow[]>`
        insert into invites (project_id, email, token_hash, status, expires_at)
        values (
          ${projectId.data}::uuid,
          ${parsed.data.email},
          ${hash},
          'pending',
          now() + interval '7 days'
        )
        returning id, project_id, email, status, expires_at
      `;
      invite = inserted[0];
    }
    if (!invite) {
      return jsonError(c, 400, "invalid_request");
    }
    try {
      await sendInvite({
        mailer: deps.mailer,
        appUrl: deps.appUrl,
        to: invite.email,
        projectName,
        token,
      });
    } catch (error) {
      return jsonError(c, 422, mailErrorCode(error));
    }
    return c.json(toInvite(invite), pending[0] ? 200 : 201);
  });

  app.delete("/projects/:id/invites/:inviteId", async (c) => {
    const user = await currentUser(c, deps.sql, deps.sessionSecret);
    if (!user) {
      return jsonError(c, 401, "unauthorized");
    }
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    const inviteId = z.string().uuid().safeParse(c.req.param("inviteId"));
    if (!projectId.success || !inviteId.success) {
      return jsonError(c, 404, "not_found");
    }
    const role = await projectRole(deps.sql, projectId.data, user.id);
    if (!role) {
      return jsonError(c, 404, "not_found");
    }
    if (role !== "owner") {
      return jsonError(c, 403, "forbidden");
    }
    const revoked = await deps.sql<{ id: string }[]>`
      update invites
      set status = 'revoked'
      where id = ${inviteId.data}::uuid
        and project_id = ${projectId.data}::uuid
        and status = 'pending'
      returning id
    `;
    if (!revoked[0]) {
      return jsonError(c, 404, "not_found");
    }
    return c.json({ ok: true });
  });

  return app;
}

function statusError(status: string): string {
  if (status === "revoked") {
    return "invite_revoked";
  }
  if (status === "expired") {
    return "invite_expired";
  }
  if (status === "declined") {
    return "invite_declined";
  }
  return "invite_invalid";
}

async function findInvite(
  sql: Sql,
  input: { token?: string; inviteId?: string },
): Promise<InviteRow | null> {
  if (input.token) {
    const rows = await sql<InviteRow[]>`
      select id, project_id, email, status, expires_at
      from invites
      where token_hash = ${sha256(input.token)}
    `;
    return rows[0] ?? null;
  }
  if (!input.inviteId) {
    return null;
  }
  const rows = await sql<InviteRow[]>`
    select id, project_id, email, status, expires_at
    from invites
    where id = ${input.inviteId}::uuid
  `;
  return rows[0] ?? null;
}

async function markExpired(sql: Sql, inviteId: string): Promise<void> {
  await sql`
    update invites
    set status = 'expired'
    where id = ${inviteId}::uuid
      and status = 'pending'
  `;
}

async function acceptInvite(
  c: Context,
  sql: Sql,
  user: SessionUser,
  input: { token?: string; inviteId?: string },
) {
  const invite = await findInvite(sql, input);
  if (!invite) {
    return jsonError(c, 404, "invite_invalid");
  }
  if (invite.email !== user.email) {
    return jsonError(c, 403, "invite_email_mismatch");
  }
  if (invite.status === "revoked") {
    return jsonError(c, 409, "invite_revoked");
  }
  if (invite.status === "declined") {
    return jsonError(c, 409, "invite_declined");
  }
  if (
    invite.status === "expired" ||
    invite.expires_at.getTime() <= Date.now()
  ) {
    if (invite.status === "pending") {
      await markExpired(sql, invite.id);
    }
    return jsonError(c, 409, "invite_expired");
  }
  if (invite.status === "accepted") {
    return c.json({ projectId: invite.project_id });
  }
  if (invite.status !== "pending") {
    return jsonError(c, 404, "invite_invalid");
  }
  await sql.begin(async (tx) => {
    await tx`
      insert into memberships (project_id, user_id, role)
      values (${invite.project_id}::uuid, ${user.id}::uuid, 'member')
      on conflict (project_id, user_id) do nothing
    `;
    await tx`
      update invites
      set status = 'accepted'
      where id = ${invite.id}::uuid
        and status = 'pending'
    `;
  });
  return c.json({ projectId: invite.project_id });
}
