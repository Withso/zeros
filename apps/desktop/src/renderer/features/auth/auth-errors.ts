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

const RECOVERY_CODE_RE = /^ZR-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const GENERIC_WORKOS_SIGN_IN_ERROR =
  "We couldn't finish signing you in from the browser. Please try again.";

/** Fixed, non-provider-authored guidance for the bounded WorkOS failure event
 * emitted by Electron main. Only the public recovery locator may be reflected. */
export function workOSSignInFailureMessage(
  reason: string,
  recoveryCode: string | null | undefined,
): string {
  if (reason === "account_recovery_required") {
    const locator =
      typeof recoveryCode === "string" && RECOVERY_CODE_RE.test(recoveryCode)
        ? ` Recovery code: ${recoveryCode}.`
        : "";
    return `For your security, this sign-in must be reviewed before it can be linked to your existing Zeros account. Contact hello@zeros.build.${locator}`;
  }
  const messages: Record<string, string> = {
    expired:
      "That browser sign-in expired before it finished. Click Sign in to try again.",
    verification_required:
      "Check your inbox — your provider requires you to confirm this email address before its first sign-in. Verify it, then click Sign in again.",
    email_unverified:
      "Verify your email address with your provider, then click Sign in again.",
    provider_error:
      "Your identity provider didn't complete the sign-in. Click Sign in to try again.",
    reauthentication_required:
      "For your security, sign out in the browser and complete a fresh sign-in before retrying.",
    account_exists:
      "A Zeros account already uses this email. Sign in with your original sign-in method; accounts are never linked by email automatically.",
    account_inactive:
      "Your Zeros account is not active. Contact hello@zeros.build if you believe this is a mistake.",
    account_failed:
      "We signed you in, but couldn't reach your Zeros account. Check your connection and click Sign in again.",
    storage_failed:
      "We signed you in, but couldn't save the session to your keychain. Click Sign in to try again.",
  };
  return messages[reason] ?? GENERIC_WORKOS_SIGN_IN_ERROR;
}
