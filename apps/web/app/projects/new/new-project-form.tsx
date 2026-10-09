"use client";

import { useState } from "react";
import {
  API_ORIGIN,
  buttonClass,
  fieldClass,
  linkClass,
  messageFor,
} from "../../auth-shared";

export function NewProjectForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const spendText = String(form.get("spendCap") ?? "").trim();
    const response = await fetch(`${API_ORIGIN}/projects`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        spendCap: spendText.length === 0 ? null : Number(spendText),
      }),
    });
    setPending(false);
    if (response.status === 401) {
      window.location.assign("/login");
      return;
    }
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      setError(messageFor(body.error ?? null));
      return;
    }
    const body = (await response.json()) as { id?: string };
    window.location.assign(`/projects/${body.id ?? ""}`);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <p className="text-sm font-medium tracking-wide text-stone-500">
        Projects
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">
        New project
      </h1>
      <p className="mt-3 text-stone-600">
        You become the owner. An Orchestrator channel is created with the
        project.
      </p>
      <form className="mt-8 space-y-4" onSubmit={onSubmit}>
        <label className="block text-sm font-medium text-stone-700">
          Name
          <input className={fieldClass} name="name" required />
        </label>
        <label className="block text-sm font-medium text-stone-700">
          Spend cap
          <input
            className={fieldClass}
            name="spendCap"
            type="number"
            min="0"
            step="0.01"
            placeholder="Optional"
          />
        </label>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        <button className={buttonClass} type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create project"}
        </button>
      </form>
      <p className="mt-6 text-sm text-stone-500">
        <a className={linkClass} href="/projects">
          Back to projects
        </a>
      </p>
    </main>
  );
}
