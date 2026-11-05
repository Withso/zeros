// Standalone deployment mirror of protocol/env-names; parity is tested.
// Name-based masking is a backstop for Local settings documented as non-secret.
export const SECRET_NAME_RE =
  /(key|token|secret|password|passwd|passphrase|auth|bearer|credential|cookie|session|signing|private|cert|webhook|jwt|dsn|salt|\bpat\b|access)/i;

export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

// Ordinary settings must not select provider authority or executable startup hooks.
const DANGEROUS_ENV_NAMES = new Set([

  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "CURSOR_CONFIG_DIR",
  "CLAUDE_ALLOWED_TOOLS",
  "CLAUDE_DISALLOWED_TOOLS",
  "CLAUDE_CODE_SKIP_PERMISSIONS",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "PATH",
  "PERL5OPT",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_PROXY_COMMAND",
  "GIT_PAGER",
  "PAGER",

  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "EDITOR",
  "VISUAL",

  "NODE_REPL_EXTERNAL_MODULE",

  // Child-tool paths such as PYTHONPATH stay allowed; NODE_PATH redirects the agent itself.
  "NODE_PATH",
]);

/** Excludes Zeros control names so trusted admission can still supply engine context. */
export function isRuntimeInjectionEnvName(name: string): boolean {
  return (
    DANGEROUS_ENV_NAMES.has(name) ||
    name.startsWith("DYLD_") ||
    name.startsWith("LD_") ||

    // Git configuration can install executable credential, SSH and editor hooks.
    name.startsWith("GIT_CONFIG")
  );
}

export function isDangerousEnvName(name: string): boolean {
  return (
    isRuntimeInjectionEnvName(name) ||

    // Reserve future engine controls too, without waiting for an exact-name update.
    name.startsWith("ZEROS_")
  );
}

// Only provider routing names are blocked; application-specific base URLs remain valid.
const CREDENTIAL_REDIRECT_ENV_NAMES = new Set([

  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",

  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",

  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",

  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",

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

export type SpawnEnvHazard =
  | "code-injection"
  | "credential-redirect"
  | "secret-shaped";

export function spawnEnvNameHazard(name: string): SpawnEnvHazard | null {
  if (isDangerousEnvName(name)) return "code-injection";
  if (isCredentialRedirectEnvName(name)) return "credential-redirect";
  if (isSecretEnvName(name)) return "secret-shaped";
  return null;
}
