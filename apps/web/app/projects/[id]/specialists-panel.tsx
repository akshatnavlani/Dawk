"use client";

import { useEffect, useState } from "react";
import { API_ORIGIN, buttonClass, messageFor } from "../../auth-shared";

type Agent = {
  id: string;
  name: string;
  kind: string;
  status: string;
};

export function SpecialistsPanel({ projectId }: { projectId: string }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"frontend" | "backend" | null>(null);

  async function load() {
    const response = await fetch(`${API_ORIGIN}/projects/${projectId}/agents`, {
      credentials: "include",
    });
    if (!response.ok) {
      return;
    }
    const body = (await response.json()) as { agents?: Agent[] };
    setAgents(body.agents ?? []);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch(
        `${API_ORIGIN}/projects/${projectId}/agents`,
        { credentials: "include" },
      );
      if (cancelled || !response.ok) {
        return;
      }
      const body = (await response.json()) as { agents?: Agent[] };
      setAgents(body.agents ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function spawn(kind: "frontend" | "backend") {
    setPending(kind);
    setError(null);
    const response = await fetch(`${API_ORIGIN}/projects/${projectId}/agents`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    setPending(null);
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      setError(messageFor(body.error ?? null));
      return;
    }
    await load();
  }

  const hasFrontend = agents.some((agent) => agent.kind === "frontend");
  const hasBackend = agents.some((agent) => agent.kind === "backend");
  if (hasFrontend && hasBackend) {
    return null;
  }

  return (
    <section className="mt-8 border-t border-stone-200 pt-8">
      <h2 className="text-lg font-semibold">Specialists</h2>
      <p className="mt-2 text-sm text-stone-600">
        Add a Frontend channel and a Backend channel. Each one is its own chat.
      </p>
      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {hasFrontend ? null : (
          <button
            className={buttonClass}
            type="button"
            disabled={pending !== null}
            onClick={() => void spawn("frontend")}
          >
            {pending === "frontend" ? "Adding…" : "Add Frontend"}
          </button>
        )}
        {hasBackend ? null : (
          <button
            className={buttonClass}
            type="button"
            disabled={pending !== null}
            onClick={() => void spawn("backend")}
          >
            {pending === "backend" ? "Adding…" : "Add Backend"}
          </button>
        )}
      </div>
    </section>
  );
}
