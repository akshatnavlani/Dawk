import type { Context } from "hono";
import { Hono } from "hono";
import type { Sql } from "postgres";
import { z } from "zod";
import { currentUser, type SessionUser } from "../auth/routes";
import { encryptSecret } from "./crypto";

const providerSchema = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);
const labelSchema = z.string().trim().min(1).max(200);
const secretSchema = z.string().min(4).max(500);
const modelSchema = z.string().trim().min(1).max(200);

const createCredentialSchema = z.object({
  provider: providerSchema,
  label: labelSchema,
  secret: secretSchema,
  isPrimary: z.boolean().optional(),
});

const patchCredentialSchema = z
  .object({
    isPrimary: z.boolean().optional(),
    fallbackOrder: z.number().int().nonnegative().optional(),
    status: z.enum(["active", "exhausted", "disabled"]).optional(),
  })
  .refine(
    (value) =>
      value.isPrimary !== undefined ||
      value.fallbackOrder !== undefined ||
      value.status !== undefined,
    { message: "empty" },
  );

const routingSchema = z.object({
  credentialId: z.string().uuid().nullable(),
  modelId: modelSchema.nullable(),
});

type CredentialRow = {
  id: string;
  provider: string;
  label: string;
  status: "active" | "exhausted" | "disabled";
  is_primary: boolean;
  fallback_order: number;
  last_four: string | null;
};

type CredentialView = {
  id: string;
  provider: string;
  label: string;
  status: CredentialRow["status"];
  isPrimary: boolean;
  fallbackOrder: number;
  lastFour: string | null;
};

function jsonError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409,
  error: string,
) {
  return c.json({ error }, status);
}

function isResponse(value: SessionUser | Response): value is Response {
  return value instanceof Response;
}

function toView(row: CredentialRow): CredentialView {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    status: row.status,
    isPrimary: row.is_primary,
    fallbackOrder: row.fallback_order,
    lastFour: row.last_four,
  };
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

async function requireOwner(
  c: Context,
  sql: Sql,
  sessionSecret: string,
  projectId: string,
): Promise<SessionUser | Response> {
  const user = await currentUser(c, sql, sessionSecret);
  if (!user) {
    return jsonError(c, 401, "unauthorized");
  }
  const membership = await sql<{ role: string }[]>`
    select role from memberships
    where project_id = ${projectId}::uuid
      and user_id = ${user.id}::uuid
  `;
  const role = membership[0]?.role;
  if (!role) {
    return jsonError(c, 404, "not_found");
  }
  if (role !== "owner") {
    return jsonError(c, 403, "forbidden");
  }
  return user;
}

function isConstraint(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String(error.code) === code
  );
}

export function createCredentialRoutes(deps: {
  sql: Sql;
  sessionSecret: string;
  encryptionKey: string;
}): Hono {
  const app = new Hono();

  app.get("/projects/:id/credentials", async (c) => {
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    if (!projectId.success) {
      return jsonError(c, 404, "not_found");
    }
    const owner = await requireOwner(
      c,
      deps.sql,
      deps.sessionSecret,
      projectId.data,
    );
    if (isResponse(owner)) {
      return owner;
    }
    const rows = await deps.sql<CredentialRow[]>`
      select id, provider, label, status, is_primary, fallback_order, last_four
      from provider_credentials
      where project_id = ${projectId.data}::uuid
      order by fallback_order
    `;
    return c.json({ credentials: rows.map(toView) });
  });

  app.post("/projects/:id/credentials", async (c) => {
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    if (!projectId.success) {
      return jsonError(c, 404, "not_found");
    }
    const owner = await requireOwner(
      c,
      deps.sql,
      deps.sessionSecret,
      projectId.data,
    );
    if (isResponse(owner)) {
      return owner;
    }
    const parsed = createCredentialSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request");
    }
    const sealed = encryptSecret(parsed.data.secret, deps.encryptionKey);
    const tail = parsed.data.secret.slice(-4);
    const created = await deps.sql.begin(async (tx) => {
      if (parsed.data.isPrimary) {
        await tx`
          update provider_credentials
          set is_primary = false, updated_at = now()
          where project_id = ${projectId.data}::uuid
            and is_primary
        `;
      }
      const nextOrder = await tx<{ next_order: number }[]>`
        select coalesce(max(fallback_order), -1) + 1 as next_order
        from provider_credentials
        where project_id = ${projectId.data}::uuid
      `;
      const order = nextOrder[0]?.next_order ?? 0;
      const rows = await tx<CredentialRow[]>`
        insert into provider_credentials (
          project_id, provider, encrypted_secret, secret_nonce,
          encryption_key_version, label, status, is_primary, fallback_order,
          last_four
        ) values (
          ${projectId.data}::uuid,
          ${parsed.data.provider},
          ${sealed.ciphertext},
          ${sealed.nonce},
          ${sealed.version},
          ${parsed.data.label},
          'active',
          ${parsed.data.isPrimary ?? false},
          ${order},
          ${tail}
        )
        returning id, provider, label, status, is_primary, fallback_order, last_four
      `;
      return rows[0];
    });
    if (!created) {
      return jsonError(c, 400, "invalid_request");
    }
    return c.json(toView(created), 201);
  });

  app.patch("/projects/:id/credentials/:credId", async (c) => {
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    const credentialId = z.string().uuid().safeParse(c.req.param("credId"));
    if (!projectId.success || !credentialId.success) {
      return jsonError(c, 404, "not_found");
    }
    const owner = await requireOwner(
      c,
      deps.sql,
      deps.sessionSecret,
      projectId.data,
    );
    if (isResponse(owner)) {
      return owner;
    }
    const parsed = patchCredentialSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request");
    }
    const updated = await deps.sql.begin(async (tx) => {
      const current = await tx<{ id: string; fallback_order: number }[]>`
        select id, fallback_order
        from provider_credentials
        where id = ${credentialId.data}::uuid
          and project_id = ${projectId.data}::uuid
      `;
      const row = current[0];
      if (!row) {
        return null;
      }
      if (
        parsed.data.fallbackOrder !== undefined &&
        parsed.data.fallbackOrder !== row.fallback_order
      ) {
        const occupant = await tx<{ id: string }[]>`
          select id from provider_credentials
          where project_id = ${projectId.data}::uuid
            and fallback_order = ${parsed.data.fallbackOrder}
            and id <> ${credentialId.data}::uuid
        `;
        const other = occupant[0];
        if (other) {
          const parked = await tx<{ next_order: number }[]>`
            select coalesce(max(fallback_order), 0) + 1 as next_order
            from provider_credentials
            where project_id = ${projectId.data}::uuid
          `;
          const park = parked[0]?.next_order ?? row.fallback_order + 1;
          await tx`
            update provider_credentials
            set fallback_order = ${park}, updated_at = now()
            where id = ${other.id}::uuid
          `;
          await tx`
            update provider_credentials
            set fallback_order = ${parsed.data.fallbackOrder}, updated_at = now()
            where id = ${credentialId.data}::uuid
          `;
          await tx`
            update provider_credentials
            set fallback_order = ${row.fallback_order}, updated_at = now()
            where id = ${other.id}::uuid
          `;
        } else {
          await tx`
            update provider_credentials
            set fallback_order = ${parsed.data.fallbackOrder}, updated_at = now()
            where id = ${credentialId.data}::uuid
          `;
        }
      }
      if (parsed.data.isPrimary === true) {
        await tx`
          update provider_credentials
          set is_primary = false, updated_at = now()
          where project_id = ${projectId.data}::uuid
            and id <> ${credentialId.data}::uuid
            and is_primary
        `;
      }
      await tx`
        update provider_credentials
        set
          is_primary = case
            when ${parsed.data.isPrimary !== undefined} then ${parsed.data.isPrimary ?? false}
            else is_primary
          end,
          status = case
            when ${parsed.data.status !== undefined} then ${parsed.data.status ?? "active"}
            else status
          end,
          updated_at = now()
        where id = ${credentialId.data}::uuid
          and project_id = ${projectId.data}::uuid
      `;
      const rows = await tx<CredentialRow[]>`
        select id, provider, label, status, is_primary, fallback_order, last_four
        from provider_credentials
        where id = ${credentialId.data}::uuid
      `;
      return rows[0] ?? null;
    });
    if (!updated) {
      return jsonError(c, 404, "not_found");
    }
    return c.json(toView(updated));
  });

  app.delete("/projects/:id/credentials/:credId", async (c) => {
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    const credentialId = z.string().uuid().safeParse(c.req.param("credId"));
    if (!projectId.success || !credentialId.success) {
      return jsonError(c, 404, "not_found");
    }
    const owner = await requireOwner(
      c,
      deps.sql,
      deps.sessionSecret,
      projectId.data,
    );
    if (isResponse(owner)) {
      return owner;
    }
    try {
      const removed = await deps.sql.begin(async (tx) => {
        const existing = await tx<{ id: string }[]>`
          select id from provider_credentials
          where id = ${credentialId.data}::uuid
            and project_id = ${projectId.data}::uuid
        `;
        if (!existing[0]) {
          return false;
        }
        await tx`
          update agents
          set credential_id = null, updated_at = now()
          where project_id = ${projectId.data}::uuid
            and credential_id = ${credentialId.data}::uuid
        `;
        await tx`
          delete from provider_credentials
          where id = ${credentialId.data}::uuid
            and project_id = ${projectId.data}::uuid
        `;
        return true;
      });
      if (!removed) {
        return jsonError(c, 404, "not_found");
      }
      return c.json({ ok: true });
    } catch (error) {
      if (isConstraint(error, "23503")) {
        return jsonError(c, 409, "credential_in_use");
      }
      throw error;
    }
  });

  app.patch("/projects/:id/agents/:agentId/routing", async (c) => {
    const projectId = z.string().uuid().safeParse(c.req.param("id"));
    const agentId = z.string().uuid().safeParse(c.req.param("agentId"));
    if (!projectId.success || !agentId.success) {
      return jsonError(c, 404, "not_found");
    }
    const owner = await requireOwner(
      c,
      deps.sql,
      deps.sessionSecret,
      projectId.data,
    );
    if (isResponse(owner)) {
      return owner;
    }
    const parsed = routingSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request");
    }
    if (parsed.data.credentialId) {
      const credential = await deps.sql<{ id: string }[]>`
        select id from provider_credentials
        where id = ${parsed.data.credentialId}::uuid
          and project_id = ${projectId.data}::uuid
      `;
      if (!credential[0]) {
        return jsonError(c, 400, "credential_not_in_project");
      }
    }
    const rows = await deps.sql<
      { credential_id: string | null; model_id: string | null }[]
    >`
      update agents
      set
        credential_id = ${parsed.data.credentialId},
        model_id = ${parsed.data.modelId},
        updated_at = now()
      where id = ${agentId.data}::uuid
        and project_id = ${projectId.data}::uuid
      returning credential_id, model_id
    `;
    const row = rows[0];
    if (!row) {
      return jsonError(c, 404, "not_found");
    }
    return c.json({
      credentialId: row.credential_id,
      modelId: row.model_id,
    });
  });

  return app;
}
