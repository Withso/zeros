// ──────────────────────────────────────────────────────────
// Settings foundation — environment-variable NAME classification
// ──────────────────────────────────────────────────────────
//
// One source of truth for "which env-var NAMES are unsafe", shared by:
//   • ops.ts       — masks secret-shaped names on REMOTE reads, and refuses
//                    them on REMOTE writes (a paired device can't park a
//                    credential in the user `env` table).
//   • spawn-env.ts — drops unsafe names from the settings `env` table and
//                    `env_files` BEFORE they reach a spawned agent.
//
// Keeping the lists/regex here avoids the drift the PR review flagged: the
// read-mask and the spawn-filter must agree, and the spawn-filter is the
// actual security backstop (an agent process holds live keychain creds).
//
// Three independent hazard classes, all dropped at the spawn chokepoint:
//
//   1. CODE INJECTION — names that hijack process startup (NODE_OPTIONS, the
//      dynamic-loader DYLD_/LD_ prefixes, PATH, the GIT_*_COMMAND hooks…). A
//      repo planting these into a Node/agent process is host RCE.
//   2. CREDENTIAL REDIRECT — names that point the agent's API traffic at a
//      host the repo controls (ANTHROPIC_BASE_URL & the other gateway vars),
//      or interpose a proxy / forged CA over ALL of it (HTTP(S)_PROXY,
//      NODE_EXTRA_CA_CERTS…). The agent then ships its keychain API key / OAuth
//      bearer to that host — credential exfiltration. THIS is the gap the
//      review found: these names are neither code-injection nor secret-SHAPED,
//      so the old filters missed them, yet a *committed* `.zeros/settings.toml`
//      `[env]` (or an `env_files` dotenv) could set them with no paired device
//      involved — strictly worse than the remote-write case. Provider gateway
//      base_url lives in USER settings only (never per-repo) for exactly this
//      reason; the `[env]` table is the remaining redirect vector, closed here.
//   3. SECRET-SHAPED — a credential a user wrongly parked in the (documented
//      non-secret) `env` table. Best-effort masking/stripping backstop.
// ──────────────────────────────────────────────────────────

// Best-effort (NOT authoritative) match for secret-shaped env-var NAMES, masked
// before an env table leaves for an untrusted relay client and stripped before
// it reaches a spawned agent. Broad on purpose — the `env` table is documented
// non-secret, so this is only a backstop for users who put a secret there
// anyway. Add names rather than rely on it.
export const SECRET_NAME_RE =
  /(key|token|secret|password|passwd|passphrase|auth|bearer|credential|cookie|session|signing|private|cert|webhook|jwt|dsn|salt|\bpat\b|access)/i;

/** Class 3 — the NAME looks like it holds a credential. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

/** Class 1 — code-injection NAMES. Exact names + the DYLD_/LD_ dynamic-loader
 *  prefixes. A committed/written `env` table or `env_files` MUST NOT set these:
 *  unlike a setup script (whose env is scrubbed), the agent env is not, so this
 *  is the backstop. */
const DANGEROUS_ENV_NAMES = new Set([
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "PATH", // a repo must not redirect the agent's binary search path
  "PERL5OPT",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_PROXY_COMMAND",
  "GIT_PAGER",
  "PAGER",
  // git / ssh auto-EXEC an external program named by these (no user
  // interaction) to obtain credentials or edit a message — the same exec class
  // as GIT_SSH_COMMAND. git runs GIT_ASKPASS on any HTTPS fetch/push/clone.
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "EDITOR",
  "VISUAL",
  // Node auto-requires this module at interpreter startup → arbitrary code.
  "NODE_REPL_EXTERNAL_MODULE",
  // Prepends to Node's module resolution — the agent process ITSELF is Node,
  // so a planted NODE_PATH poisons its own require()s (same class as
  // NODE_OPTIONS). Child-tool path vars (PYTHONPATH, RUBYLIB…) stay allowed:
  // those children execute repo code by design; the agent process must not.
  "NODE_PATH",
]);

export function isDangerousEnvName(name: string): boolean {
  return (
    DANGEROUS_ENV_NAMES.has(name) ||
    name.startsWith("DYLD_") ||
    name.startsWith("LD_") ||
    // GIT_CONFIG / _GLOBAL / _SYSTEM redirect git at an attacker config file,
    // and GIT_CONFIG_COUNT/_KEY_n/_VALUE_n inject config inline — either can set
    // core.sshCommand / core.pager / core.editor to an arbitrary command (exec).
    name.startsWith("GIT_CONFIG")
  );
}

/** Class 2 — credential-redirect / MITM NAMES: provider gateway base-URL + auth
 *  routing vars, generic HTTP proxies, and TLS-trust (CA bundle) vars. EXACT
 *  names only — a generic `*_BASE_URL` (e.g. `MY_APP_BASE_URL`) is a legitimate
 *  use of the `env` table and stays allowed; only the names that actually
 *  redirect an *agent's* credential-bearing egress are blocked. */
const CREDENTIAL_REDIRECT_ENV_NAMES = new Set([
  // Anthropic / Claude — gateway base URL, auth host, and backend toggles that
  // re-route the credential to Bedrock/Vertex.
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  // OpenAI / Codex.
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  // Google / Gemini / Vertex.
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
  // Generic HTTP proxies — interpose on ALL of the agent's egress.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  // TLS trust — a forged CA bundle MITMs even HTTPS traffic.
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
]);

export function isCredentialRedirectEnvName(name: string): boolean {
  return CREDENTIAL_REDIRECT_ENV_NAMES.has(name);
}

export type SpawnEnvHazard = "code-injection" | "credential-redirect" | "secret-shaped";

/** The union the agent-spawn path drops from the settings `env` table /
 *  `env_files`. Returns the hazard class (for a precise warning) or null when
 *  the NAME is safe to pass to the agent. */
export function spawnEnvNameHazard(name: string): SpawnEnvHazard | null {
  if (isDangerousEnvName(name)) return "code-injection";
  if (isCredentialRedirectEnvName(name)) return "credential-redirect";
  if (isSecretEnvName(name)) return "secret-shaped";
  return null;
}
