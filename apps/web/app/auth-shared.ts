export const API_ORIGIN = "http://127.0.0.1:3001";

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
};

export function messageFor(code: string | null): string | null {
  if (!code) {
    return null;
  }
  return messages[code] ?? "Something went wrong. Try again.";
}

export const fieldClass =
  "mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900 outline-none focus:border-stone-500";

export const buttonClass =
  "rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700";

export const linkClass =
  "font-medium text-stone-800 underline decoration-stone-300 underline-offset-4";
