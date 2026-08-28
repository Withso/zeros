// ──────────────────────────────────────────────────────────
// Config-isolation guard — never relocate an agent's config root.
// ──────────────────────────────────────────────────────────
//
// Zeros runs the REAL Claude / Codex / Cursor agents, which each load
// their OWN native config from disk (MCP servers, repo rules, model
// prefs, auth). That "pass-through" is the whole reason a user's
// already-configured MCP servers keep working inside Zeros.
//
// Each of these env vars, if pointed somewhere other than the user's
// real home/config dir, silently sends an agent to a DIFFERENT config
// directory — so it stops loading ~/.codex/config.toml, ~/.claude.json,
// ~/.cursor/mcp.json, repo rules, etc. That breakage is invisible
// (no error, the agent just "doesn't see" the user's servers), which is
// exactly the kind of regression that's painful to diagnose later.
//
// Invariant: the environment Zeros builds for any spawned agent must
// expose the SAME config roots the engine itself sees — i.e. these vars
// must equal their ambient `process.env` values, never an injected
// override. Every spawn-env builder routes through
// `preserveAmbientConfigRoots`. A future feature that genuinely needs an
// isolated config dir (e.g. a sandboxed cloud workspace) must do so
// deliberately, not by accident.

/** Env vars that each relocate an agent's config/home root. Overriding any
 *  of them breaks native config pass-through (MCP servers + repo rules). */
export const CONFIG_ROOT_ENV_VARS = [
  "HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
] as const;

/** Engine-process authority must never cross into an agent subprocess. These
 * values are useful to the trusted engine itself, but handing them to a model's
 * shell would let it authenticate back to the loopback control surface, locate
 * private state, or write to the host control pipe. Keep this list deliberately
 * small and capability-oriented: ordinary ZEROS_* workspace context continues
 * to work. */
export const ENGINE_AUTHORITY_ENV_VARS = [
  "ZEROS_LOCAL_WS_TOKEN",
  "ZEROS_CLOUD_TOKEN",
  "ZEROS_CLOUD_PORT",
  "ZEROS_CLOUD_RUNTIME_B64",
  "ZEROS_CLOUD_SETUP_BOOT",
  "ZEROS_CONTROL_FD",
  "ZEROS_SECRETS_FILE",
  "ZEROS_DATA_DIR",
  "ZEROS_HOME",
  "ZEROS_SHARED_SECRETS_DIR",
  "ZEROS_USER_SETTINGS_DIR",
  "ZEROS_ENGINE_BASE_PORT",
  "ZEROS_VITE_PORT",
  "ZEROS_ACCOUNT_JWT_SECRET",
  "ZEROS_ACCOUNT_JWT_PUBLIC_KEY",
  "ZEROS_ACCOUNT_JWT_JWKS_URL",
  "ZEROS_ACCOUNT_JWT_ISSUER",
  "ZEROS_ACCOUNT_JWT_AUD",
  "ZEROS_ACCOUNT_JWT_ISS",
  "ZEROS_ACCOUNT_JWT_SKEW",
  "ZEROS_ACCOUNT_JWT_CONTRACT",
  "ZEROS_ACCOUNT_JWT_CLIENT_ID",
  "ZEROS_REQUIRE_ACCOUNT",
  "ZEROS_CLOUD_OWNER_SUB",
  "CONDUCTOR_API_TOKEN",
  "CONDUCTOR_INTERNAL_WORKSPACE_AUTH",
] as const;

function isEngineAuthorityEnvName(name: string): boolean {
  return (
    (ENGINE_AUTHORITY_ENV_VARS as readonly string[]).includes(name) ||
    name.startsWith("ZEROS_ZSR_") ||
    /^CONDUCTOR_.*(?:TOKEN|SECRET|AUTH|CREDENTIAL|COOKIE|PRIVATE_KEY)$/.test(
      name,
    )
  );
}

/** Return a copy with every engine-only capability removed. Deletion happens
 * after caller/session layering so a repo, user setting, or direct spawn option
 * cannot put a same-named authority value back. */
export function stripEngineAuthorityEnv(
  env: Record<string, string>,
): Record<string, string> {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (isEngineAuthorityEnvName(key)) delete out[key];
  }
  return out;
}

/** Construct the one complete ambient-compatible environment at the trusted
 * gateway boundary. Downstream adapters and supervisors treat its result as
 * authoritative and must not spread `process.env` again. */
export function completeAgentSpawnEnv(
  overrides: Record<string, string> | undefined,
): Record<string, string> {
  const ambient = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return preserveAmbientConfigRoots({ ...ambient, ...(overrides ?? {}) });
}

/** Return a copy of `env` with every config-root var forced back to its
 *  ambient `process.env` value (deleted when the ambient value is unset),
 *  so a spawned agent can never be pointed at an isolated config dir.
 *  Does not mutate the input. */
export function preserveAmbientConfigRoots(
  env: Record<string, string>,
): Record<string, string> {
  const out = stripEngineAuthorityEnv(env);
  for (const key of CONFIG_ROOT_ENV_VARS) {
    const ambient = process.env[key];
    if (ambient === undefined) delete out[key];
    else out[key] = ambient;
  }
  return out;
}
