import type { TransactionSql } from "postgres";
import { createSql } from "./db";
import { loadDatabaseEnv } from "./env";
import { migrateDown, migrateUp } from "./migrate";

const ROLLBACK = "schema-test-rollback";

const ownerId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
const extraId = "00000000-0000-4000-8000-000000000003";
const projectId = "00000000-0000-4000-8000-000000000010";
const otherProjectId = "00000000-0000-4000-8000-000000000011";
const skillId = "00000000-0000-4000-8000-000000000020";
const credentialId = "00000000-0000-4000-8000-000000000030";
const otherCredentialId = "00000000-0000-4000-8000-000000000031";
const orchestratorId = "00000000-0000-4000-8000-000000000040";
const specialistId = "00000000-0000-4000-8000-000000000041";
const otherAgentId = "00000000-0000-4000-8000-000000000042";
const channelId = "00000000-0000-4000-8000-000000000050";
const otherChannelId = "00000000-0000-4000-8000-000000000051";
const runId = "00000000-0000-4000-8000-000000000060";
const messageId = "00000000-0000-4000-8000-000000000070";
const noticeId = "00000000-0000-4000-8000-000000000071";
const decisionId = "00000000-0000-4000-8000-000000000080";

const expectedTables = [
  "agent_run_steps",
  "agent_runs",
  "agent_summaries",
  "agents",
  "channels",
  "conflicts",
  "decision_supports",
  "decisions",
  "email_change_tokens",
  "instruction_queue_items",
  "invites",
  "magic_link_tokens",
  "memberships",
  "messages",
  "oauth_states",
  "plans",
  "project_briefs",
  "projects",
  "provider_credentials",
  "sessions",
  "skills",
  "users",
];

class Rollback extends Error {
  constructor() {
    super(ROLLBACK);
  }
}

function isConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("23")
  );
}

function isRollback(error: unknown): boolean {
  return (
    error instanceof Rollback ||
    (error instanceof Error && error.message.includes(ROLLBACK))
  );
}

async function expectConstraint(
  sql: TransactionSql,
  label: string,
  run: (sql: TransactionSql) => Promise<unknown>,
): Promise<void> {
  try {
    await sql.savepoint((sp) => run(sp));
  } catch (error) {
    if (!isConstraintViolation(error)) {
      throw new Error(`${label} failed unexpectedly`);
    }
    return;
  }
  throw new Error(`${label} was allowed`);
}

async function seed(sql: TransactionSql): Promise<void> {
  await sql`
    insert into users (id, email, password_hash)
    values (${ownerId}::uuid, 'owner@example.com', 'hash-placeholder')
  `;
  await sql`
    insert into users (id, email, google_sub)
    values (${memberId}::uuid, 'member@example.com', 'google-sub-1')
  `;
  await sql`
    insert into users (id, email)
    values (${extraId}::uuid, 'extra@example.com')
  `;
  await sql`
    insert into projects (id, name, owner_user_id, spend_cap)
    values (${projectId}::uuid, 'Poker', ${ownerId}::uuid, 25)
  `;
  await sql`
    insert into projects (id, name, owner_user_id)
    values (${otherProjectId}::uuid, 'Other', ${ownerId}::uuid)
  `;
  await sql`
    insert into memberships (project_id, user_id, role)
    values
      (${projectId}::uuid, ${ownerId}::uuid, 'owner'),
      (${projectId}::uuid, ${memberId}::uuid, 'member'),
      (${otherProjectId}::uuid, ${ownerId}::uuid, 'owner')
  `;
  await sql`
    insert into project_briefs (project_id, content)
    values (${projectId}::uuid, ${sql.json({ goals: ["ship"] })})
  `;
  await sql`
    insert into provider_credentials (
      id, project_id, provider, encrypted_secret, secret_nonce, label,
      status, is_primary, fallback_order
    ) values (
      ${credentialId}::uuid,
      ${projectId}::uuid,
      'anthropic',
      ${Buffer.from("ciphertext")},
      ${Buffer.from("nonce-value")},
      'Claude',
      'active',
      true,
      0
    )
  `;
  await sql`
    insert into provider_credentials (
      id, project_id, provider, encrypted_secret, secret_nonce, label,
      status, is_primary, fallback_order
    ) values (
      ${otherCredentialId}::uuid,
      ${otherProjectId}::uuid,
      'openai',
      ${Buffer.from("other-ciphertext")},
      ${Buffer.from("other-nonce")},
      'Other',
      'active',
      true,
      0
    )
  `;
  await sql`
    insert into skills (id, slug, name, system_prompt_pack, version)
    values (
      ${skillId}::uuid,
      'schema_orchestrator',
      'Orchestrator',
      'Plan with the team.',
      1
    )
  `;
  await sql`
    insert into agents (
      id, project_id, kind, name, skill_id, status, credential_id, model_id
    ) values (
      ${orchestratorId}::uuid,
      ${projectId}::uuid,
      'orchestrator',
      'Orchestrator',
      ${skillId}::uuid,
      'idle',
      ${credentialId}::uuid,
      'claude'
    )
  `;
  await sql`
    insert into agents (id, project_id, kind, name, status)
    values (
      ${specialistId}::uuid,
      ${projectId}::uuid,
      'specialist',
      'Frontend',
      'idle'
    )
  `;
  await sql`
    insert into agents (id, project_id, kind, name, status)
    values (
      ${otherAgentId}::uuid,
      ${otherProjectId}::uuid,
      'orchestrator',
      'Other orchestrator',
      'idle'
    )
  `;
  await sql`
    insert into channels (id, project_id, agent_id)
    values
      (${channelId}::uuid, ${projectId}::uuid, ${orchestratorId}::uuid),
      (${otherChannelId}::uuid, ${otherProjectId}::uuid, ${otherAgentId}::uuid)
  `;
  await sql`
    insert into agent_runs (
      id, project_id, channel_id, agent_id, kind, status, credential_id_used,
      model_used, token_in, token_out, cost_est
    ) values (
      ${runId}::uuid,
      ${projectId}::uuid,
      ${channelId}::uuid,
      ${orchestratorId}::uuid,
      'main',
      'succeeded',
      ${credentialId}::uuid,
      'claude',
      10,
      20,
      0.01
    )
  `;
  await sql`
    insert into agent_run_steps (run_id, step_index, iteration, type, payload)
    values (
      ${runId}::uuid,
      1,
      1,
      'trace',
      ${sql.json({ note: "working" })}
    )
  `;
  await sql`
    insert into messages (
      id, channel_id, author_kind, author_user_id, body, run_id, idempotency_key
    ) values (
      ${messageId}::uuid,
      ${channelId}::uuid,
      'user',
      ${ownerId}::uuid,
      'Let us plan the poker app.',
      ${runId}::uuid,
      'client-key-1'
    )
  `;
  await sql`
    insert into messages (id, channel_id, author_kind, body)
    values (${noticeId}::uuid, ${channelId}::uuid, 'system', 'Spawn notice')
  `;
  await sql`
    insert into plans (agent_id, status, body)
    values (
      ${orchestratorId}::uuid,
      'draft',
      ${sql.json({ summary: "draft plan" })}
    )
  `;
  await sql`
    insert into decisions (
      id, project_id, status, proposal, proposed_by_agent_id, origin_channel_id,
      impact_agent_ids
    ) values (
      ${decisionId}::uuid,
      ${projectId}::uuid,
      'pending',
      'Support light and dark theme.',
      ${specialistId}::uuid,
      ${channelId}::uuid,
      ARRAY[${specialistId}::uuid]
    )
  `;
  await sql`
    insert into decision_supports (decision_id, user_id)
    values (${decisionId}::uuid, ${memberId}::uuid)
  `;
  await sql`
    insert into conflicts (channel_id, options, status)
    values (
      ${channelId}::uuid,
      ${sql.json(["keep light", "add dark"])},
      'open'
    )
  `;
  await sql`
    insert into instruction_queue_items (channel_id, message_id, status)
    values (${channelId}::uuid, ${messageId}::uuid, 'pending')
  `;
  await sql`
    insert into agent_summaries (project_id, agent_id, summary)
    values (${projectId}::uuid, ${orchestratorId}::uuid, 'Planning poker.')
  `;
  await sql`
    insert into agent_summaries (project_id, summary)
    values (${projectId}::uuid, 'Project is a poker app.')
  `;
  await sql`
    insert into invites (project_id, email, token_hash, status, expires_at)
    values (
      ${projectId}::uuid,
      'new@example.com',
      '0123456789abcdef0123456789abcdef',
      'pending',
      now() + interval '1 day'
    )
  `;
}

async function rejectInvalid(sql: TransactionSql): Promise<void> {
  await expectConstraint(sql, "second owner membership", (sp) => {
    return sp`
      insert into memberships (project_id, user_id, role)
      values (${projectId}::uuid, ${extraId}::uuid, 'owner')
    `;
  });
  await expectConstraint(sql, "second orchestrator", (sp) => {
    return sp`
      insert into agents (project_id, kind, name, status)
      values (${projectId}::uuid, 'orchestrator', 'Another', 'idle')
    `;
  });
  await expectConstraint(sql, "cross-project channel", (sp) => {
    return sp`
      insert into channels (project_id, agent_id)
      values (${projectId}::uuid, ${otherAgentId}::uuid)
    `;
  });
  await expectConstraint(sql, "cross-project credential", (sp) => {
    return sp`
      update agents
      set credential_id = ${otherCredentialId}::uuid
      where id = ${orchestratorId}::uuid
    `;
  });
  await expectConstraint(sql, "second primary credential", (sp) => {
    return sp`
      insert into provider_credentials (
        project_id, provider, encrypted_secret, secret_nonce, label,
        status, is_primary, fallback_order
      ) values (
        ${projectId}::uuid,
        'google',
        ${Buffer.from("ciphertext-2")},
        ${Buffer.from("nonce-value-2")},
        'Gemini',
        'active',
        true,
        1
      )
    `;
  });
  await expectConstraint(sql, "empty credential ciphertext", (sp) => {
    return sp`
      insert into provider_credentials (
        project_id, provider, encrypted_secret, secret_nonce, label,
        status, is_primary, fallback_order
      ) values (
        ${projectId}::uuid,
        'xai',
        ${Buffer.alloc(0)},
        ${Buffer.from("nonce")},
        'Empty',
        'active',
        false,
        2
      )
    `;
  });
  await expectConstraint(sql, "user message without author", (sp) => {
    return sp`
      insert into messages (channel_id, author_kind, body)
      values (${channelId}::uuid, 'user', 'missing author')
    `;
  });
  await expectConstraint(sql, "queue item on another channel", (sp) => {
    return sp`
      insert into instruction_queue_items (channel_id, message_id, status)
      values (${otherChannelId}::uuid, ${noticeId}::uuid, 'pending')
    `;
  });
  await expectConstraint(sql, "decision with two proposers", (sp) => {
    return sp`
      insert into decisions (
        project_id, status, proposal, proposed_by_user_id, proposed_by_agent_id
      ) values (
        ${projectId}::uuid,
        'pending',
        'Both proposed.',
        ${ownerId}::uuid,
        ${specialistId}::uuid
      )
    `;
  });
  await expectConstraint(sql, "accepted decision without owner", (sp) => {
    return sp`
      insert into decisions (
        project_id, status, proposal, proposed_by_user_id, accepted_by_user_id
      ) values (
        ${projectId}::uuid,
        'accepted',
        'Accepted too early.',
        ${ownerId}::uuid,
        null
      )
    `;
  });
  await expectConstraint(sql, "second open conflict", (sp) => {
    return sp`
      insert into conflicts (channel_id, options, status)
      values (${channelId}::uuid, ${sql.json(["a", "b"])}, 'open')
    `;
  });
  await expectConstraint(sql, "impact agent from another project", (sp) => {
    return sp`
      update decisions
      set impact_agent_ids = ARRAY[${otherAgentId}::uuid]
      where id = ${decisionId}::uuid
    `;
  });
  await expectConstraint(sql, "origin channel from another project", (sp) => {
    return sp`
      update decisions
      set origin_channel_id = ${otherChannelId}::uuid
      where id = ${decisionId}::uuid
    `;
  });
  await expectConstraint(sql, "duplicate decision support", (sp) => {
    return sp`
      insert into decision_supports (decision_id, user_id)
      values (${decisionId}::uuid, ${memberId}::uuid)
    `;
  });
}

async function assertTables(
  sql: TransactionSql | ReturnType<typeof createSql>,
): Promise<void> {
  const rows = await sql<{ tablename: string }[]>`
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename <> 'schema_migrations'
    order by tablename
  `;
  const names = rows.map((row) => row.tablename);
  if (names.join() !== expectedTables.join()) {
    throw new Error("Phase 1 tables do not match the expected set");
  }
}

async function assertCredentialColumns(sql: TransactionSql): Promise<void> {
  const rows = await sql<{ column_name: string }[]>`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'provider_credentials'
  `;
  const names = new Set(rows.map((row) => row.column_name));
  for (const required of [
    "encrypted_secret",
    "secret_nonce",
    "encryption_key_version",
  ]) {
    if (!names.has(required)) {
      throw new Error(`provider_credentials is missing ${required}`);
    }
  }
  for (const forbidden of ["api_key", "secret", "plaintext", "token"]) {
    if (names.has(forbidden)) {
      throw new Error(`provider_credentials must not store ${forbidden}`);
    }
  }
}

async function columnExists(
  sql: ReturnType<typeof createSql>,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    select exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = ${table}
        and column_name = ${column}
    ) as exists
  `;
  return rows[0]?.exists === true;
}

async function skillPack(
  sql: ReturnType<typeof createSql>,
  slug: string,
): Promise<string | null> {
  const rows = await sql<{ system_prompt_pack: string }[]>`
    select system_prompt_pack
    from skills
    where slug = ${slug}
      and version = 1
  `;
  return rows[0]?.system_prompt_pack ?? null;
}

async function skillSlugExists(
  sql: ReturnType<typeof createSql>,
  slug: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    select exists (
      select 1 from skills where slug = ${slug}
    ) as exists
  `;
  return rows[0]?.exists === true;
}

async function indexExists(
  sql: ReturnType<typeof createSql>,
  name: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    select exists (
      select 1
      from pg_indexes
      where schemaname = 'public'
        and indexname = ${name}
    ) as exists
  `;
  return rows[0]?.exists === true;
}

async function tableExists(
  sql: ReturnType<typeof createSql>,
  name: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    select exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = ${name}
    ) as exists
  `;
  return rows[0]?.exists === true;
}

async function main(): Promise<void> {
  const env = loadDatabaseEnv();
  const sql = createSql(env.DATABASE_URL);

  try {
    await migrateUp(sql);
    try {
      await sql.begin(async (tx) => {
        await assertTables(tx);
        await assertCredentialColumns(tx);
        await seed(tx);
        await rejectInvalid(tx);
        throw new Rollback();
      });
    } catch (error) {
      if (!isRollback(error)) {
        throw error;
      }
    }

    const leftover = await sql<{ n: number }[]>`
      select count(*)::int as n from users
    `;
    if (Number(leftover[0]?.n ?? 0) !== 0) {
      throw new Error("Constraint test left rows behind");
    }
    const catalog = await sql<{ n: number }[]>`
      select count(*)::int as n from skills
    `;
    if (Number(catalog[0]?.n ?? 0) !== 3) {
      throw new Error("Skill catalog was not seeded");
    }

    await migrateDown(sql, { force: true });
    const rolledOrchestrator = await skillPack(sql, "orchestrator");
    if (rolledOrchestrator?.includes("status spawn")) {
      throw new Error("Spawn down migration left the spawn instruction");
    }
    const rolledFrontend = await skillPack(sql, "frontend");
    const rolledBackend = await skillPack(sql, "backend");
    if (
      rolledFrontend?.includes("Pending decisions are not facts.") ||
      rolledBackend?.includes("Pending decisions are not facts.")
    ) {
      throw new Error("Spawn down migration left the specialist pack");
    }
    if (
      !rolledFrontend?.includes(
        "You cannot edit a repository, run commands, or call tools.",
      )
    ) {
      throw new Error("Spawn down migration removed the frontend pack");
    }
    if (!(await indexExists(sql, "agent_runs_one_active_qa"))) {
      throw new Error("Spawn down migration removed the qa index");
    }

    await migrateDown(sql, { force: true });
    if (await indexExists(sql, "agent_runs_one_active_qa")) {
      throw new Error("Queue down migration left the qa index");
    }
    if (!(await skillSlugExists(sql, "orchestrator"))) {
      throw new Error("Queue down migration removed the orchestrator pack");
    }
    if (!(await indexExists(sql, "plans_one_awaiting"))) {
      throw new Error("Queue down migration removed the awaiting index");
    }

    await migrateDown(sql, { force: true });
    if (!(await skillSlugExists(sql, "orchestrator"))) {
      throw new Error("Decision down migration removed the orchestrator pack");
    }
    if (!(await indexExists(sql, "plans_one_awaiting"))) {
      throw new Error("Decision down migration removed the awaiting index");
    }

    await migrateDown(sql, { force: true });
    if (await indexExists(sql, "plans_one_awaiting")) {
      throw new Error("Plan down migration left the awaiting index");
    }
    if (!(await skillSlugExists(sql, "orchestrator"))) {
      throw new Error("Plan down migration removed the orchestrator pack");
    }
    if (!(await columnExists(sql, "provider_credentials", "last_four"))) {
      throw new Error("Plan down migration removed last_four");
    }

    await migrateDown(sql, { force: true });
    if (await skillSlugExists(sql, "orchestrator")) {
      throw new Error("Skill down migration left the orchestrator pack");
    }
    if (await indexExists(sql, "agent_runs_one_active_main")) {
      throw new Error("Skill down migration left the active-run index");
    }
    if (!(await columnExists(sql, "provider_credentials", "last_four"))) {
      throw new Error("Skill down migration removed last_four");
    }

    await migrateDown(sql);
    if (await columnExists(sql, "provider_credentials", "last_four")) {
      throw new Error("Mask down migration left last_four in place");
    }
    if (!(await tableExists(sql, "sessions"))) {
      throw new Error("Mask down migration removed sessions");
    }

    await migrateDown(sql);
    if (await tableExists(sql, "sessions")) {
      throw new Error("Auth down migration left sessions in place");
    }
    if (!(await tableExists(sql, "users"))) {
      throw new Error("Auth down migration removed phase 1 tables");
    }

    await migrateDown(sql);
    if (await tableExists(sql, "users")) {
      throw new Error("Down migration left users in place");
    }

    await migrateUp(sql);
    if (
      !(await tableExists(sql, "users")) ||
      !(await tableExists(sql, "sessions")) ||
      !(await columnExists(sql, "provider_credentials", "last_four")) ||
      !(await skillSlugExists(sql, "orchestrator")) ||
      !(await indexExists(sql, "plans_one_awaiting")) ||
      !(await indexExists(sql, "agent_runs_one_active_qa"))
    ) {
      throw new Error(
        "Up migration did not restore users, sessions, last_four, skills, and plans",
      );
    }
    const frontendPack = await skillPack(sql, "frontend");
    if (
      !frontendPack?.includes("Pending decisions are not facts.") ||
      !frontendPack.includes(
        "Only lines under Accepted decisions: are accepted.",
      ) ||
      !frontendPack.includes(
        "Answer the human's question. Mention an accepted decision only when it bears on that question.",
      ) ||
      !frontendPack.includes(
        "You cannot edit a repository, run commands, or call tools.",
      )
    ) {
      throw new Error("Up migration did not update the frontend pack");
    }
    const backendPack = await skillPack(sql, "backend");
    if (
      !backendPack?.includes("Pending decisions are not facts.") ||
      !backendPack.includes(
        "Only lines under Accepted decisions: are accepted.",
      ) ||
      !backendPack.includes(
        "Answer the human's question. Mention an accepted decision only when it bears on that question.",
      ) ||
      !backendPack.includes(
        "You cannot edit a repository, run commands, or call tools.",
      )
    ) {
      throw new Error("Up migration did not update the backend pack");
    }
    const orchestratorPack = await skillPack(sql, "orchestrator");
    if (
      !orchestratorPack?.includes("status spawn") ||
      !orchestratorPack.includes(
        "You cannot edit a repository, run commands, or call tools.",
      )
    ) {
      throw new Error("Up migration did not update the orchestrator pack");
    }

    console.log("schema: constraints ok");
  } catch (error) {
    const text = error instanceof Error ? error.message : "schema test failed";
    console.error(text.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]"));
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

if (import.meta.main) {
  await main();
}
