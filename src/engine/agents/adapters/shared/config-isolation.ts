// ──────────────────────────────────────────────────────────
// Config-isolation guard — never relocate an agent's config root.
// ──────────────────────────────────────────────────────────
//
// Zeros runs the REAL Claude / Codex / Cursor agents, which each load
// their OWN native config from disk (MCP servers, repo rules, model
// prefs, auth). That "pass-through" is the whole reason a user's
// already-configured MCP servers keep working inside Zeros
// (docs/mcp-consolidated-architecture-audit-and-test-plan-2026-06-30.md, Appendix E).
//
// Each of these env vars, if pointed somewhere other than the user's
// real home/config dir, silently sends an agent to a DIFFERENT config
// directory — so it stops loading ~/.codex/config.toml, ~/.claude.json,
// ~/.cursor/mcp.json, repo rules, etc. That breakage is invisible
// (no error, the agent just "doesn't see" the user's servers), which is
// exactly the kind of regression that's painful to diagnose later.
//
// Invariant (Phase 0.2): the env Zeros builds for any spawned agent must
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

/** Return a copy of `env` with every config-root var forced back to its
 *  ambient `process.env` value (deleted when the ambient value is unset),
 *  so a spawned agent can never be pointed at an isolated config dir.
 *  Does not mutate the input. */
export function preserveAmbientConfigRoots(
  env: Record<string, string>,
): Record<string, string> {
  const out = { ...env };
  for (const key of CONFIG_ROOT_ENV_VARS) {
    const ambient = process.env[key];
    if (ambient === undefined) delete out[key];
    else out[key] = ambient;
  }
  return out;
}
