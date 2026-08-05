// ──────────────────────────────────────────────────────────
// Privacy-safe error scrubbing for analytics / error tracking
// ──────────────────────────────────────────────────────────
//
// Zeros' analytics contract is metadata-only: error MESSAGES and STACKS can
// embed file paths (which leak the username + project layout), branch names,
// prompt fragments, or secrets — so they must be scrubbed before they ever
// reach PostHog. Both sides of the bridge run errors through here first:
//   • the engine, before relaying a caught error to the renderer (gap A), and
//   • the renderer's reportError() for handled errors (gap C).
// Living in @zeros/protocol keeps the redaction rule identical on both sides.
// ──────────────────────────────────────────────────────────

const MAX_MESSAGE = 300;
const MAX_STACK = 2000;
// GitHub's newer installation-token format is long and dot-separated. Both
// `ghs_<app-id>_<opaque>…` and an older observed dotted form occur in logs,
// unlike the legacy single alphanumeric body.
// Match it as one credential so no suffix survives a redaction pass.
const GITHUB_CREDENTIAL_RE =
  /\b(?:ghs_\d+_[A-Za-z0-9._-]{40,}|ghs_[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]{8,})+|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,})\b/g;
const GITHUB_REFRESH_BINDING_RE =
  /\bzghrb_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

/** Redact absolute filesystem paths and obvious secrets from a free-form
 *  string. Conservative by design — when in doubt, redact. The output is safe
 *  to send as analytics metadata. */
export function redactSensitive(input: string): string {
  let s = input;
  s = s.replace(GITHUB_CREDENTIAL_RE, "[redacted]");
  s = s.replace(GITHUB_REFRESH_BINDING_RE, "[redacted]");
  // Email addresses → [email]. Analytics is anonymous (we never identify()), so
  // an email surfacing in an error message (auth faults, "user x@y not found",
  // a path under a mail dir) would be PII. Redact before the path/token rules.
  s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]");
  // POSIX home dirs → ~  (/Users/alice/…, /home/alice/…) — strips the username.
  s = s.replace(/\/(?:Users|home)\/[^/\s:]+/g, "~");
  // Windows user dirs → ~
  s = s.replace(/[A-Za-z]:\\Users\\[^\\\s:]+/g, "~");
  // Any remaining deep absolute POSIX path → /…/<last segment>, so the filename
  // survives (useful for grouping) but the directory tree doesn't leak.
  s = s.replace(/(?:\/[^/\s:]+){3,}/g, (m) => `/…/${m.slice(m.lastIndexOf("/") + 1)}`);
  // Long opaque tokens (SHAs, JWT segments, API keys) → [redacted].
  s = s.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
  return s;
}

/** Redact SECRETS from free-form log text while keeping it debuggable.
 *
 *  Deliberately weaker than redactSensitive(): feedback log exports need
 *  session UUIDs, file paths, and commit SHAs intact to be useful for
 *  debugging (the feedback checkbox already warns "may include personal
 *  data"). What must never ride along is credential material — tokens, JWTs,
 *  API keys, passwords. Applied by the main process to the log tail before it
 *  is exported for viewing or attached to a feedback submission, so what the
 *  user Views is exactly what is shared. */
export function redactLogSecrets(input: string): string {
  let s = input;
  // Emails → [email] (same rationale as redactSensitive — logs are shared
  // with support/issue trackers; the feedback form has its own email field).
  s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]");
  // Secret-bearing JSON fields — replace the VALUE only, keeping the JSONL
  // line parseable: "token":"abc" → "token":"[redacted]". The store writes
  // every record with JSON.stringify, so a secret logged as an object field
  // (console.log({ access_token })) lands in the file with the structural
  // quotes BACKSLASH-ESCAPED (\"access_token\":\"…\"). The \\? before each
  // quote matches that escaped form as well as bare JSON; the [^"\\]* value
  // class stops at the next quote OR backslash so it never leaps a \" boundary
  // and merges adjacent fields (opaque credential values contain neither).
  s = s.replace(
    /(\\?"(?:password|passwd|secret|token|access_token|refresh_token|refresh_binding|refreshBinding|id_token|api_key|apikey|authorization|client_secret|private_key|session_key)\\?"\s*:\s*\\?")[^"\\]*(\\?")/gi,
    "$1[redacted]$2",
  );
  // key=value / key: value forms outside JSON (env dumps, URLs, headers). The
  // value class excludes backslash so it can't swallow a JSON escape backslash
  // (…VALUE\" → …VALUE) and leave a dangling quote that breaks JSON.parse.
  s = s.replace(
    /\b(password|passwd|secret|token|access_token|refresh_token|refresh_binding|refreshBinding|api_key|apikey|client_secret)(=|:\s*)[^\s&"'\\,;]+/gi,
    "$1$2[redacted]",
  );
  // Authorization headers / bearer credentials.
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]");
  // JWTs — three dot-separated base64url segments starting with eyJ.
  s = s.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
    "[jwt]",
  );
  // Known API-key shapes (OpenAI/Anthropic sk-…, GitHub gh?_/github_pat_,
  // Slack xox?-, Stripe pk_/sk_ live keys, AWS AKIA…).
  s = s.replace(GITHUB_CREDENTIAL_RE, "[api-key]");
  s = s.replace(GITHUB_REFRESH_BINDING_RE, "[redacted]");
  s = s.replace(
    /\b(?:sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[a-z]-[A-Za-z0-9-]{10,}|(?:pk|sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16})\b/g,
    "[api-key]",
  );
  return s;
}

export interface ScrubbedError {
  /** Error class/name — e.g. "GitError", "TypeError". Safe (no content). */
  name: string;
  /** Redacted + truncated message. Never raw paths / prompts / secrets. */
  message: string;
  /** Redacted + truncated stack (app frames; absolute paths stripped). */
  stack?: string;
}

/** Turn an arbitrary thrown value into privacy-safe error metadata: the error
 *  class/name plus a redacted, truncated message and stack. Never returns code,
 *  prompts, raw paths, or secrets. Pure + total — safe to call in any catch. */
export function scrubError(err: unknown): ScrubbedError {
  if (err instanceof Error) {
    return {
      name: err.name || "Error",
      message: redactSensitive(err.message || "").slice(0, MAX_MESSAGE),
      stack: err.stack
        ? redactSensitive(err.stack).slice(0, MAX_STACK)
        : undefined,
    };
  }
  return {
    name: "NonError",
    message: redactSensitive(
      typeof err === "string" ? err : String(err),
    ).slice(0, MAX_MESSAGE),
  };
}
