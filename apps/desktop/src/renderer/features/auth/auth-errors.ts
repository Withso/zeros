// ──────────────────────────────────────────────────────────
// Auth error → calm, user-facing copy (pure, unit-testable)
// ──────────────────────────────────────────────────────────
//
// Extracted from auth-context so it can be regression-tested in isolation
// (the audit asked for an enumeration-neutrality guard). Maps common
// auth errors to short, non-leaky copy and falls back to a generic message so
// raw backend text is never surfaced.
//
// ENUMERATION-NEUTRALITY (load-bearing): there is intentionally NO branch that
// echoes a per-ADDRESS message (e.g. "sign-ups disabled for this address").
// Under any future shouldCreateUser:false (sign-in-only) path, such a message
// would differ for existing vs unknown emails = an account-existence oracle.
// Keep every mapping address-agnostic. (See auth-errors.test.ts.)

export function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("rate limit") || m.includes("only request this after")) {
    return "Too many attempts. Please wait a minute and try again.";
  }
  if (m.includes("expired") || m.includes("invalid") || m.includes("token")) {
    return "That code is incorrect or has expired. Request a new one.";
  }
  if (m.includes("network") || m.includes("fetch") || m.includes("reach")) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  // Do NOT surface a per-address "sign-ups disabled for this address" message:
  // under any future shouldCreateUser:false (sign-in-only) path that would be an
  // email-enumeration oracle. Collapse to the generic message.
  if (m.includes("signups not allowed") || m.includes("not allowed")) {
    return "Something went wrong. Please try again.";
  }
  // Unmapped server message — don't surface raw backend text to the user.
  console.debug("[auth] unmapped auth error");
  return "Something went wrong. Please try again.";
}

/** Native errors may include the URL that failed to open, including its
 * short-lived state and PKCE challenge. Keep both diagnostics and UI fixed. */
export function safeBrowserSignInStartError(_error: unknown): string {
  console.debug("[auth] browser sign-in start failed");
  return "Couldn't start sign-in. Please try again.";
}
