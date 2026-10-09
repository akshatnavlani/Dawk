import type { Sql } from "postgres";
import { z } from "zod";
import { publish, publishMessageCreated } from "../channels/hub";
import { decryptSecret } from "../credentials/crypto";
import {
  defaultModel,
  type LlmClient,
  LlmError,
  type LlmResult,
  supportsProvider,
} from "./provider";

export const MAX_MAIN_ITERATIONS = 8;
export const QA_MAX_ITERATIONS = 3;
const MESSAGE_WINDOW = 20;
const QA_MESSAGE_WINDOW = 5;
const QUEUE_LIMIT = 20;
const runRequests = new Map<string, string>();
const changeRequest =
  /^(please\s+)?(add|change|update|remove|delete|fix|build|implement|make)\b/i;

const planBodySchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  steps: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
});

const conflictBodySchema = z.object({
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(500),
      }),
    )
    .min(2)
    .max(8),
});

const turnSchema = z
  .object({
    status: z.enum(["working", "final", "plan", "decision", "conflict"]),
    notes: z.string().trim().min(1).max(4000),
    answer: z.string().trim().min(1).max(8000).optional(),
    summary: z.string().trim().min(1).max(2000).optional(),
    plan: planBodySchema.optional(),
    proposal: z.string().trim().min(1).max(2000).optional(),
    conflict: conflictBodySchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "final") {
      if (!value.answer) {
        ctx.addIssue({ code: "custom", path: ["answer"], message: "answer" });
      }
      if (!value.summary) {
        ctx.addIssue({
          code: "custom",
          path: ["summary"],
          message: "summary",
        });
      }
    }
    if (value.status === "plan" && !value.plan) {
      ctx.addIssue({ code: "custom", path: ["plan"], message: "plan" });
    }
    if (value.status === "decision" && !value.proposal) {
      ctx.addIssue({
        code: "custom",
        path: ["proposal"],
        message: "proposal",
      });
    }
    if (value.status === "conflict" && !value.conflict) {
      ctx.addIssue({
        code: "custom",
        path: ["conflict"],
        message: "conflict",
      });
    }
  });

type Turn = z.infer<typeof turnSchema>;

export type RunBody =
  | { id: string }
  | { id: string; error: string }
  | {
      error:
        | "rate_limited"
        | "agent_busy"
        | "awaiting_approval"
        | "queued"
        | "queue_full"
        | "intent_required"
        | "qa_busy"
        | "conflict_open";
    };

type Intent = "work" | "question";
type RunKind = "main" | "qa";

export type EnqueueResult = {
  kind: "started" | "failed" | "skipped";
  run: RunBody;
};

type WorkerDb = {
  sql: Sql;
  encryptionKey: string;
  llm: LlmClient;
  allow: (key: string) => boolean;
};

type ExecuteDeps = {
  sql: Sql;
  encryptionKey: string;
  llm: LlmClient;
};

type ChannelContext = {
  channelId: string;
  projectId: string;
  agentId: string;
  skillPack: string | null;
  credentialId: string | null;
  modelId: string | null;
  agentStatus: string;
  llmPaused: boolean;
  spendCap: string | null;
  spendUsed: string;
};

type CredentialRow = {
  id: string;
  provider: string;
  encrypted_secret: Buffer;
  secret_nonce: Buffer;
};

type Candidate = CredentialRow & { model: string };

type CallSuccess = LlmResult & { credentialId: string; model: string };

function parseTurn(text: string): Turn | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/u, "")
    .trim();
  try {
    const parsed = turnSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function systemPrompt(skill: string): string {
  return [
    skill,
    "",
    "Reply with one JSON object and no markdown.",
    'Keys: status ("working", "final", "plan", "decision", or "conflict"), notes (string).',
    "When status is final, also include answer and summary.",
    "When status is plan, also include plan with summary and steps.",
    "When status is decision, also include proposal.",
    "When status is conflict, also include conflict with at least two options, each with a label.",
    "A plan is not approved until the owner says so.",
    "A pending decision is not a fact until the owner accepts it.",
    "A conflict waits until the owner chooses.",
    "status working is a progress note. status final is the channel reply.",
  ].join("\n");
}

function spendBlock(
  paused: boolean,
  cap: string | null,
  used: string,
): "spend_paused" | "spend_cap" | null {
  if (paused) {
    return "spend_paused";
  }
  if (cap !== null && Number(used) >= Number(cap)) {
    return "spend_cap";
  }
  return null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String(error.code) === "23505"
  );
}

function asBuffer(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function classifyBody(body: string, intent?: Intent): Intent | "ambiguous" {
  if (intent) {
    return intent;
  }
  const trimmed = body.trim();
  const question = trimmed.endsWith("?");
  const change = changeRequest.test(trimmed);
  if (question && change) {
    return "ambiguous";
  }
  if (question) {
    return "question";
  }
  return "work";
}

function skipped(
  error:
    | "rate_limited"
    | "agent_busy"
    | "queued"
    | "queue_full"
    | "intent_required"
    | "qa_busy"
    | "conflict_open",
): EnqueueResult {
  return { kind: "skipped", run: { error } };
}

async function loadContext(
  sql: Sql,
  channelId: string,
): Promise<ChannelContext | null> {
  const rows = await sql<
    {
      channel_id: string;
      project_id: string;
      agent_id: string;
      skill_pack: string | null;
      credential_id: string | null;
      model_id: string | null;
      agent_status: string;
      llm_paused: boolean;
      spend_cap: string | null;
      spend_used: string;
    }[]
  >`
    select
      channels.id as channel_id,
      channels.project_id,
      agents.id as agent_id,
      skills.system_prompt_pack as skill_pack,
      agents.credential_id,
      agents.model_id,
      agents.status as agent_status,
      projects.llm_paused,
      projects.spend_cap::text as spend_cap,
      projects.spend_used::text as spend_used
    from channels
    join agents on agents.id = channels.agent_id
    join projects on projects.id = channels.project_id
    left join skills on skills.id = agents.skill_id
    where channels.id = ${channelId}::uuid
  `;
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    channelId: row.channel_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    skillPack: row.skill_pack,
    credentialId: row.credential_id,
    modelId: row.model_id,
    agentStatus: row.agent_status,
    llmPaused: row.llm_paused,
    spendCap: row.spend_cap,
    spendUsed: row.spend_used,
  };
}

async function listCandidates(
  sql: Sql,
  projectId: string,
  assignedId: string | null,
  assignedModel: string | null,
): Promise<{ active: number; usable: Candidate[] }> {
  const rows = await sql<CredentialRow[]>`
    select id, provider, encrypted_secret, secret_nonce
    from provider_credentials
    where project_id = ${projectId}::uuid
      and status = 'active'
    order by fallback_order asc, id asc
  `;
  const assigned = assignedId
    ? rows.find((row) => row.id === assignedId)
    : undefined;
  const ordered = assigned
    ? [assigned, ...rows.filter((row) => row.id !== assigned.id)]
    : rows;
  const usable: Candidate[] = [];
  for (const row of ordered) {
    if (!supportsProvider(row.provider)) {
      continue;
    }
    const model =
      row.id === assignedId && assignedModel
        ? assignedModel
        : defaultModel(row.provider);
    if (!model) {
      continue;
    }
    usable.push({ ...row, model });
  }
  return { active: rows.length, usable };
}

async function failNewRun(
  sql: Sql,
  context: ChannelContext,
  reason: string,
  kind: RunKind = "main",
): Promise<string> {
  const runId = await sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into agent_runs (
        project_id, channel_id, agent_id, kind, status
      ) values (
        ${context.projectId}::uuid,
        ${context.channelId}::uuid,
        ${context.agentId}::uuid,
        ${kind},
        'failed'
      )
      returning id
    `;
    const id = rows[0]?.id;
    if (!id) {
      throw new Error("run insert failed");
    }
    await tx`
      insert into agent_run_steps (run_id, step_index, iteration, type, payload)
      values (
        ${id}::uuid,
        1,
        1,
        'trace',
        ${tx.json({ reason })}
      )
    `;
    return id;
  });
  publish(context.channelId, "run.failed", { runId, reason });
  if (reason === "spend_paused" || reason === "spend_cap") {
    await publishSpend(sql, context.projectId);
  }
  return runId;
}

async function mainIsActive(
  sql: Sql,
  agentId: string,
  exceptRunId?: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    select id
    from agent_runs
    where agent_id = ${agentId}::uuid
      and kind = 'main'
      and status in ('pending', 'running')
      and id is distinct from ${exceptRunId ?? null}::uuid
    limit 1
  `;
  return Boolean(rows[0]);
}

async function qaIsActive(sql: Sql, agentId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    select id
    from agent_runs
    where agent_id = ${agentId}::uuid
      and kind = 'qa'
      and status in ('pending', 'running')
    limit 1
  `;
  return Boolean(rows[0]);
}

async function openConflict(
  sql: Sql,
  channelId: string,
): Promise<{ id: string } | undefined> {
  const rows = await sql<{ id: string }[]>`
    select id
    from conflicts
    where channel_id = ${channelId}::uuid
      and status = 'open'
    limit 1
  `;
  return rows[0];
}

async function releaseAgent(
  sql: Sql,
  context: ChannelContext,
  runId: string,
): Promise<void> {
  const runs = await sql<{ kind: string }[]>`
    select kind from agent_runs where id = ${runId}::uuid
  `;
  const kind = runs[0]?.kind ?? "main";
  const agents = await sql<{ status: string }[]>`
    select status from agents where id = ${context.agentId}::uuid
  `;
  const busy =
    kind === "qa" &&
    ((await mainIsActive(sql, context.agentId, runId)) ||
      agents[0]?.status === "awaiting_approval");
  if (busy) {
    return;
  }
  await sql`
    update agents
    set status = 'idle', updated_at = now()
    where id = ${context.agentId}::uuid
  `;
}

async function readyForModel(
  deps: WorkerDb | ExecuteDeps,
  context: ChannelContext,
  kind: RunKind,
): Promise<EnqueueResult | null> {
  if (!context.skillPack) {
    const id = await failNewRun(deps.sql, context, "missing_skill", kind);
    return { kind: "failed", run: { id, error: "missing_skill" } };
  }
  const blocked = spendBlock(
    context.llmPaused,
    context.spendCap,
    context.spendUsed,
  );
  if (blocked) {
    const id = await failNewRun(deps.sql, context, blocked, kind);
    return { kind: "failed", run: { id, error: blocked } };
  }
  const credentials = await listCandidates(
    deps.sql,
    context.projectId,
    context.credentialId,
    context.modelId,
  );
  if (credentials.active === 0) {
    const id = await failNewRun(deps.sql, context, "missing_credential", kind);
    return { kind: "failed", run: { id, error: "missing_credential" } };
  }
  if (credentials.usable.length === 0) {
    const id = await failNewRun(deps.sql, context, "provider_failed", kind);
    return { kind: "failed", run: { id, error: "provider_failed" } };
  }
  return null;
}

async function insertRun(
  sql: Sql,
  context: ChannelContext,
  kind: RunKind,
): Promise<string> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into agent_runs (
        project_id, channel_id, agent_id, kind, status
      ) values (
        ${context.projectId}::uuid,
        ${context.channelId}::uuid,
        ${context.agentId}::uuid,
        ${kind},
        'pending'
      )
      returning id
    `;
    const runId = rows[0]?.id;
    if (!runId) {
      throw new Error("run insert failed");
    }
    if (kind === "main") {
      await tx`
        update agents
        set status = 'working', updated_at = now()
        where id = ${context.agentId}::uuid
      `;
    } else {
      await tx`
        update agents
        set status = 'working', updated_at = now()
        where id = ${context.agentId}::uuid
          and status = 'idle'
      `;
    }
    return runId;
  });
}

async function queueMessage(
  sql: Sql,
  channelId: string,
  messageId: string,
): Promise<EnqueueResult> {
  const existing = await sql<{ id: string }[]>`
    select id
    from instruction_queue_items
    where message_id = ${messageId}::uuid
  `;
  if (existing[0]) {
    return skipped("queued");
  }
  const counts = await sql<{ n: number }[]>`
    select count(*)::int as n
    from instruction_queue_items
    where channel_id = ${channelId}::uuid
      and status = 'pending'
  `;
  if ((counts[0]?.n ?? 0) >= QUEUE_LIMIT) {
    return skipped("queue_full");
  }
  try {
    await sql`
      insert into instruction_queue_items (channel_id, message_id, status)
      values (${channelId}::uuid, ${messageId}::uuid, 'pending')
    `;
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }
  return skipped("queued");
}

export async function enqueueRun(
  deps: WorkerDb,
  input: {
    channelId: string;
    userId: string;
    messageId: string;
    body: string;
    intent?: Intent;
    consumeLimit: boolean;
  },
): Promise<EnqueueResult> {
  const context = await loadContext(deps.sql, input.channelId);
  if (!context) {
    throw new Error("channel missing");
  }
  if (
    input.consumeLimit &&
    !deps.allow(`run:${context.projectId}:${input.userId}`)
  ) {
    return skipped("rate_limited");
  }
  const choice = classifyBody(input.body, input.intent);
  const conflict = await openConflict(deps.sql, context.channelId);
  const busy =
    (await mainIsActive(deps.sql, context.agentId)) ||
    context.agentStatus === "awaiting_approval";
  if (conflict && choice !== "question") {
    if (choice === "ambiguous") {
      return skipped("intent_required");
    }
    return skipped("conflict_open");
  }
  if (!busy && !conflict) {
    const blocked = await readyForModel(deps, context, "main");
    if (blocked) {
      return blocked;
    }
    try {
      const id = await insertRun(deps.sql, context, "main");
      return { kind: "started", run: { id } };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return skipped("agent_busy");
      }
      throw error;
    }
  }
  if (choice === "ambiguous") {
    return skipped("intent_required");
  }
  if (choice === "question") {
    if (await qaIsActive(deps.sql, context.agentId)) {
      return skipped("qa_busy");
    }
    const blocked = await readyForModel(deps, context, "qa");
    if (blocked) {
      return blocked;
    }
    try {
      const id = await insertRun(deps.sql, context, "qa");
      runRequests.set(id, input.body);
      return { kind: "started", run: { id } };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return skipped("qa_busy");
      }
      throw error;
    }
  }
  return queueMessage(deps.sql, context.channelId, input.messageId);
}
async function markFailed(
  sql: Sql,
  context: ChannelContext,
  runId: string,
  reason: string,
  iteration: number,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      update agent_runs
      set status = 'failed', updated_at = now()
      where id = ${runId}::uuid
    `;
    const next = await tx<{ n: number }[]>`
      select coalesce(max(step_index), 0) + 1 as n
      from agent_run_steps
      where run_id = ${runId}::uuid
    `;
    await tx`
      insert into agent_run_steps (run_id, step_index, iteration, type, payload)
      values (
        ${runId}::uuid,
        ${next[0]?.n ?? 1},
        ${Math.max(iteration, 1)},
        'trace',
        ${tx.json({ reason })}
      )
    `;
  });
  await releaseAgent(sql, context, runId);
  publish(context.channelId, "run.failed", { runId, reason });
  if (reason === "spend_paused" || reason === "spend_cap") {
    await publishSpend(sql, context.projectId);
  }
}

async function currentGate(
  sql: Sql,
  projectId: string,
): Promise<"spend_paused" | "spend_cap" | null> {
  const rows = await sql<
    { llm_paused: boolean; spend_cap: string | null; spend_used: string }[]
  >`
    select llm_paused, spend_cap::text as spend_cap, spend_used::text as spend_used
    from projects
    where id = ${projectId}::uuid
  `;
  const row = rows[0];
  if (!row) {
    return "spend_paused";
  }
  return spendBlock(row.llm_paused, row.spend_cap, row.spend_used);
}

async function buildUserPrompt(
  sql: Sql,
  context: ChannelContext,
  runId: string,
): Promise<string> {
  const brief = await sql<{ content: unknown }[]>`
    select content from project_briefs where project_id = ${context.projectId}::uuid
  `;
  const decisions = await sql<{ proposal: string }[]>`
    select proposal
    from decisions
    where project_id = ${context.projectId}::uuid
      and status = 'accepted'
    order by created_at asc
  `;
  const summary = await sql<{ summary: string }[]>`
    select summary from agent_summaries where agent_id = ${context.agentId}::uuid
  `;
  const plan = await sql<{ body: unknown; status: string }[]>`
    select body, status
    from plans
    where agent_id = ${context.agentId}::uuid
    order by updated_at desc
    limit 1
  `;
  const conflict = await sql<{ options: unknown }[]>`
    select options
    from conflicts
    where channel_id = ${context.channelId}::uuid
      and status = 'open'
    limit 1
  `;
  const messages = await sql<{ author_kind: string; body: string }[]>`
    select author_kind, body
    from messages
    where channel_id = ${context.channelId}::uuid
    order by created_at desc, id desc
    limit ${MESSAGE_WINDOW}
  `;
  const notes = await sql<{ payload: { notes?: string } }[]>`
    select payload
    from agent_run_steps
    where run_id = ${runId}::uuid
      and type = 'llm'
    order by step_index asc
  `;
  const recent = messages.reverse();
  const noteLines = notes
    .map((row) => row.payload.notes)
    .filter(
      (note): note is string => typeof note === "string" && note.length > 0,
    );
  return [
    "Project brief:",
    JSON.stringify(brief[0]?.content ?? {}),
    "Accepted decisions:",
    decisions.length > 0
      ? decisions.map((row) => `- ${row.proposal}`).join("\n")
      : "(none)",
    "Agent summary:",
    summary[0]?.summary ?? "(none)",
    "Current plan:",
    plan[0] ? `${plan[0].status}: ${JSON.stringify(plan[0].body)}` : "(none)",
    "Open conflict:",
    conflict[0] ? JSON.stringify(conflict[0].options) : "(none)",
    "Recent channel messages:",
    ...recent.map((row) => `channel_message ${row.author_kind}: ${row.body}`),
    "Notes from this run:",
    noteLines.length > 0
      ? noteLines.map((note) => `- ${note}`).join("\n")
      : "(none)",
    "Current request:",
    runRequests.get(runId) ?? "(none)",
  ].join("\n");
}

async function buildQaPrompt(
  sql: Sql,
  context: ChannelContext,
  runId: string,
): Promise<string> {
  const decisions = await sql<{ proposal: string }[]>`
    select proposal
    from decisions
    where project_id = ${context.projectId}::uuid
      and status = 'accepted'
    order by created_at asc
  `;
  const plan = await sql<{ status: string }[]>`
    select status
    from plans
    where agent_id = ${context.agentId}::uuid
    order by updated_at desc
    limit 1
  `;
  const messages = await sql<{ author_kind: string; body: string }[]>`
    select author_kind, body
    from messages
    where channel_id = ${context.channelId}::uuid
    order by created_at desc, id desc
    limit ${QA_MESSAGE_WINDOW}
  `;
  const recent = messages.reverse();
  return [
    "This is a side question. Do not change the plan, the Brief, or a conflict.",
    "Reply with status working or final only.",
    "Current plan (read only):",
    plan[0]?.status ?? "(none)",
    "Accepted decisions:",
    decisions.length > 0
      ? decisions.map((row) => `- ${row.proposal}`).join("\n")
      : "(none)",
    "Recent channel messages:",
    ...recent.map((row) => `channel_message ${row.author_kind}: ${row.body}`),
    "Question:",
    runRequests.get(runId) ?? "(none)",
  ].join("\n");
}

async function callModel(
  deps: ExecuteDeps,
  context: ChannelContext,
  user: string,
  calls: { n: number },
  maxCalls: number,
): Promise<CallSuccess | null> {
  const { usable } = await listCandidates(
    deps.sql,
    context.projectId,
    context.credentialId,
    context.modelId,
  );
  const retried = new Set<string>();
  for (const credential of usable) {
    if (calls.n >= maxCalls) {
      return null;
    }
    let apiKey: string;
    try {
      apiKey = decryptSecret(
        asBuffer(credential.encrypted_secret),
        asBuffer(credential.secret_nonce),
        deps.encryptionKey,
      );
    } catch {
      continue;
    }
    const request = {
      provider: credential.provider,
      apiKey,
      model: credential.model,
      system: systemPrompt(context.skillPack ?? ""),
      user,
    };
    try {
      const result = await deps.llm.complete(request);
      calls.n += 1;
      return {
        ...result,
        credentialId: credential.id,
        model: credential.model,
      };
    } catch (error) {
      calls.n += 1;
      const kind = error instanceof LlmError ? error.kind : "fatal";
      if (kind === "auth" || kind === "quota" || kind === "rate") {
        await deps.sql`
          update provider_credentials
          set status = 'exhausted', updated_at = now()
          where id = ${credential.id}::uuid
        `;
        continue;
      }
      if (
        kind === "transient" &&
        !retried.has(credential.id) &&
        calls.n < maxCalls
      ) {
        retried.add(credential.id);
        try {
          const result = await deps.llm.complete(request);
          calls.n += 1;
          return {
            ...result,
            credentialId: credential.id,
            model: credential.model,
          };
        } catch {
          calls.n += 1;
        }
      }
    }
  }
  return null;
}

async function recordTurn(
  deps: ExecuteDeps,
  context: ChannelContext,
  runId: string,
  iteration: number,
  turn: Turn,
  outcome: CallSuccess,
  runKind: RunKind,
): Promise<void> {
  const saved = await deps.sql.begin(async (tx) => {
    const next = await tx<{ n: number }[]>`
      select coalesce(max(step_index), 0) + 1 as n
      from agent_run_steps
      where run_id = ${runId}::uuid
    `;
    const stepIndex = next[0]?.n ?? 1;
    await tx`
      insert into agent_run_steps (run_id, step_index, iteration, type, payload)
      values (
        ${runId}::uuid,
        ${stepIndex},
        ${iteration},
        'llm',
        ${tx.json({
          notes: turn.notes,
          model: outcome.model,
          tokenIn: outcome.tokenIn,
          tokenOut: outcome.tokenOut,
          costEst: outcome.costEst,
        })}
      )
    `;
    await tx`
      update agent_runs
      set
        token_in = token_in + ${outcome.tokenIn},
        token_out = token_out + ${outcome.tokenOut},
        cost_est = cost_est + ${outcome.costEst},
        credential_id_used = ${outcome.credentialId}::uuid,
        model_used = ${outcome.model},
        updated_at = now()
      where id = ${runId}::uuid
    `;
    await tx`
      update projects
      set spend_used = spend_used + ${outcome.costEst}
      where id = ${context.projectId}::uuid
    `;
    let message: { id: string; body: string; created_at: Date } | undefined;
    let planEvent:
      | { id: string; body: { summary: string; steps: string[] } }
      | undefined;
    let decisionEvent: { id: string; proposal: string } | undefined;
    let conflictEvent:
      | { id: string; options: Record<string, unknown>[] }
      | undefined;
    if (turn.status === "decision" && turn.proposal) {
      const decisions = await tx<{ id: string }[]>`
        insert into decisions (
          project_id, status, proposal, proposed_by_agent_id,
          origin_channel_id, impact_agent_ids
        )
        values (
          ${context.projectId}::uuid,
          'pending',
          ${turn.proposal},
          ${context.agentId}::uuid,
          ${context.channelId}::uuid,
          coalesce(
            (select array_agg(id) from agents where project_id = ${context.projectId}::uuid),
            '{}'::uuid[]
          )
        )
        returning id
      `;
      const decisionId = decisions[0]?.id;
      if (!decisionId) {
        throw new Error("decision insert failed");
      }
      decisionEvent = { id: decisionId, proposal: turn.proposal };
      const messages = await tx<
        { id: string; body: string; created_at: Date }[]
      >`
        insert into messages (channel_id, author_kind, body, run_id)
        values (
          ${context.channelId}::uuid,
          'agent',
          ${turn.proposal},
          ${runId}::uuid
        )
        returning id, body, created_at
      `;
      message = messages[0];
      await tx`
        update agent_runs
        set status = 'succeeded', updated_at = now()
        where id = ${runId}::uuid
      `;
    }
    if (turn.status === "plan" && turn.plan) {
      await tx`
        update plans
        set status = 'draft', updated_at = now()
        where agent_id = ${context.agentId}::uuid
          and status = 'awaiting'
      `;
      const plans = await tx<{ id: string }[]>`
        insert into plans (agent_id, status, body)
        values (
          ${context.agentId}::uuid,
          'awaiting',
          ${tx.json(turn.plan)}
        )
        returning id
      `;
      const planId = plans[0]?.id;
      if (!planId) {
        throw new Error("plan insert failed");
      }
      planEvent = { id: planId, body: turn.plan };
      const messages = await tx<
        { id: string; body: string; created_at: Date }[]
      >`
        insert into messages (channel_id, author_kind, body, run_id)
        values (
          ${context.channelId}::uuid,
          'agent',
          ${turn.plan.summary},
          ${runId}::uuid
        )
        returning id, body, created_at
      `;
      message = messages[0];
      await tx`
        update agent_runs
        set status = 'succeeded', updated_at = now()
        where id = ${runId}::uuid
      `;
      await tx`
        update agents
        set status = 'awaiting_approval', updated_at = now()
        where id = ${context.agentId}::uuid
      `;
    }
    if (turn.status === "final" && turn.answer && turn.summary) {
      const messages = await tx<
        { id: string; body: string; created_at: Date }[]
      >`
        insert into messages (channel_id, author_kind, body, run_id)
        values (
          ${context.channelId}::uuid,
          'agent',
          ${turn.answer},
          ${runId}::uuid
        )
        returning id, body, created_at
      `;
      message = messages[0];
      if (runKind === "main" && turn.summary) {
        await tx`
          insert into agent_summaries (project_id, agent_id, summary)
          values (
            ${context.projectId}::uuid,
            ${context.agentId}::uuid,
            ${turn.summary}
          )
          on conflict (agent_id) where agent_id is not null
          do update set summary = excluded.summary, updated_at = now()
        `;
      }
      await tx`
        update agent_runs
        set status = 'succeeded', updated_at = now()
        where id = ${runId}::uuid
      `;
    }
    if (turn.status === "conflict" && turn.conflict && runKind === "main") {
      const people = await tx<
        {
          id: string;
          body: string;
          author_user_id: string;
          role: string | null;
        }[]
      >`
        select
          messages.id,
          messages.body,
          messages.author_user_id,
          memberships.role
        from messages
        join channels on channels.id = messages.channel_id
        left join memberships
          on memberships.project_id = channels.project_id
          and memberships.user_id = messages.author_user_id
        where messages.channel_id = ${context.channelId}::uuid
          and messages.author_kind = 'user'
        order by messages.created_at desc, messages.id desc
        limit 2
      `;
      const latest = [...people].reverse();
      const options = turn.conflict.options.map((option, index) => {
        const person = latest[index];
        return {
          label: option.label,
          ...(person
            ? {
                messageId: person.id,
                userId: person.author_user_id,
                role: person.role ?? "member",
                body: person.body,
              }
            : {}),
        };
      });
      const inserted = await tx<{ id: string }[]>`
        insert into conflicts (channel_id, options, status)
        values (${context.channelId}::uuid, ${tx.json(options)}, 'open')
        returning id
      `;
      const conflictId = inserted[0]?.id;
      if (!conflictId) {
        throw new Error("conflict insert failed");
      }
      conflictEvent = { id: conflictId, options };
      const notice = [
        "A conflict needs the owner.",
        ...options.map((option, index) => {
          const who = option.role === "owner" ? "Owner" : "Member";
          const text =
            "body" in option && option.body ? option.body : option.label;
          return `${index + 1}. ${who}: ${text}`;
        }),
      ].join("\n");
      const messages = await tx<
        { id: string; body: string; created_at: Date }[]
      >`
        insert into messages (channel_id, author_kind, body, run_id)
        values (
          ${context.channelId}::uuid,
          'system',
          ${notice},
          ${runId}::uuid
        )
        returning id, body, created_at
      `;
      message = messages[0];
      await tx`
        update agent_runs
        set status = 'succeeded', updated_at = now()
        where id = ${runId}::uuid
      `;
    }
    const totals = await tx<
      {
        token_in: number;
        token_out: number;
        cost_est: string;
        model_used: string;
      }[]
    >`
      select token_in, token_out, cost_est::text as cost_est, model_used
      from agent_runs
      where id = ${runId}::uuid
    `;
    return {
      stepIndex,
      message,
      totals: totals[0],
      planEvent,
      decisionEvent,
      conflictEvent,
    };
  });

  if (
    turn.status === "final" ||
    turn.status === "decision" ||
    turn.status === "conflict"
  ) {
    await releaseAgent(deps.sql, context, runId);
  }
  await publishSpend(deps.sql, context.projectId);

  publish(context.channelId, "run.step", {
    runId,
    stepIndex: saved.stepIndex,
    iteration,
    type: "llm",
    notes: turn.notes,
    model: outcome.model,
    tokenIn: outcome.tokenIn,
    tokenOut: outcome.tokenOut,
    costEst: outcome.costEst,
  });
  if (saved.planEvent) {
    publish(context.channelId, "plan.updated", {
      planId: saved.planEvent.id,
      agentId: context.agentId,
      status: "awaiting",
      body: saved.planEvent.body,
    });
  }
  if (saved.decisionEvent) {
    publish(context.channelId, "decision.updated", {
      decisionId: saved.decisionEvent.id,
      projectId: context.projectId,
      status: "pending",
      proposal: saved.decisionEvent.proposal,
    });
  }
  if (saved.conflictEvent) {
    publish(context.channelId, "conflict.opened", {
      conflictId: saved.conflictEvent.id,
      channelId: context.channelId,
      status: "open",
      options: saved.conflictEvent.options,
    });
  }
  if (saved.message) {
    publishMessageCreated(context.channelId, {
      id: saved.message.id,
      body: saved.message.body,
      authorKind: saved.conflictEvent ? "system" : "agent",
      authorUserId: null,
      createdAt: saved.message.created_at.toISOString(),
    });
    publish(context.channelId, "run.completed", {
      runId,
      messageId: saved.message.id,
      tokenIn: saved.totals?.token_in ?? outcome.tokenIn,
      tokenOut: saved.totals?.token_out ?? outcome.tokenOut,
      costEst: Number(saved.totals?.cost_est ?? outcome.costEst),
      model: saved.totals?.model_used ?? outcome.model,
    });
  }
}

function turnAllowed(kind: RunKind, turn: Turn): boolean {
  if (kind === "main") {
    return true;
  }
  return turn.status === "working" || turn.status === "final";
}

export async function executeRun(
  deps: ExecuteDeps,
  runId: string,
): Promise<void> {
  const claimed = await deps.sql<
    { id: string; channel_id: string; kind: string }[]
  >`
    update agent_runs
    set status = 'running', updated_at = now()
    where id = ${runId}::uuid
      and status = 'pending'
    returning id, channel_id, kind
  `;
  const claim = claimed[0];
  if (!claim) {
    return;
  }
  const runKind: RunKind = claim.kind === "qa" ? "qa" : "main";
  const maxCalls = runKind === "qa" ? QA_MAX_ITERATIONS : MAX_MAIN_ITERATIONS;
  const context = await loadContext(deps.sql, claim.channel_id);
  let drain = false;
  try {
    if (!context?.skillPack) {
      if (context) {
        await markFailed(deps.sql, context, runId, "missing_skill", 1);
        drain = runKind === "main";
      }
      return;
    }
    drain = runKind === "main";
    publish(context.channelId, "run.started", {
      runId,
      agentId: context.agentId,
      status: "running",
    });
    const calls = { n: 0 };
    let iteration = 0;
    while (calls.n < maxCalls) {
      const blocked = await currentGate(deps.sql, context.projectId);
      if (blocked) {
        await markFailed(deps.sql, context, runId, blocked, iteration);
        return;
      }
      iteration += 1;
      const user =
        runKind === "qa"
          ? await buildQaPrompt(deps.sql, context, runId)
          : await buildUserPrompt(deps.sql, context, runId);
      let outcome = await callModel(deps, context, user, calls, maxCalls);
      if (!outcome) {
        await markFailed(
          deps.sql,
          context,
          runId,
          calls.n >= maxCalls ? "iteration_limit" : "provider_failed",
          iteration,
        );
        return;
      }
      let turn = parseTurn(outcome.text);
      if (turn && !turnAllowed(runKind, turn)) {
        turn = null;
      }
      if (!turn) {
        if (calls.n >= maxCalls) {
          await markFailed(
            deps.sql,
            context,
            runId,
            "invalid_response",
            iteration,
          );
          return;
        }
        outcome = await callModel(deps, context, user, calls, maxCalls);
        if (!outcome) {
          await markFailed(
            deps.sql,
            context,
            runId,
            calls.n >= maxCalls ? "iteration_limit" : "provider_failed",
            iteration,
          );
          return;
        }
        turn = parseTurn(outcome.text);
        if (turn && !turnAllowed(runKind, turn)) {
          turn = null;
        }
        if (!turn) {
          await markFailed(
            deps.sql,
            context,
            runId,
            "invalid_response",
            iteration,
          );
          return;
        }
      }
      await recordTurn(deps, context, runId, iteration, turn, outcome, runKind);
      if (
        turn.status === "final" ||
        turn.status === "plan" ||
        turn.status === "decision" ||
        turn.status === "conflict"
      ) {
        return;
      }
    }
    await markFailed(deps.sql, context, runId, "iteration_limit", iteration);
  } catch {
    console.error("agent run failed");
    if (context) {
      await markFailed(deps.sql, context, runId, "provider_failed", 1);
    }
  } finally {
    if (drain && context) {
      const next = await drainQueue(deps, context.channelId);
      if (next) {
        await executeRun(deps, next);
      }
    }
  }
}

export async function startContinuation(
  deps: ExecuteDeps,
  agentId: string,
  requestText?: string,
): Promise<EnqueueResult> {
  const channels = await deps.sql<{ id: string }[]>`
    select id from channels where agent_id = ${agentId}::uuid
  `;
  const channelId = channels[0]?.id;
  if (!channelId) {
    throw new Error("channel missing");
  }
  const context = await loadContext(deps.sql, channelId);
  if (!context) {
    throw new Error("channel missing");
  }
  if (await mainIsActive(deps.sql, context.agentId)) {
    return skipped("agent_busy");
  }
  const blocked = await readyForModel(deps, context, "main");
  if (blocked) {
    return blocked;
  }
  try {
    const id = await insertRun(deps.sql, context, "main");
    if (requestText) {
      runRequests.set(id, requestText);
    }
    return { kind: "started", run: { id } };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return skipped("agent_busy");
    }
    throw error;
  }
}

export async function publishSpend(sql: Sql, projectId: string): Promise<void> {
  const projects = await sql<
    { spend_cap: string | null; spend_used: string; llm_paused: boolean }[]
  >`
    select spend_cap::text as spend_cap, spend_used::text as spend_used, llm_paused
    from projects
    where id = ${projectId}::uuid
  `;
  const project = projects[0];
  if (!project) {
    return;
  }
  const channels = await sql<{ id: string }[]>`
    select id from channels where project_id = ${projectId}::uuid
  `;
  const data = {
    projectId,
    spendUsed: Number(project.spend_used),
    spendCap: project.spend_cap === null ? null : Number(project.spend_cap),
    llmPaused: project.llm_paused,
  };
  for (const channel of channels) {
    publish(channel.id, "spend.updated", data);
  }
}

export async function drainQueue(
  deps: ExecuteDeps,
  channelId: string,
): Promise<string | null> {
  const context = await loadContext(deps.sql, channelId);
  if (context?.agentStatus !== "idle" || !context?.skillPack) {
    return null;
  }
  if (await openConflict(deps.sql, channelId)) {
    return null;
  }
  if (await mainIsActive(deps.sql, context.agentId)) {
    return null;
  }
  if (spendBlock(context.llmPaused, context.spendCap, context.spendUsed)) {
    return null;
  }
  const credentials = await listCandidates(
    deps.sql,
    context.projectId,
    context.credentialId,
    context.modelId,
  );
  if (credentials.usable.length === 0) {
    return null;
  }
  const items = await deps.sql<{ id: string; body: string }[]>`
    select instruction_queue_items.id, messages.body
    from instruction_queue_items
    join messages on messages.id = instruction_queue_items.message_id
    where instruction_queue_items.channel_id = ${channelId}::uuid
      and instruction_queue_items.status = 'pending'
    order by instruction_queue_items.created_at asc, instruction_queue_items.id asc
    limit 1
  `;
  const item = items[0];
  if (!item) {
    return null;
  }
  try {
    const id = await deps.sql.begin(async (tx) => {
      const updated = await tx<{ id: string }[]>`
        update instruction_queue_items
        set status = 'completed'
        where id = ${item.id}::uuid
          and status = 'pending'
        returning id
      `;
      if (!updated[0]) {
        return null;
      }
      const rows = await tx<{ id: string }[]>`
        insert into agent_runs (
          project_id, channel_id, agent_id, kind, status
        ) values (
          ${context.projectId}::uuid,
          ${context.channelId}::uuid,
          ${context.agentId}::uuid,
          'main',
          'pending'
        )
        returning id
      `;
      const runId = rows[0]?.id;
      if (!runId) {
        throw new Error("run insert failed");
      }
      await tx`
        update agents
        set status = 'working', updated_at = now()
        where id = ${context.agentId}::uuid
      `;
      return runId;
    });
    if (!id) {
      return null;
    }
    runRequests.set(id, item.body);
    return id;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return null;
    }
    throw error;
  }
}

export async function drainProject(
  deps: ExecuteDeps,
  projectId: string,
): Promise<string[]> {
  const channels = await deps.sql<{ id: string }[]>`
    select id from channels where project_id = ${projectId}::uuid
  `;
  const started: string[] = [];
  for (const channel of channels) {
    const id = await drainQueue(deps, channel.id);
    if (id) {
      started.push(id);
    }
  }
  return started;
}

export async function recoverStuckRuns(sql: Sql): Promise<void> {
  await sql`
    update agent_runs
    set status = 'failed', updated_at = now()
    where status in ('pending', 'running')
  `;
  await sql`
    update agents
    set status = 'idle', updated_at = now()
    where status = 'working'
  `;
}
