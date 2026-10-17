// ──────────────────────────────────────────────────────────
// User provider config → spawn fallback
// ──────────────────────────────────────────────────────────
//
// Provider config (gateway `base_url` + `executable_path`) is USER-only: the
// machine owner sets it in `~/.zeros/settings.toml` `[providers.<agent>]`, and
// the renderer normally couriers it into the spawn from its localStorage cache
// (deriveProviderEnv → env, getProviderBinaryOverride → cliBinary).
//
// But a HEADLESS / relay / cron spawn has no renderer and no localStorage, so
// those couriered values are absent. This module makes the resolved USER
// settings the authoritative FALLBACK: it fills only the gaps, layered UNDER
// whatever the caller already set for executable/gateway configuration. In the
// normal desktop path the TOML mirror holds the same values, so this is a no-op.
//
// SECURITY — `providers` is a USER-ONLY settings key (schema USER_ONLY_KEYS), so
// the sanitizer drops it from every repo-scoped layer (repo / repo-local /
// workspace-local). `effective.providers` can therefore only be sourced from the
// trusted user / managed layers — a committed, clone-borne repo `base_url` can
// never reach here (the credential-redirect vector the old per-repo path had to
// guard against simply doesn't exist now). We still verify the source layer as
// defense-in-depth, and existence-check `executable_path` so a stale entry
// degrades to the default resolution instead of failing the spawn.
//
// Electron supplies an in-memory credential projection over the private parent
// pipe. Its explicit selection overrides stale per-checkout user auth settings
// and couriered credentials; managed policy keeps precedence. This applies to headless work
// as well as interactive spawns; it never opens the encrypted store itself.
// ──────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import path from "node:path";
import { opSettingsResolve } from "./ops";
import {
  providerCredential,
  providerAccountProfile,
  providerAuthenticationMethod,
} from "../agents/provider-credentials";

/** agentId → the env var its gateway base_url maps to. Mirror of the renderer's
 *  PROVIDER_ENV_CONFIG[*].gatewayBaseUrlVar (provider-prefs.ts). Today only
 *  Claude has a gateway env var; the rest authenticate by API key. */
const GATEWAY_ENV_VAR: Record<string, string> = {
  claude: "ANTHROPIC_BASE_URL",
};

/** Layers trusted to source provider config. `providers` is user-only, so this
 *  is belt-and-suspenders over the schema's USER_ONLY_KEYS guard. */
const TRUSTED_PROVIDER_LAYERS: readonly string[] = ["user", "managed"];

export interface ProviderSpawn {
  env?: Record<string, string>;
  cliBinary?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function selectedAuthentication(agentId: string, configured: unknown, source: string | undefined) {
  const method = source !== "managed" ? providerAuthenticationMethod(agentId) : undefined;
  return {
    native: method !== undefined,
    auth: method
      ? method === "apiKey" ? "api-key" : agentId === "cursor" ? "subscription" : "cli"
      : source && TRUSTED_PROVIDER_LAYERS.includes(source) ? configured : undefined,
  };
}

/** Registry probes must inspect the selected method, just like a spawn. A
 * repository cannot select a personal credential or influence this verdict. */
export function usesProviderApiKey(cwd: string, agentId: string): boolean {
  try {
    const resolved = opSettingsResolve(cwd);
    const source = resolved.sources[`providers.${agentId}.auth`];
    const providers = resolved.effective.providers;
    const configured = isPlainObject(providers) && isPlainObject(providers[agentId])
      ? providers[agentId].auth : undefined;
    return selectedAuthentication(agentId, configured, source).auth === "api-key";
  } catch {
    return false;
  }
}

/** Apply native authentication selection and fill other spawn gaps from the
 * user's resolved `[providers.<agentId>]` settings —
 *  the durable TOML fallback for spawns the renderer didn't courier (headless /
 *  relay / cron). Applied UNDER `base`: a value the caller already set wins; the
 *  TOML only fills what's missing. Never throws — on any failure `base` is
 *  returned unchanged (byte-identical spawn). */
export function applyUserProviderConfig(
  cwd: string,
  agentId: string,
  base: ProviderSpawn,
  mainRepoRoot?: string,
): ProviderSpawn {
  if (!agentId) return base;

  let resolved;
  try {
    resolved = opSettingsResolve(cwd, mainRepoRoot);
  } catch {
    return base;
  }

  const providers = resolved.effective.providers;
  const cfg =
    isPlainObject(providers) && isPlainObject(providers[agentId])
      ? providers[agentId]
      : {};

  const trusted = (leaf: string): boolean => {
    const s = resolved.sources[leaf];
    return s !== undefined && TRUSTED_PROVIDER_LAYERS.includes(s);
  };

  const env = { ...(base.env ?? {}) };
  const selection = selectedAuthentication(agentId, cfg.auth, resolved.sources[`providers.${agentId}.auth`]);
  const profile = selection.auth !== "api-key"
    ? providerAccountProfile(agentId)
    : null;
  // Account profiles are an explicit exception to ambient config pass-through.
  // This happens AFTER the untrusted spawn/env merge; only the private host
  // pipe can choose the root. CLI/API keep their existing native roots.
  if (
    profile &&
    "configDir" in profile &&
    typeof profile.configDir === "string" &&
    profile.configDir
  ) {
    env[agentId === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] =
      profile.configDir;
  }
  let cliBinary = base.cliBinary;

  const credential = providerCredential(
    agentId,
    selection.auth,
  );
  const keyVar = (
    {
      claude: "ANTHROPIC_API_KEY",
      codex: "OPENAI_API_KEY",
      cursor: "CURSOR_API_KEY",
    } as Record<string, string>
  )[agentId];
  if (
    agentId !== "cursor" &&
    keyVar &&
    selection.auth === "cli"
  ) {
    env[keyVar] = "";
    if (agentId === "claude") {
      env.ANTHROPIC_AUTH_TOKEN = "";
      env.CLAUDE_CODE_OAUTH_TOKEN = "";
    }
  } else if (
    agentId === "cursor" &&
    selection.auth === "subscription"
  ) {
    // An explicit subscription choice must not silently fall back to an
    // inherited API key after sign-out or expiry.
    env.CURSOR_API_KEY = credential?.apiKey ?? "";
  } else if (keyVar && selection.native && selection.auth === "api-key") {
    // A stale renderer or inherited shell key cannot replace the selected
    // native key, including after its explicit removal.
    env[keyVar] = credential?.apiKey ?? "";
    if (agentId === "claude") {
      env.ANTHROPIC_AUTH_TOKEN = "";
      env.CLAUDE_CODE_OAUTH_TOKEN = "";
    }
  } else if (keyVar && !env[keyVar] && credential)
    env[keyVar] = credential.apiKey;

  // base_url → gateway env var (claude → ANTHROPIC_BASE_URL). Fallback only:
  // skip when the caller already couriered it (couriered value wins).
  const gatewayVar = GATEWAY_ENV_VAR[agentId];
  const baseUrl = cfg.base_url;
  if (
    gatewayVar &&
    !env[gatewayVar] &&
    typeof baseUrl === "string" &&
    baseUrl.trim() &&
    trusted(`providers.${agentId}.base_url`)
  ) {
    env[gatewayVar] = baseUrl.trim();
  }

  // executable_path → cliBinary. Fallback only; honor an ABSOLUTE path that
  // EXISTS so a stale entry degrades to the default resolution.
  const exe = cfg.executable_path;
  if (
    !cliBinary &&
    typeof exe === "string" &&
    exe.trim() &&
    trusted(`providers.${agentId}.executable_path`)
  ) {
    const p = exe.trim();
    if (path.isAbsolute(p) && existsSync(p)) cliBinary = p;
  }

  return { env, cliBinary };
}
