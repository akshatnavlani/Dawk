"use client";

import { useEffect, useState } from "react";
import {
  API_ORIGIN,
  buttonClass,
  linkClass,
  messageFor,
} from "../../auth-shared";

export function AcceptInvite() {
  const [token, setToken] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("token");
    setToken(value);
    let cancelled = false;
    void (async () => {
      const session = await fetch(`${API_ORIGIN}/auth/session`, {
        credentials: "include",
      });
      if (cancelled) {
        return;
      }
      if (!session.ok || !value) {
        setSignedIn(session.ok);
        return;
      }
      setSignedIn(true);
      setPending(true);
      const response = await fetch(`${API_ORIGIN}/invites/accept`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: value }),
      });
      if (cancelled) {
        return;
      }
      setPending(false);
      const body = (await response.json()) as {
        error?: string;
        projectId?: string;
      };
      if (!response.ok) {
        setError(messageFor(body.error ?? null));
        return;
      }
      window.location.assign(`/projects/${body.projectId ?? ""}`);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const next = "/invites/accept";
  const returnTo = token ? `${next}?token=${encodeURIComponent(token)}` : next;

  async function accept() {
    if (!token) {
      setError(messageFor("invite_invalid"));
      return;
    }
    setPending(true);
    setError(null);
    const response = await fetch(`${API_ORIGIN}/invites/accept`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    setPending(false);
    const body = (await response.json()) as {
      error?: string;
      projectId?: string;
    };
    if (!response.ok) {
      setError(messageFor(body.error ?? null));
      return;
    }
    window.location.assign(`/projects/${body.projectId ?? ""}`);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <p className="text-sm font-medium tracking-wide text-stone-500">
        Projects
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">
        Project invite
      </h1>
      <p className="mt-3 text-stone-600">
        This link expires in 7 days and works once.
      </p>
      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      {signedIn ? (
        <button
          className={`${buttonClass} mt-8 w-fit`}
          type="button"
          disabled={pending || !token}
          onClick={() => void accept()}
        >
          {pending ? "Joining…" : "Accept invite"}
        </button>
      ) : (
        <p className="mt-8 text-sm text-stone-600">
          <a
            className={linkClass}
            href={`/login?next=${encodeURIComponent(returnTo)}`}
          >
            Sign in
          </a>
          {" or "}
          <a
            className={linkClass}
            href={`/signup?next=${encodeURIComponent(returnTo)}`}
          >
            create an account
          </a>{" "}
          with the invited email.
        </p>
      )}
    </main>
  );
}
