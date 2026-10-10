export const API_ORIGIN =
  process.env.NEXT_PUBLIC_API_ORIGIN &&
  process.env.NEXT_PUBLIC_API_ORIGIN.trim().length > 0
    ? process.env.NEXT_PUBLIC_API_ORIGIN.replace(/\/$/, "")
    : "http://127.0.0.1:3001";

const messages: Record<string, string> = {
  invalid_credentials: "That email and password did not match.",
  invalid_request: "Check the email and password, then try again.",
  email_taken: "That email is already in use.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
  unauthorized: "Sign in again to continue.",
  magic_invalid: "That sign-in link is not valid.",
  magic_used: "That sign-in link was already used. Request a new one.",
  magic_expired: "That sign-in link expired. Request a new one.",
  oauth_cancelled: "Google sign-in was cancelled.",
  oauth_state: "Google sign-in could not be verified. Try again.",
  oauth_failed: "Google sign-in failed. Try again.",
  email_unverified: "Google did not confirm that email address.",
  oauth_account_mismatch: "That Google account does not match this email.",
  google_not_configured: "Google sign-in is not configured on this API.",
  email_verify_invalid: "That email confirmation link is not valid.",
  email_verify_used: "That email confirmation link was already used.",
  email_verify_expired:
    "That email confirmation link expired. Request a new one.",
  not_found: "That project was not found.",
  forbidden: "Only the project owner can do that.",
  credential_not_in_project: "That key belongs to another project.",
  credential_in_use: "That key is still used by a past run.",
  plan_superseded: "That plan is no longer the one waiting for approval.",
  decision_not_pending: "That decision is no longer pending.",
  already_member: "That person is already in the project.",
  invite_invalid: "That invite is not valid.",
  invite_revoked: "That invite was revoked.",
  invite_expired: "That invite expired. Ask for a new one.",
  invite_declined: "That invite was declined.",
  invite_email_mismatch: "Sign in with the invited email address.",
  mail_failed: "The email could not be sent. Try again.",
  mail_unverified_sender:
    "The From address must be a verified Resend sender, and until a domain is verified Resend only delivers to the account owner's inbox.",
  queued: "That request is queued until the Orchestrator is free.",
  queue_full: "The queue is full. Try again later.",
  intent_required: "Say whether this is work to queue or a question.",
  qa_busy: "A question is already being answered.",
  specialist_exists: "That specialist channel already exists.",
};

export function messageFor(code: string | null): string | null {
  if (!code) {
    return null;
  }
  return messages[code] ?? "Something went wrong. Try again.";
}

export async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

export function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  if (next?.startsWith("/invites/accept")) {
    return next;
  }
  return "/account";
}

export const fieldClass =
  "mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900 outline-none focus:border-stone-500";

export const buttonClass =
  "rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700";

export const linkClass =
  "font-medium text-stone-800 underline decoration-stone-300 underline-offset-4";
