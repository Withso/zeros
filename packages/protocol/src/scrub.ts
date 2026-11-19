// Treat error messages and stacks as potentially sensitive before sending analytics metadata.

const MAX_MESSAGE = 300;
const MAX_STACK = 2000;
// Match dotted GitHub installation tokens as one credential so no suffix survives redaction.
const GITHUB_CREDENTIAL_RE =
  /\b(?:ghs_\d+_[A-Za-z0-9._-]{40,}|ghs_[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]{8,})+|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,})\b/g;
const GITHUB_REFRESH_BINDING_RE =
  /\bzghrb_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const AUTH0_DESKTOP_CAPABILITY_RE = /\bz0d_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
const CLOUD_CAPABILITY_RE = /\b(?:zws|zwh|zwb|zwp|zsh|zgw|zgp|zgn|zwa)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
const CLOUD_PROTOCOL_CREDENTIAL_RE = /\bzeros-cloud-token\.[A-Za-z0-9_-]{63}(?![A-Za-z0-9_-])/g;

/** Tokenize once before testing a candidate. An unanchored email expression
 * retries every suffix of a long malformed local part, producing quadratic work. */
function redactEmails(input: string): string {
  return input.replace(/[A-Za-z0-9._%+-]+(?:@[A-Za-z0-9.-]+)?/g, (candidate) => {
    if (!candidate.includes("@")) return candidate;
    return candidate.replace(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, "[email]");
  });
}

/** Telemetry export redacts emails, usernames, directory trees, recognizable secrets and long opaque tokens such as SHAs. */
export function redactSensitive(input: string): string {
  let s = input;
  s = s.replace(AUTH0_DESKTOP_CAPABILITY_RE, "[redacted]");
  s = s.replace(GITHUB_CREDENTIAL_RE, "[redacted]");
  s = s.replace(GITHUB_REFRESH_BINDING_RE, "[redacted]");
  // Redact email addresses before path and token substitutions can fragment them.
  s = redactEmails(s);
  s = s.replace(/\/(?:Users|home)\/[^/\s:]+/g, "~");
  s = s.replace(/[A-Za-z]:\\Users\\[^\\\s:]+/g, "~");
  // Keep the last path segment for error grouping without retaining the directory tree.
  s = s.replace(/(?:\/[^/\s:]+){3,}/g, (m) => `/…/${m.slice(m.lastIndexOf("/") + 1)}`);
  s = s.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
  return s;
}

/** Feedback log exports preserve UUIDs, paths and SHAs for debugging; use this scrubber for both preview and submission. */
export function redactLogSecrets(input: string): string {
  let s = input;
  s = s.replace(AUTH0_DESKTOP_CAPABILITY_RE, "[redacted]");
  // Cloud headers and WebSocket subprotocols can carry credentials outside standard auth fields.
  s = s.replace(CLOUD_CAPABILITY_RE, "[redacted]");
  s = s.replace(CLOUD_PROTOCOL_CREDENTIAL_RE, "[redacted]");
  // Exported logs may go to support or issue trackers; remove emails from the log payload.
  s = redactEmails(s);
  // Keep JSONL parseable: replace values in bare or quote-escaped fields without crossing their delimiters.
  s = s.replace(
    /(\\?"(?:password|passwd|secret|token|access_token|refresh_token|refresh_binding|refreshBinding|id_token|api_key|apikey|authorization|client_secret|private_key|session_key)\\?"\s*:\s*\\?")[^"\\]*(\\?")/gi,
    "$1[redacted]$2",
  );
  // Stop before a backslash so a following JSON escape remains valid.
  s = s.replace(
    /\b(password|passwd|secret|token|access_token|refresh_token|refresh_binding|refreshBinding|api_key|apikey|client_secret)(=|:\s*)[^\s&"'\\,;]+/gi,
    "$1$2[redacted]",
  );
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]");
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
  name: string;
  message: string;
  stack?: string;
}

/** Keep the error class but scrub and bound its message and stack for telemetry. */
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
