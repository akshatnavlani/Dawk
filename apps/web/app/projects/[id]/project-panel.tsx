"use client";

import { useEffect, useState } from "react";
import {
  API_ORIGIN,
  buttonClass,
  fieldClass,
  linkClass,
  messageFor,
} from "../../auth-shared";
import { ChannelThread } from "./channel-thread";
import { CredentialsPanel } from "./credentials-panel";
import { InvitesPanel } from "./invites-panel";

type Project = {
  id: string;
  name: string;
  role: "owner" | "member";
  spendCap: number | null;
  spendUsed: number;
  llmPaused: boolean;
  orchestrator: {
    agentId: string;
    channelId: string;
    name: string;
    status: string;
  } | null;
};

export function ProjectPanel({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void (async () => {
      const response = await fetch(`${API_ORIGIN}/projects/${projectId}`, {
        credentials: "include",
      });
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setError(messageFor(body.error ?? null));
        return;
      }
      setProject((await response.json()) as Project);
    })();
  }, [projectId]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project) {
      return;
    }
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const spendText = String(form.get("spendCap") ?? "").trim();
    const response = await fetch(`${API_ORIGIN}/projects/${project.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        spendCap: spendText.length === 0 ? null : Number(spendText),
        llmPaused: form.get("llmPaused") === "on",
      }),
    });
    setPending(false);
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      setError(messageFor(body.error ?? null));
      return;
    }
    setProject((await response.json()) as Project);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <p className="text-sm font-medium tracking-wide text-stone-500">
        Project
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">
        {project?.name ?? "Project"}
      </h1>
      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      {project ? (
        <>
          <p className="mt-3 text-stone-600">
            You are the {project.role}. Spend used {project.spendUsed}.
          </p>
          <ChannelThread projectId={project.id} role={project.role} />
          {project.role === "owner" ? (
            <InvitesPanel projectId={project.id} />
          ) : null}
          {project.role === "owner" ? (
            <CredentialsPanel
              projectId={project.id}
              agentId={project.orchestrator?.agentId ?? null}
            />
          ) : null}
          {project.role === "owner" ? (
            <form className="mt-8 space-y-4" onSubmit={save}>
              <label className="block text-sm font-medium text-stone-700">
                Name
                <input
                  className={fieldClass}
                  name="name"
                  defaultValue={project.name}
                  required
                />
              </label>
              <label className="block text-sm font-medium text-stone-700">
                Spend cap
                <input
                  className={fieldClass}
                  name="spendCap"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={project.spendCap ?? ""}
                  placeholder="No cap"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-stone-700">
                <input
                  name="llmPaused"
                  type="checkbox"
                  defaultChecked={project.llmPaused}
                />
                Pause LLM calls
              </label>
              <button className={buttonClass} type="submit" disabled={pending}>
                {pending ? "Saving…" : "Save"}
              </button>
            </form>
          ) : null}
        </>
      ) : error ? null : (
        <p className="mt-3 text-stone-600">Loading…</p>
      )}
      <p className="mt-8 text-sm text-stone-500">
        <a className={linkClass} href="/projects">
          All projects
        </a>
      </p>
    </main>
  );
}
