import type { Sql, TransactionSql } from "postgres";
import { publish } from "../channels/hub";

export const specialistName = {
  frontend: "Frontend",
  backend: "Backend",
} as const;

export type SpecialistKind = keyof typeof specialistName;

export type SpawnedSpecialist = {
  agentId: string;
  channelId: string;
  name: string;
  kind: SpecialistKind;
};

function briefFor(kind: SpecialistKind, brief?: string): string {
  if (brief && brief.length > 0) {
    return brief;
  }
  return `Requirements for the ${kind} specialist.`;
}

export async function spawnSpecialist(
  sql: TransactionSql,
  input: { projectId: string; kind: SpecialistKind; brief?: string },
): Promise<SpawnedSpecialist | null> {
  const existing = await sql<{ id: string }[]>`
    select agents.id
    from agents
    join skills on skills.id = agents.skill_id
    where agents.project_id = ${input.projectId}::uuid
      and skills.slug = ${input.kind}
  `;
  if (existing[0]) {
    return null;
  }
  const name = specialistName[input.kind];
  const brief = briefFor(input.kind, input.brief);
  const agents = await sql<{ id: string }[]>`
    insert into agents (project_id, kind, name, status, skill_id)
    select
      ${input.projectId}::uuid,
      'specialist',
      ${name},
      'idle',
      skills.id
    from skills
    where skills.slug = ${input.kind}
      and skills.version = 1
    returning id
  `;
  const agent = agents[0];
  if (!agent) {
    throw new Error("specialist insert failed");
  }
  const channels = await sql<{ id: string }[]>`
    insert into channels (project_id, agent_id)
    values (${input.projectId}::uuid, ${agent.id}::uuid)
    returning id
  `;
  const channel = channels[0];
  if (!channel) {
    throw new Error("channel insert failed");
  }
  await sql`
    insert into messages (channel_id, author_kind, body)
    values (${channel.id}::uuid, 'system', ${brief})
  `;
  return { agentId: agent.id, channelId: channel.id, name, kind: input.kind };
}

export async function publishSpecialistCreated(
  sql: Sql,
  projectId: string,
  created: SpawnedSpecialist,
): Promise<void> {
  const listeners = await sql<{ id: string }[]>`
    select id from channels
    where project_id = ${projectId}::uuid
      and id <> ${created.channelId}::uuid
  `;
  for (const listener of listeners) {
    publish(listener.id, "channel.created", {
      channelId: created.channelId,
      agentId: created.agentId,
      name: created.name,
      kind: created.kind,
    });
  }
}
