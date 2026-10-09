"use client";

import { useState } from "react";
import {
  API_ORIGIN,
  buttonClass,
  fieldClass,
  linkClass,
  messageFor,
  nextPath,
} from "../auth-shared";

export function SignupForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const response = await fetch(`${API_ORIGIN}/auth/signup`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password"),
      }),
    });
    setPending(false);
    if (response.ok) {
      window.location.assign(nextPath());
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
        Create account
      </h1>
      <p className="mt-3 text-stone-600">
        Use a password of at least 12 characters. This does not create a
        project.
      </p>
      <form className="mt-8 space-y-4" onSubmit={onSubmit}>
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
        <button className={buttonClass} type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create account"}
        </button>
      </form>
      <p className="mt-6 text-sm text-stone-500">
        Already have an account?{" "}
        <a className={linkClass} href="/login">
          Sign in
        </a>
      </p>
    </main>
  );
}
