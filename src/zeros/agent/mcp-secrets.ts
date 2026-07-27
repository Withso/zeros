// ──────────────────────────────────────────────────────────
// MCP secrets — Keychain-backed, couriered into the agent's process env
// ──────────────────────────────────────────────────────────
//
// An MCP server's secret env var (e.g. a token) is NEVER written into the MCP
// config we hand an agent — for Codex that config lands on the `-c mcp_servers
// .x.env=…` command line (a `ps` leak). Instead:
//   • settings.toml stores the env value as the sentinel `${zeros.secret}`,
//   • the real value lives in the OS Keychain (account `mcp::<ENV_NAME>`),
//   • the engine STRIPS the sentinel from the registry (mcp-registry.ts), and
//   • this module couriers the real value into the agent's PROCESS env at spawn,
//     so a stdio MCP server INHERITS it (the standard MCP-host behavior).
//
// HTTP `Authorization` headers can't be inherited (they're not env), so http
// header secrets are out of scope here — they wait for the Phase-2 gateway.
//
// Keychain values are per-machine. The secret env NAMES come from the
// sentinel'd entries of the USER layer plus — when the spawn cwd belongs to a
// repo — that repo's PERSONAL repo-local layer (the Customize tab's repo
// scope). Repo-scope values live under their own per-repo accounts so two
// repos can hold different values for the same NAME; a repo value wins over a
// user one at spawn (matching the engine's repo-local > user precedence).
// ──────────────────────────────────────────────────────────

import { deleteSecret, getSecret, setSecret } from "../../native/secrets";
import { bridgeSettingsRead } from "../bridge/workspace-bridge";
import type { RuntimeClient } from "../bridge/ws-client";
import { normalizeProjectRoot } from "../store/projects-store";
import { MCP_SECRET_SENTINEL } from "../panels/mcp-panel-helpers";
import { vaultRepoRootForCwd } from "./env-vault";

/** Re-exported for the courier's callers; the pure renderer definition (which
 *  MUST match the engine) lives in mcp-panel-helpers.ts. */
export { MCP_SECRET_SENTINEL };

/** The scope an MCP secret belongs to: the user-global set, or one repo's
 *  (keyed by its MAIN checkout root — every worktree shares it). */
export type McpSecretScope = { kind: "user" } | { kind: "repo"; repoRoot: string };

/** Keychain account for an MCP secret env var, under the `mcp::` prefix the
 *  renderer keychain allowlist permits (electron/keychain-accounts.ts).
 *  User scope: `mcp::<NAME>` (the historical shape — existing secrets keep
 *  working). Repo scope: `mcp::repo::<normalized main root>::<NAME>`, the
 *  same root normalization the env vault uses, so two repos can store
 *  different values for the same NAME. */
export function mcpSecretAccount(
  envVarName: string,
  scope: McpSecretScope = { kind: "user" },
): string {
  return scope.kind === "user"
    ? `mcp::${envVarName}`
    : `mcp::repo::${normalizeProjectRoot(scope.repoRoot)}::${envVarName}`;
}

export const setMcpSecret = (
  envVarName: string,
  value: string,
  scope?: McpSecretScope,
): Promise<void> => setSecret(mcpSecretAccount(envVarName, scope), value);
export const getMcpSecret = (
  envVarName: string,
  scope?: McpSecretScope,
): Promise<string | null> => getSecret(mcpSecretAccount(envVarName, scope));
export const clearMcpSecret = (
  envVarName: string,
  scope?: McpSecretScope,
): Promise<void> => deleteSecret(mcpSecretAccount(envVarName, scope));

/** Whether a settings env/headers VALUE marks a Keychain-backed secret. */
export function isSecretRef(value: unknown): boolean {
  return value === MCP_SECRET_SENTINEL;
}

/** Heuristic: does an env var NAME look like it holds a secret? Used by the
 *  adopt wizard to auto-move a token's value into the Keychain on import rather
 *  than copying it into the settings file in plain text. */
// Biased toward matching: a false positive just stores a non-secret value in
// the Keychain (it still reaches the server via env), whereas a miss leaves a
// real secret in the plain-text settings file. `[_-]key`/`^key` catch KEY as a
// component (an env name's `_` is a regex word char, so `\bkey\b` misses MY_KEY).
const SECRET_NAME_RE = /(token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|credential|bearer|auth|[_-]key|^key)/i;
export function looksSecretEnvName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

/** Collect the distinct env var NAMES marked secret (value === sentinel) across
 *  every server's `env` in a settings layer's raw `mcp.servers`. */
export function secretEnvNamesFromDoc(doc: unknown): string[] {
  const servers = (doc as { mcp?: { servers?: unknown } } | null | undefined)?.mcp?.servers;
  if (!Array.isArray(servers)) return [];
  const names = new Set<string>();
  for (const s of servers) {
    const env = (s as { env?: unknown } | null | undefined)?.env;
    if (typeof env !== "object" || env === null || Array.isArray(env)) continue;
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (isSecretRef(v)) names.add(k);
    }
  }
  return [...names];
}

/** Read one layer's sentinel'd secret NAMES from the Keychain into `out`
 *  (later calls overwrite earlier ones — call user first, repo second so the
 *  repo scope wins). Best-effort per var: a missing/empty secret or a
 *  Keychain error just omits that var. */
async function collectScopeSecrets(
  names: string[],
  scope: McpSecretScope,
  out: Record<string, string>,
): Promise<void> {
  await Promise.all(
    names.map(async (name) => {
      try {
        const value = await getMcpSecret(name, scope);
        if (value) out[name] = value;
      } catch {
        /* omit this var */
      }
    }),
  );
}

/** Resolve the secret MCP env vars from the Keychain into a `{NAME:value}`
 *  map to courier into the agent's process env (a stdio MCP server inherits
 *  it): the USER layer's names, then — when `cwd` belongs to a repo — that
 *  repo's repo-local names (repo values win, matching the engine's
 *  repo-local > user server precedence). Best-effort: a settings-read
 *  failure, a missing/empty secret, or a Keychain error just omits vars — an
 *  agent always spawns. */
export async function deriveMcpSecretEnv(
  bridge: RuntimeClient | null | undefined,
  cwd?: string | null,
): Promise<Record<string, string>> {
  if (!bridge) return {};
  const out: Record<string, string> = {};
  try {
    const read = await bridgeSettingsRead(bridge, "user");
    await collectScopeSecrets(secretEnvNamesFromDoc(read.doc), { kind: "user" }, out);
  } catch {
    /* user layer unreadable — repo scope may still contribute */
  }
  try {
    const repoRoot = await vaultRepoRootForCwd(bridge, cwd);
    if (repoRoot) {
      const read = await bridgeSettingsRead(bridge, "repo-local", repoRoot);
      await collectScopeSecrets(
        secretEnvNamesFromDoc(read.doc),
        { kind: "repo", repoRoot },
        out,
      );
    }
  } catch {
    /* repo layer unreadable — the user-scope vars still courier */
  }
  return out;
}
