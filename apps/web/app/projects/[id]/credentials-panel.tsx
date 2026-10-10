"use client";

import { useEffect, useState } from "react";
import {
  API_ORIGIN,
  buttonClass,
  fieldClass,
  messageFor,
} from "../../auth-shared";

type Credential = {
  id: string;
  provider: string;
  label: string;
  status: "active" | "exhausted" | "disabled";
  isPrimary: boolean;
  fallbackOrder: number;
  lastFour: string | null;
};

export function CredentialsPanel({
  projectId,
  agentId,
}: {
  projectId: string;
  agentId: string | null;
}) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [credentialId, setCredentialId] = useState("");
  const [modelId, setModelId] = useState("");

  async function load() {
    const response = await fetch(
      `${API_ORIGIN}/projects/${projectId}/credentials`,
      { credentials: "include" },
    );
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      setError(messageFor(body.error ?? null));
      return;
    }
    const body = (await response.json()) as { credentials?: Credential[] };
    setCredentials(body.credentials ?? []);
  }

  useEffect(() => {
    void (async () => {
      const response = await fetch(
        `${API_ORIGIN}/projects/${projectId}/credentials`,
        { credentials: "include" },
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setError(messageFor(body.error ?? null));
        return;
      }
      const body = (await response.json()) as { credentials?: Credential[] };
      setCredentials(body.credentials ?? []);
    })();
  }, [projectId]);

  async function addKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const response = await fetch(
      `${API_ORIGIN}/projects/${projectId}/credentials`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: form.get("provider"),
          label: form.get("label"),
          secret: form.get("secret"),
          isPrimary: form.get("isPrimary") === "on",
        }),
      },
    );
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      setError(messageFor(body.error ?? null));
      return;
    }
    formElement.reset();
    await load();
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setError(null);
    const response = await fetch(
      `${API_ORIGIN}/projects/${projectId}/credentials/${id}`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(messageFor(payload.error ?? null));
      return;
    }
    await load();
  }

  async function remove(id: string) {
    setError(null);
    const response = await fetch(
      `${API_ORIGIN}/projects/${projectId}/credentials/${id}`,
      { method: "DELETE", credentials: "include" },
    );
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(messageFor(payload.error ?? null));
      return;
    }
    await load();
  }

  async function saveRouting(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agentId) {
      return;
    }
    setError(null);
    const response = await fetch(
      `${API_ORIGIN}/projects/${projectId}/agents/${agentId}/routing`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credentialId: credentialId.length > 0 ? credentialId : null,
          modelId: modelId.trim().length > 0 ? modelId.trim() : null,
        }),
      },
    );
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(messageFor(payload.error ?? null));
    }
  }

  return (
    <section className="mt-8 border-t border-stone-200 pt-8">
      <h2 className="text-lg font-semibold">Provider keys</h2>
      <p className="mt-1 text-sm text-stone-600">
        Keys stay encrypted. The list shows only the last four characters.
      </p>
      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      <ul className="mt-4 space-y-3">
        {credentials.map((credential) => (
          <li
            key={credential.id}
            className="rounded-lg border border-stone-200 bg-white px-4 py-3"
          >
            <p className="font-medium">
              {credential.label}{" "}
              <span className="text-sm font-normal text-stone-500">
                {credential.provider} ····{credential.lastFour}
                {credential.isPrimary ? " · primary" : ""} · order{" "}
                {credential.fallbackOrder}
              </span>
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {credential.isPrimary ? null : (
                <button
                  className={buttonClass}
                  type="button"
                  onClick={() => void patch(credential.id, { isPrimary: true })}
                >
                  Make primary
                </button>
              )}
              <button
                className={buttonClass}
                type="button"
                onClick={() =>
                  void patch(credential.id, {
                    status:
                      credential.status === "disabled" ? "active" : "disabled",
                  })
                }
              >
                {credential.status === "disabled" ? "Enable" : "Disable"}
              </button>
              <button
                className={buttonClass}
                type="button"
                onClick={() => void remove(credential.id)}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
      <form className="mt-4 space-y-3" onSubmit={addKey}>
        <label className="block text-sm font-medium text-stone-700">
          Provider
          <input
            className={fieldClass}
            name="provider"
            placeholder="anthropic, openai, or google"
            required
          />
        </label>
        <label className="block text-sm font-medium text-stone-700">
          Label
          <input className={fieldClass} name="label" required />
        </label>
        <label className="block text-sm font-medium text-stone-700">
          Secret
          <input
            className={fieldClass}
            name="secret"
            type="password"
            minLength={4}
            required
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-stone-700">
          <input name="isPrimary" type="checkbox" />
          Primary
        </label>
        <button className={buttonClass} type="submit">
          Save key
        </button>
      </form>
      {agentId ? (
        <form className="mt-6 space-y-3" onSubmit={saveRouting}>
          <h3 className="text-base font-semibold">Orchestrator routing</h3>
          <label className="block text-sm font-medium text-stone-700">
            Credential
            <select
              className={fieldClass}
              value={credentialId}
              onChange={(event) => setCredentialId(event.target.value)}
            >
              <option value="">Project default</option>
              {credentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-stone-700">
            Model
            <input
              className={fieldClass}
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              placeholder="claude-sonnet"
            />
          </label>
          <button className={buttonClass} type="submit">
            Save routing
          </button>
        </form>
      ) : null}
    </section>
  );
}
