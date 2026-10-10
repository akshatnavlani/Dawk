"use client";

import { useEffect, useState } from "react";
import {
  API_ORIGIN,
  buttonClass,
  errorCode,
  fieldClass,
  messageFor,
} from "../../auth-shared";

type Invite = {
  id: string;
  email: string;
  status: string;
  expiresAt: string;
};

export function InvitesPanel({ projectId }: { projectId: string }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function load() {
    const response = await fetch(
      `${API_ORIGIN}/projects/${projectId}/invites`,
      { credentials: "include" },
    );
    if (!response.ok) {
      return;
    }
    const body = (await response.json()) as { invites?: Invite[] };
    setInvites(body.invites ?? []);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch(
        `${API_ORIGIN}/projects/${projectId}/invites`,
        { credentials: "include" },
      );
      if (cancelled || !response.ok) {
        return;
      }
      const body = (await response.json()) as { invites?: Invite[] };
      setInvites(body.invites ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    let response: Response;
    try {
      response = await fetch(`${API_ORIGIN}/projects/${projectId}/invites`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: data.get("email") }),
      });
    } catch {
      setPending(false);
      setError(
        "The invite could not be sent. Check your connection and try again.",
      );
      return;
    }
    setPending(false);
    if (!response.ok) {
      setError(
        messageFor(await errorCode(response)) ??
          "The invite could not be sent. Try again.",
      );
      return;
    }
    form.reset();
    await load();
  }

  async function revoke(id: string) {
    setError(null);
    const response = await fetch(
      `${API_ORIGIN}/projects/${projectId}/invites/${id}`,
      { method: "DELETE", credentials: "include" },
    );
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      setError(messageFor(body.error ?? null));
      return;
    }
    await load();
  }

  return (
    <section className="mt-8 border-t border-stone-200 pt-8">
      <h2 className="text-lg font-semibold">Invites</h2>
      <ul className="mt-4 space-y-3">
        {invites.map((invite) => (
          <li
            key={invite.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white px-4 py-3"
          >
            <p className="text-sm text-stone-800">
              {invite.email} · {invite.status}
            </p>
            <button
              className={buttonClass}
              type="button"
              onClick={() => void revoke(invite.id)}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
      <form className="mt-4 space-y-3" onSubmit={invite}>
        <label className="block text-sm font-medium text-stone-700">
          Email
          <input className={fieldClass} name="email" type="email" required />
        </label>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        <button className={buttonClass} type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send invite"}
        </button>
      </form>
    </section>
  );
}
