import { SCHEMES } from "./schemes.mjs";

export const GITHUB_COMPLETION_SCHEMES = Object.freeze([...SCHEMES]);
export const GITHUB_COMPLETION_ERRORS = Object.freeze([
  "access_denied",
  "authorization_expired",
  "github_unavailable",
  "handoff_expired",
  "invalid_callback",
  "nonce_mismatch",
  "not_configured",
  "oauth_failed",
  "signed_out",
  "storage_failed",
]);
/** The user has one minute to select Open Zeros. The backend retains a separate
 * 30-second grace period for the desktop's authenticated exchange. */
export const GITHUB_COMPLETION_LINK_TTL_MS = 60_000;

/** Parse the fragment without trusting it as a URL. This function is embedded
 * verbatim with Function.prototype.toString(), so it MUST remain self-contained
 * apart from browser-standard URLSearchParams. The serialization regression
 * test revives it without this module's scope to enforce that build contract. */
export function parseGithubCompletionFragment(
  rawFragment,
  allowedSchemes,
  allowedErrors,
) {
  const params = new URLSearchParams(
    rawFragment.startsWith("#") ? rawFragment.slice(1) : rawFragment,
  );
  const scheme = params.get("scheme") ?? "";
  const nonce = params.get("nonce") ?? "";
  const error = params.get("error") ?? "";
  if (
    !allowedSchemes.includes(scheme) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(nonce) ||
    (error && !allowedErrors.includes(error))
  ) {
    return { kind: "invalid" };
  }

  const handoff = new URLSearchParams({
    nonce,
    ...(error ? { error } : {}),
  });
  const deepLink = `${scheme}://github/connected#${handoff.toString()}`;
  return error
    ? { kind: "error", error, deepLink }
    : { kind: "connected", deepLink };
}

/** Remove the nonce from both live page state and the anchor after a short
 * gesture window. This function is embedded verbatim in the completion page,
 * so it must remain self-contained. Returning the idempotent expiry callback
 * also lets pagehide clear an abandoned page before the timer fires. */
export function armGithubCompletionExpiry(
  parsed,
  elements,
  schedule,
  timeoutMs,
) {
  const expire = () => {
    if ("deepLink" in parsed) parsed.deepLink = "";
    elements.open.removeAttribute("href");
    elements.open.hidden = true;
    elements.title.textContent = "This GitHub handoff has expired";
    elements.sub.textContent =
      "Return to Zeros, open Settings → Integrations, and start the connection again.";
    elements.msg.textContent = "";
  };
  schedule(expire, timeoutMs);
  return expire;
}
