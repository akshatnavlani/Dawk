"use client";

import { useEffect, useState } from "react";
import { API_ORIGIN, buttonClass, linkClass, messageFor } from "../auth-shared";

type Invite = {
  id: string;
  projectId: string;
  projectName: string;
  expiresAt: string;
};

export function InvitesList() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const response = await fetch(`${API_ORIGIN}/invites`, {
      credentials: "include",
    });
    if (response.status === 401) {
      window.location.assign("/login?next=/invites");
      return;
    }
    if (!response.ok) {
      return;
    }
    const body = (await response.json()) as { invites?: Invite[] };
    setInvites(body.invites ?? []);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch(`${API_ORIGIN}/invites`, {
        credentials: "include",
      });
      if (cancelled) {
        return;
      }
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as { invites?: Invite[] };
      setInvites(body.invites ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function act(id: string, action: "accept" | "decline") {
    setError(null);
    const response = await fetch(
      action === "accept"
        ? `${API_ORIGIN}/invites/${id}/accept`
        : `${API_ORIGIN}/invites/decline`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body:
          action === "decline" ? JSON.stringify({ inviteId: id }) : undefined,
      },
    );
    const body = (await response.json()) as {
      error?: string;
      projectId?: string;
    };
    if (!response.ok) {
      setError(messageFor(body.error ?? null));
      return;
    }
    if (action === "accept" && body.projectId) {
      window.location.assign(`/projects/${body.projectId}`);
      return;
    }
    await load();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col px-6 py-16">
      <p className="text-sm font-medium tracking-wide text-stone-500">
        Projects
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Invites</h1>
      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      <ul className="mt-8 space-y-3">
        {invites.length === 0 ? (
          <li className="text-sm text-stone-500">No pending invites.</li>
        ) : (
          invites.map((invite) => (
            <li
              key={invite.id}
              className="rounded-lg border border-stone-200 bg-white px-4 py-3"
            >
              <p className="font-medium">{invite.projectName}</p>
              <div className="mt-3 flex gap-2">
                <button
                  className={buttonClass}
                  type="button"
                  onClick={() => void act(invite.id, "accept")}
                >
                  Accept
                </button>
                <button
                  className={buttonClass}
                  type="button"
                  onClick={() => void act(invite.id, "decline")}
                >
                  Decline
                </button>
              </div>
            </li>
          ))
        )}
      </ul>
      <p className="mt-8 text-sm text-stone-500">
        <a className={linkClass} href="/account">
          Account
        </a>
      </p>
    </main>
  );
}
