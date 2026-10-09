import type { Context } from "hono";
import { Hono } from "hono";
import type { Sql } from "postgres";
import { z } from "zod";
import { currentUser, type SessionUser } from "../auth/routes";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_BODY = 8000;
const MAX_IDEMPOTENCY_KEY = 200;

const postMessageSchema = z.object({
  body: z.string().trim().min(1).max(MAX_BODY),
});

type MessageRow = {
  id: string;
  body: string;
  author_kind: "user" | "agent" | "system";
  author_user_id: string | null;
  created_at: Date;
  idempotency_key: string | null;
};

type MessageView = {
  id: string;
  body: string;
  authorKind: MessageRow["author_kind"];
  authorUserId: string | null;
  createdAt: string;
  idempotencyKey: string | null;
};

function jsonError(c: Context, status: 400 | 401 | 404 | 409, error: string) {
  return c.json({ error }, status);
}

function isResponse(value: SessionUser | Response): value is Response {
  return value instanceof Response;
}

function toMessage(row: MessageRow): MessageView {
  return {
    id: row.id,
    body: row.body,
    authorKind: row.author_kind,
    authorUserId: row.author_user_id,
    createdAt: row.created_at.toISOString(),
    idempotencyKey: row.idempotency_key,
  };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { at: string; id: string } | null {
  try {
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = text.lastIndexOf("|");
    if (separator <= 0) {
      return null;
    }
    const at = text.slice(0, separator);
    const id = text.slice(separator + 1);
    if (
      !z.string().uuid().safeParse(id).success ||
      Number.isNaN(Date.parse(at))
    ) {
      return null;
    }
    return { at, id };
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

async function memberChannel(
  sql: Sql,
  channelId: string,
  userId: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    select channels.id
    from channels
    join memberships on memberships.project_id = channels.project_id
    where channels.id = ${channelId}::uuid
      and memberships.user_id = ${userId}::uuid
  `;
  return Boolean(rows[0]);
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function createChannelRoutes(deps: {
  sql: Sql;
  sessionSecret: string;
}): Hono {
  const app = new Hono();

  app.get("/projects/:id/channels", async (c) => {
    const user = await requireUser(c, deps.sql, deps.sessionSecret);
    if (isResponse(user)) {
      return user;
    }
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    if (!projectId.success) {
      return jsonError(c, 404, "not_found");
    }
    const membership = await deps.sql<{ role: string }[]>`
      select role from memberships
      where project_id = ${projectId.data}::uuid
        and user_id = ${user.id}::uuid
    `;
    if (!membership[0]) {
      return jsonError(c, 404, "not_found");
    }
    const channels = await deps.sql<
      { id: string; name: string; kind: string; status: string }[]
    >`
      select channels.id, agents.name, agents.kind, agents.status
      from channels
      join agents on agents.id = channels.agent_id
      where channels.project_id = ${projectId.data}::uuid
      order by agents.kind, agents.name
    `;
    return c.json({
      channels: channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        kind: channel.kind,
        status: channel.status,
        unread: 0,
      })),
    });
  });

  app.get("/channels/:id/messages", async (c) => {
    const user = await requireUser(c, deps.sql, deps.sessionSecret);
    if (isResponse(user)) {
      return user;
    }
    const channelId = z.string().uuid().safeParse(c.req.param("id"));
    if (!channelId.success) {
      return jsonError(c, 404, "not_found");
    }
    if (!(await memberChannel(deps.sql, channelId.data, user.id))) {
      return jsonError(c, 404, "not_found");
    }
    const limitParsed = z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .safeParse(c.req.query("limit") ?? DEFAULT_LIMIT);
    if (!limitParsed.success) {
      return jsonError(c, 400, "invalid_request");
    }
    const limit = limitParsed.data;
    const cursorText = c.req.query("cursor");
    const cursor = cursorText ? decodeCursor(cursorText) : null;
    if (cursorText && !cursor) {
      return jsonError(c, 400, "invalid_request");
    }

    const rows = cursor
      ? await deps.sql<MessageRow[]>`
          select id, body, author_kind, author_user_id, created_at, idempotency_key
          from messages
          where channel_id = ${channelId.data}::uuid
            and (created_at, id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)
          order by created_at desc, id desc
          limit ${limit + 1}
        `
      : await deps.sql<MessageRow[]>`
          select id, body, author_kind, author_user_id, created_at, idempotency_key
          from messages
          where channel_id = ${channelId.data}::uuid
          order by created_at desc, id desc
          limit ${limit + 1}
        `;
    const hasOlder = rows.length > limit;
    const page = (hasOlder ? rows.slice(0, limit) : rows).reverse();
    const oldest = page[0];
    return c.json({
      messages: page.map(toMessage),
      nextCursor:
        hasOlder && oldest ? encodeCursor(oldest.created_at, oldest.id) : null,
    });
  });

  app.post("/channels/:id/messages", async (c) => {
    const user = await requireUser(c, deps.sql, deps.sessionSecret);
    if (isResponse(user)) {
      return user;
    }
    const channelId = z.string().uuid().safeParse(c.req.param("id"));
    if (!channelId.success) {
      return jsonError(c, 404, "not_found");
    }
    if (!(await memberChannel(deps.sql, channelId.data, user.id))) {
      return jsonError(c, 404, "not_found");
    }
    const parsed = postMessageSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request");
    }
    const rawKey = c.req.header("idempotency-key")?.trim() ?? "";
    const idempotencyKey = rawKey.length > 0 ? rawKey : null;
    if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY) {
      return jsonError(c, 400, "invalid_request");
    }
    if (idempotencyKey) {
      const replay = await findByKey(deps.sql, channelId.data, idempotencyKey);
      if (replay) {
        if (replay.body !== parsed.data.body) {
          return jsonError(c, 409, "idempotency_conflict");
        }
        return c.json(toMessage(replay), 200);
      }
    }
    try {
      const inserted = await deps.sql<MessageRow[]>`
        insert into messages (
          channel_id, author_kind, author_user_id, body, idempotency_key
        ) values (
          ${channelId.data}::uuid,
          'user',
          ${user.id}::uuid,
          ${parsed.data.body},
          ${idempotencyKey}
        )
        returning id, body, author_kind, author_user_id, created_at, idempotency_key
      `;
      const message = inserted[0];
      if (!message) {
        return jsonError(c, 400, "invalid_request");
      }
      return c.json(toMessage(message), 201);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "";
      if (code !== "23505" || !idempotencyKey) {
        throw error;
      }
      const replay = await findByKey(deps.sql, channelId.data, idempotencyKey);
      if (replay && replay.body === parsed.data.body) {
        return c.json(toMessage(replay), 200);
      }
      return jsonError(c, 409, "idempotency_conflict");
    }
  });

  return app;
}

async function findByKey(
  sql: Sql,
  channelId: string,
  idempotencyKey: string,
): Promise<MessageRow | undefined> {
  const existing = await sql<MessageRow[]>`
    select id, body, author_kind, author_user_id, created_at, idempotency_key
    from messages
    where channel_id = ${channelId}::uuid
      and idempotency_key = ${idempotencyKey}
  `;
  return existing[0];
}
