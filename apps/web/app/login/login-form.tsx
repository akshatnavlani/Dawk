"use client";

import { useEffect, useState } from "react";
import {
  API_ORIGIN,
  buttonClass,
  fieldClass,
  linkClass,
  messageFor,
} from "../auth-shared";

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [signInPending, setSignInPending] = useState(false);
  const [linkPending, setLinkPending] = useState(false);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    setError(messageFor(code));
  }, []);

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSignInPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const response = await fetch(`${API_ORIGIN}/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password"),
      }),
    });
    setSignInPending(false);
    if (response.ok) {
      window.location.assign("/account");
      return;
    }
    const body = (await response.json()) as { error?: string };
    setError(messageFor(body.error ?? null));
  }

  async function sendMagicLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLinkPending(true);
    setError(null);
    setNotice(null);
    const form = new FormData(event.currentTarget);
    const response = await fetch(`${API_ORIGIN}/auth/magic-link`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: form.get("email") }),
    });
    setLinkPending(false);
    if (response.ok) {
      setNotice(
        "If the API can print mail locally, the sign-in link is in the API console. It expires in 15 minutes and works once.",
      );
      return;
    }
    const body = (await response.json()) as { error?: string };
    setError(messageFor(body.error ?? null));
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <p className="text-sm font-medium tracking-wide text-stone-500">
        Account
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Sign in</h1>
      <form className="mt-8 space-y-4" onSubmit={signIn}>
        <label className="block text-sm font-medium text-stone-700">
          Email
          <input className={fieldClass} name="email" type="email" required />
        </label>
        <label className="block text-sm font-medium text-stone-700">
          Password
          <input
            className={fieldClass}
            name="password"
            type="password"
            minLength={12}
            required
          />
        </label>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        <button className={buttonClass} type="submit" disabled={signInPending}>
          {signInPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <form
        className="mt-10 space-y-4 border-t border-stone-200 pt-8"
        onSubmit={sendMagicLink}
      >
        <h2 className="text-lg font-semibold">Email me a sign-in link</h2>
        <label className="block text-sm font-medium text-stone-700">
          Email
          <input className={fieldClass} name="email" type="email" required />
        </label>
        {notice ? <p className="text-sm text-stone-600">{notice}</p> : null}
        <button className={buttonClass} type="submit" disabled={linkPending}>
          {linkPending ? "Sending…" : "Send link"}
        </button>
      </form>
      <p className="mt-8 text-sm text-stone-600">
        <a className={linkClass} href={`${API_ORIGIN}/auth/google/start`}>
          Continue with Google
        </a>
      </p>
      <p className="mt-4 text-sm text-stone-500">
        No account yet?{" "}
        <a className={linkClass} href="/signup">
          Create one
        </a>
      </p>
    </main>
  );
}
