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
// whatever the caller already set — a couriered value ALWAYS wins. In the
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
// Secrets (API keys) are NOT handled here — those stay couriered from the
// Keychain by the renderer's deriveProviderEnv; this module never reads secrets.
// ──────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import path from "node:path";
import { opSettingsResolve } from "./ops";

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

/** Fill spawn gaps from the user's resolved `[providers.<agentId>]` settings —
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
  if (!isPlainObject(providers)) return base;
  const cfg = providers[agentId];
  if (!isPlainObject(cfg)) return base;

  const trusted = (leaf: string): boolean => {
    const s = resolved.sources[leaf];
    return s !== undefined && TRUSTED_PROVIDER_LAYERS.includes(s);
  };

  const env = { ...(base.env ?? {}) };
  let cliBinary = base.cliBinary;

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
