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

/** Parse the fragment without trusting it as a URL. This function is also
 * embedded verbatim in the hosted page, keeping its browser behavior under the
 * same plain-Node regression tests as the desktop scheme allow-list. */
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
