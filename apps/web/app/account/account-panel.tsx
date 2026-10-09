"use client";

import { useEffect, useState } from "react";
import {
  API_ORIGIN,
  buttonClass,
  fieldClass,
  linkClass,
  messageFor,
} from "../auth-shared";

export function AccountPanel() {
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    setError(messageFor(code));
    void (async () => {
      const response = await fetch(`${API_ORIGIN}/auth/session`, {
        credentials: "include",
      });
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      const body = (await response.json()) as { email?: string };
      setEmail(body.email ?? null);
    })();
  }, []);

  async function logout() {
    await fetch(`${API_ORIGIN}/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    window.location.assign("/login");
  }

  async function changeEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);
    const form = new FormData(event.currentTarget);
    const response = await fetch(`${API_ORIGIN}/auth/email`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: form.get("email") }),
    });
    setPending(false);
    if (response.ok) {
      setNotice(
        "Confirmation link printed in the API console. The address changes only after you open it.",
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
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">
        Your account
      </h1>
      <p className="mt-3 text-stone-600">
        {email ? `Signed in as ${email}.` : "Checking session…"}
      </p>
      <button
        className={`${buttonClass} mt-6 w-fit`}
        type="button"
        onClick={() => void logout()}
      >
        Log out
      </button>
      <form
        className="mt-10 space-y-4 border-t border-stone-200 pt-8"
        onSubmit={changeEmail}
      >
        <h2 className="text-lg font-semibold">Change email</h2>
        <label className="block text-sm font-medium text-stone-700">
          New email
          <input className={fieldClass} name="email" type="email" required />
        </label>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        {notice ? <p className="text-sm text-stone-600">{notice}</p> : null}
        <button className={buttonClass} type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send confirmation"}
        </button>
      </form>
      <p className="mt-8 text-sm text-stone-500">
        <a className={linkClass} href="/">
          Back to status
        </a>
      </p>
    </main>
  );
}
