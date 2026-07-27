// ──────────────────────────────────────────────────────────
// Environment vault — ALL UI-managed env vars live encrypted in the Keychain
// ──────────────────────────────────────────────────────────
//
// Security model (2026-07-16, docs/env-keychain-vault-2026-07-16.md): an env
// var added in Settings → Environment (user scope) or a repo page's
// Environment tab (repo scope) is NEVER written to settings.toml /
// settings.local.toml — not even as a sentinel-marked name. Both scopes live
// in the encrypted secret store (Electron safeStorage; "the Keychain" to
// users) as ONE JSON map per scope:
//
//   envvault::user                    → {"version":1,"vars":{NAME:value}}
//   envvault::repo::<main repo root>  → {"version":1,"vars":{NAME:value}}
//
// The repo scope is keyed by the MAIN checkout's normalized absolute path —
// the same key the settings layers use — so every worktree of the repo shares
// it. Values are per-user, per-machine by design: a teammate's clone never
// sees them. A team that wants shared non-secret vars hand-commits `[env]` in
// .zeros/settings.toml, which still resolves through the engine's
// hazard-filtered spawn-env path and shows here as read-only inherited rows.
//
// At spawn, deriveEnvVaultEnv composes user + repo scope (repo wins) into the
// caller env the renderer hands the engine — the agent PROCESS inherits the
// values in every worktree, but no file on disk ever holds them. The vault
// protects secrets AT REST, not from the agent: agents are meant to use them.
//
// Name hygiene: code-injection NAMES (NODE_OPTIONS, PATH, DYLD_*/LD_*,
// GIT_CONFIG* — the engine's isDangerousEnvName, imported directly so the two
// can never drift) are refused at write time AND dropped at read time
// (defense in depth — a hand-edited secrets.json must not become an injection
// vector). Secret-shaped names are the POINT of the vault, and
// credential-redirect names (HTTP_PROXY…) stay allowed: both scopes are typed
// by the machine owner in the local UI — the trust the engine already grants
// the user / repo-local settings layers — never read from a committed file.
// ──────────────────────────────────────────────────────────

import { isDangerousEnvName } from "../../engine/settings/env-names";
import {
  deleteSecret,
  getSecret,
  hasSecret,
  setSecret,
} from "../../native/secrets";
import { resolveBridgeRepoRootForCwd } from "../bridge/workspace-id-resolver";
import type { RuntimeClient } from "../bridge/ws-client";
import { loadProjects, normalizeProjectRoot } from "../store/projects-store";
import { findProjectForFolder } from "../store/workspace-resolution";

export type EnvVaultScope =
  | { kind: "user" }
  | { kind: "repo"; repoRoot: string };

/** Secret-store account for a scope's vault. Distinct `envvault::` namespace
 *  (allowlisted in electron/keychain-accounts.ts) so it can never collide with
 *  MCP's `mcp::<NAME>` accounts. */
export function envVaultAccount(scope: EnvVaultScope): string {
  return scope.kind === "user"
    ? "envvault::user"
    : `envvault::repo::${normalizeProjectRoot(scope.repoRoot)}`;
}

// ── Name validation ──────────────────────────────────────

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why a NAME may not be stored in the vault, or null when it's fine. The
 *  string is user-facing (surfaced by the Environment UI on save). */
export function envVaultNameError(name: string): string | null {
  if (!ENV_NAME_RE.test(name))
    return "names use letters, digits and _ (not starting with a digit)";
  if (isDangerousEnvName(name))
    return "this name can change how programs start, so agents never receive it";
  return null;
}

// ── Payload (de)serialization — pure, exported for tests ─

const VAULT_VERSION = 1;

export function serializeEnvVault(vars: Record<string, string>): string {
  return JSON.stringify({ version: VAULT_VERSION, vars });
}

/** Tolerant parse: malformed JSON, wrong shape, or non-string values yield the
 *  empty map / skip the entry — a corrupt store must never break spawns. Drops
 *  dangerous names on READ too, so editing secrets.json by hand can't smuggle
 *  a code-injection var past the write-time check. */
export function parseEnvVault(raw: string | null): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const vars = (parsed as { vars?: unknown } | null)?.vars;
  if (typeof vars !== "object" || vars === null || Array.isArray(vars))
    return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    if (envVaultNameError(k)) continue;
    out[k] = v;
  }
  return out;
}

// ── Store access ─────────────────────────────────────────

/** EDITOR read — a storage failure THROWS. The Environment UI must be able to
 *  tell "empty" from "couldn't read": it writes back the WHOLE scope map, so
 *  treating a failed read as `{}` would let the next save silently destroy
 *  every stored variable in the scope.
 *
 *  getSecret alone can't uphold that: the secret store swallows decrypt
 *  failures into the same `null` as "never stored" (a changed OS keystore key
 *  reads as an empty vault). So a null read is cross-checked against a
 *  presence probe (`hasSecret`, key-only, no decrypt) and an EXISTING but
 *  unreadable entry throws. A payload that exists but doesn't parse as a
 *  vault map (corrupt, or a future format this build predates) throws for the
 *  same reason — only the spawn path is tolerant. */
export async function readEnvVaultForEdit(
  scope: EnvVaultScope,
): Promise<Record<string, string>> {
  const account = envVaultAccount(scope);
  const raw = await getSecret(account);
  if (raw === null) {
    if (await hasSecret(account)) {
      throw new Error(
        "environment vault entry exists but couldn't be decrypted",
      );
    }
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("environment vault payload is corrupt");
  }
  const vars = (parsed as { vars?: unknown } | null)?.vars;
  if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
    throw new Error("environment vault payload has an unexpected shape");
  }
  return parseEnvVault(raw);
}

/** SPAWN read — the scope's vars, `{}` on any failure (an agent always
 *  spawns; a read error just means fewer vars). */
export async function readEnvVault(
  scope: EnvVaultScope,
): Promise<Record<string, string>> {
  try {
    return await readEnvVaultForEdit(scope);
  } catch {
    return {};
  }
}

/** Replace the scope's map. Rejects invalid/dangerous names (throws — the UI
 *  validates first, so this is the backstop). An empty map deletes the account
 *  so secrets.json doesn't accumulate empty blobs. */
export async function writeEnvVault(
  scope: EnvVaultScope,
  vars: Record<string, string>,
): Promise<void> {
  for (const name of Object.keys(vars)) {
    const err = envVaultNameError(name);
    if (err) throw new Error(`${name}: ${err}`);
  }
  const account = envVaultAccount(scope);
  if (Object.keys(vars).length === 0) {
    await deleteSecret(account);
    return;
  }
  await setSecret(account, serializeEnvVault(vars));
}

// ── Legacy `env::` secret import — pure planner (one-time migration) ─
//
// Before the vault (2026-07-16), the Environment UI's 🔒 stored a value under
// the per-name Keychain account `env::<NAME>` and wrote the
// `"${zeros.secret}"` sentinel into the user settings.toml `[env]` table; a
// renderer courier (the deleted env-secrets.ts) delivered the real value at
// spawn. With that courier gone, those variables would silently stop reaching
// agents. ensureEnvSecretsInVault (settings/migrate-legacy.ts) copies each
// recoverable value into the user vault once and clears the dead sentinel
// rows from the file; this is its pure core.

/** Sentinel the legacy 🔒 flow wrote into `[env]` for a Keychain-backed
 *  value. Same literal as MCP_SECRET_SENTINEL (panels/mcp-panel-helpers.ts);
 *  inlined so this module stays free of panel imports. */
export const LEGACY_ENV_SECRET_SENTINEL = "${zeros.secret}";

/** The `[env]` names whose value is the legacy secret sentinel — the ones a
 *  legacy `env::<NAME>` Keychain account may hold a real value for. */
export function legacyEnvSecretNames(
  fileEnv: Record<string, unknown>,
): string[] {
  return Object.entries(fileEnv)
    .filter(([, v]) => v === LEGACY_ENV_SECRET_SENTINEL)
    .map(([k]) => k);
}

export interface LegacyEnvSecretPlan {
  /** Recovered values to merge into the user vault (only names the vault
   *  doesn't already hold — a retried run never clobbers newer edits). */
  copy: Record<string, string>;
  /** `[env]` keys to null out of the user file. Every sentinel row qualifies:
   *  spawn-env skips sentinel values, so the row delivers nothing whether or
   *  not its value was recovered — leaving it would keep implying delivery. */
  removeFromFile: string[];
  /** Names whose value couldn't be recovered (account missing/undecryptable)
   *  or that the vault refuses to store — surfaced so the user re-adds them. */
  unrecovered: string[];
}

export function planLegacyEnvSecretMigration(
  fileEnv: Record<string, unknown>,
  vault: Record<string, string>,
  legacyValues: Record<string, string | null>,
): LegacyEnvSecretPlan {
  const copy: Record<string, string> = {};
  const removeFromFile: string[] = [];
  const unrecovered: string[] = [];
  for (const name of legacyEnvSecretNames(fileEnv)) {
    removeFromFile.push(name);
    if (Object.prototype.hasOwnProperty.call(vault, name)) continue;
    const value = legacyValues[name];
    if (typeof value === "string" && !envVaultNameError(name)) {
      copy[name] = value;
    } else {
      unrecovered.push(name);
    }
  }
  return { copy, removeFromFile, unrecovered };
}

// ── Spawn-time composition — pure part exported for tests ─

/** User scope overlaid by repo scope (repo — more specific — wins), dangerous
 *  names dropped. This exact map rides the agent's caller env, UNDER provider
 *  and per-session env (which must always win). */
export function mergeEnvVaultScopes(
  userVars: Record<string, string>,
  repoVars: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...userVars, ...repoVars })) {
    if (typeof v !== "string" || envVaultNameError(k)) continue;
    out[k] = v;
  }
  return out;
}

/** The repo scope owning a cwd: the renderer projects cache first (covers the
 *  primary checkout, subdirectories, Zeros-managed worktrees via the path
 *  slug, and adopted foreign worktrees — synchronous, no bridge round-trip),
 *  then the bridge workspace list. Null → user-scope vars only. Exported for
 *  the MCP secret courier (mcp-secrets.ts), which needs the same mapping. */
export async function vaultRepoRootForCwd(
  bridge: RuntimeClient | null | undefined,
  cwd: string | null | undefined,
): Promise<string | null> {
  if (!cwd) return null;
  try {
    const project = findProjectForFolder(cwd, loadProjects());
    if (project) return project.repoRoot;
  } catch {
    /* fall through to the bridge list */
  }
  if (!bridge) return null;
  try {
    return await resolveBridgeRepoRootForCwd(bridge, cwd);
  } catch {
    return null;
  }
}

/** Resolve the vault vars to courier into an agent spawning in `cwd`: user
 *  scope + the owning repo's scope (repo wins), so every worktree of a repo
 *  receives the repo's vars. Best-effort — any failure degrades to fewer vars,
 *  never a failed spawn. */
export async function deriveEnvVaultEnv(
  bridge: RuntimeClient | null | undefined,
  cwd: string | null | undefined,
): Promise<Record<string, string>> {
  const userVars = await readEnvVault({ kind: "user" });
  const repoRoot = await vaultRepoRootForCwd(bridge, cwd);
  const repoVars = repoRoot
    ? await readEnvVault({ kind: "repo", repoRoot })
    : {};
  return mergeEnvVaultScopes(userVars, repoVars);
}
