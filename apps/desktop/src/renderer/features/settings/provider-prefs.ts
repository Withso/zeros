// ──────────────────────────────────────────────────────────
// Provider prefs — per-agent UI choices (auth method, binary
// path, gateway URL)
// ──────────────────────────────────────────────────────────
//
// Settings → Providers writes here; session spawn reads here.
// Backed by the same native settings layer as everything else
// (localStorage today, app-data on the Mac build).
//
// API keys themselves stay in the macOS keychain (apps/desktop/src/renderer/platform/
// secrets.ts) — only the user's *choice* of auth method and the
// optional path overrides live here.
// ──────────────────────────────────────────────────────────

import { getSetting, setSetting } from "../../platform/settings";
import { getSecret, SECRET_ACCOUNTS } from "../../platform/secrets";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import { providerAuthChanged } from "../../platform/provider-auth-state";
import {
  flushAgentPreferences,
  queueAgentPreferenceChanges,
} from "../../platform/agent-preferences";

export type ProviderAuthMethod = "cli" | "apiKey";

export interface ProviderPrefs {
  /** "cli" = sign in via the vendor's own CLI; "apiKey" = inject the
   *  vendor's env var (ANTHROPIC_API_KEY / OPENAI_API_KEY) read from
   *  the keychain at spawn time. Defaults to "cli". */
  authMethod: ProviderAuthMethod;
  /** Distinguishes explicit SDK browser login from Cursor's old ignored CLI choice. */
  cursorSubscription?: true;
  /** Optional absolute path or alternate command name for the CLI
   *  binary. Empty/undefined = use the registry default from $PATH. */
  binaryPath?: string;
  /** Claude-only: optional gateway base URL injected as
   *  ANTHROPIC_BASE_URL. Empty/undefined = direct to api.anthropic.com. */
  gatewayBaseUrl?: string;
}

const KEY_PREFIX = "provider-prefs:";
const listeners = new Set<() => void>();
const hydrated = new Map<string, ProviderPrefs>();
export function subscribeProviderPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function providerTable(prefs: ProviderPrefs, agentId: string) {
  return {
    auth:
      prefs.authMethod === "apiKey"
        ? "api-key"
        : agentId === "cursor"
          ? "subscription"
          : "cli",
    executable_path: prefs.binaryPath?.trim() || null,
    base_url: prefs.gatewayBaseUrl?.trim() || null,
  };
}
function providerIds(): string[] {
  const ids = new Set(["claude", "codex", "cursor", ...hydrated.keys()]);
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith("zeros-" + KEY_PREFIX))
        ids.add(key.slice(("zeros-" + KEY_PREFIX).length));
    }
  } catch {
    /* browser cache unavailable */
  }
  return [...ids].filter(
    (id) => !["__proto__", "prototype", "constructor"].includes(id),
  );
}
export function legacyProviderPreferences(): Record<string, unknown> {
  return Object.fromEntries(
    providerIds()
      .filter((id) => getSetting(KEY_PREFIX + id, null) !== null)
      .map((id) => [id, providerTable(getProviderPrefs(id), id)]),
  );
}
export function hydrateProviderPreferences(value: unknown): void {
  let authChanged = false;
  const providers =
    value && typeof value === "object"
      ? (value as Record<string, Record<string, unknown>>)
      : {};
  for (const id of new Set([...providerIds(), ...Object.keys(providers)])) {
    if (["__proto__", "prototype", "constructor"].includes(id)) continue;
    const cfg = providers[id];
    const prefs: ProviderPrefs = {
      authMethod: (
        id === "cursor" ? cfg?.auth !== "subscription" : cfg?.auth === "api-key"
      )
        ? "apiKey"
        : "cli",
      ...(id === "cursor" && cfg?.auth === "subscription"
        ? { cursorSubscription: true as const }
        : {}),
      ...(typeof cfg?.executable_path === "string"
        ? { binaryPath: cfg.executable_path }
        : {}),
      ...(typeof cfg?.base_url === "string"
        ? { gatewayBaseUrl: cfg.base_url }
        : {}),
    };
    const previous = getProviderPrefs(id);
    if (
      previous.authMethod !== prefs.authMethod ||
      previous.gatewayBaseUrl !== prefs.gatewayBaseUrl ||
      previous.binaryPath !== prefs.binaryPath
    )
      authChanged = true;
    hydrated.set(id, prefs);
    setSetting(KEY_PREFIX + id, prefs);
  }
  if (authChanged) providerAuthChanged();
  for (const listener of listeners) listener();
}

export const DEFAULT_PREFS: ProviderPrefs = {
  authMethod: "cli",
};

// Authentication UI capability, independent of whether a runtime is bundled.
// All current providers support an interactive account connection.
const API_KEY_ONLY_AGENT_IDS = new Set<string>();

/** True when the agent authenticates solely via its provider API key —
 *  a bundled-SDK runtime with no CLI sign-in path. */
export function isApiKeyOnly(agentId: string): boolean {
  return API_KEY_ONLY_AGENT_IDS.has(agentId);
}

export function getProviderPrefs(agentId: string): ProviderPrefs {
  // Preserve Cursor's pre-browser-login default for existing installations.
  const fallback: ProviderPrefs =
    agentId === "cursor" || isApiKeyOnly(agentId)
      ? { authMethod: "apiKey" }
      : { ...DEFAULT_PREFS };
  const prefs =
    hydrated.get(agentId) ??
    getSetting<ProviderPrefs>(KEY_PREFIX + agentId, fallback);
  // Old Cursor "cli" choices were ignored. Only the explicit new subscription
  // marker can switch those users away from their existing API key.
  if (
    (isApiKeyOnly(agentId) ||
      (agentId === "cursor" && !prefs.cursorSubscription)) &&
    prefs.authMethod !== "apiKey"
  ) {
    return { ...prefs, authMethod: "apiKey" };
  }
  return prefs;
}

export function setProviderPrefs(agentId: string, prefs: ProviderPrefs): void {
  const previous = getProviderPrefs(agentId);
  if (agentId === "cursor")
    prefs = {
      ...prefs,
      cursorSubscription: prefs.authMethod === "cli" ? true : undefined,
    };
  if (
    previous.authMethod !== prefs.authMethod ||
    previous.gatewayBaseUrl !== prefs.gatewayBaseUrl ||
    previous.binaryPath !== prefs.binaryPath
  )
    providerAuthChanged();
  hydrated.set(agentId, prefs);
  setSetting(KEY_PREFIX + agentId, prefs);
  queueAgentPreferenceChanges(
    { providers: { [agentId]: providerTable(prefs, agentId) } },
    { providers: { [agentId]: providerTable(previous, agentId) } },
  );
  for (const listener of listeners) listener();
}

// ──────────────────────────────────────────────────────────
// Spawn-time env derivation
// ──────────────────────────────────────────────────────────
//
// `deriveProviderEnv` reads the user's saved prefs + keychain and
// returns the env vars to inject when starting an agent subprocess.
//   - authMethod="apiKey" → inject ANTHROPIC_API_KEY / OPENAI_API_KEY
//     from the keychain.
//   - claude gatewayBaseUrl → inject ANTHROPIC_BASE_URL.
// Returns {} when no injection is required (CLI sign-in mode), so the
// caller can merge it into the spawn env unconditionally.
//
// This is the engine-side contract for the "same headless behaviour
// for CLI and API key" promise: the CLI subprocess always spawns the
// same way; the only difference is whether these env vars are present.

interface ProviderEnvConfig {
  envVar: string;
  secretAccount: string;
  gatewayBaseUrlVar?: string;
}

const PROVIDER_ENV_CONFIG: Record<string, ProviderEnvConfig> = {
  claude: {
    envVar: "ANTHROPIC_API_KEY",
    secretAccount: SECRET_ACCOUNTS.ANTHROPIC_API_KEY,
    gatewayBaseUrlVar: "ANTHROPIC_BASE_URL",
  },
  codex: {
    envVar: "OPENAI_API_KEY",
    secretAccount: SECRET_ACCOUNTS.OPENAI_API_KEY,
  },
  // Pasted-key mode only. The engine privately receives browser credentials
  // from main and selects them from user settings in subscription mode.
  cursor: {
    envVar: "CURSOR_API_KEY",
    secretAccount: SECRET_ACCOUNTS.CURSOR_API_KEY,
  },
};

/** The provider API keys Zeros can inject as env vars, for read-only display
 *  surfaces (Settings → Environment shows configured keys alongside the
 *  user's own variables, since they land in the agent's process env exactly
 *  the same way). Values stay in the encrypted secret store — this exposes
 *  only the env-var NAME and where to manage it. */
export const PROVIDER_KEY_ENV_VARS: ReadonlyArray<{
  agentId: string;
  vendor: string;
  envVar: string;
  secretAccount: string;
}> = [
  {
    agentId: "claude",
    vendor: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    secretAccount: SECRET_ACCOUNTS.ANTHROPIC_API_KEY,
  },
  {
    agentId: "codex",
    vendor: "OpenAI",
    envVar: "OPENAI_API_KEY",
    secretAccount: SECRET_ACCOUNTS.OPENAI_API_KEY,
  },
  {
    agentId: "cursor",
    vendor: "Cursor",
    envVar: "CURSOR_API_KEY",
    secretAccount: SECRET_ACCOUNTS.CURSOR_API_KEY,
  },
];

export async function deriveProviderEnv(
  agentId: string,
): Promise<Record<string, string>> {
  // Resolve auth from an acknowledged local file before reading credentials.
  if (getActiveBridge()?.executionIdentity?.kind === "local")
    await flushAgentPreferences();
  const prefs = getProviderPrefs(agentId);
  const config = PROVIDER_ENV_CONFIG[agentId];
  if (!config) return {};

  const env: Record<string, string> = {};
  if (prefs.authMethod === "apiKey") {
    try {
      const key = await getSecret(config.secretAccount);
      if (key) env[config.envVar] = key;
    } catch {
      /* keychain miss — leave unset; AuthModal will surface as fallback. */
    }
  }
  if (
    getActiveBridge()?.executionIdentity?.kind !== "local" &&
    config.gatewayBaseUrlVar &&
    prefs.gatewayBaseUrl
  ) {
    env[config.gatewayBaseUrlVar] = prefs.gatewayBaseUrl;
  }

  return env;
}

/** Convenience accessor for the saved CLI binary override. Returns
 *  undefined when the user hasn't customised it — caller falls back to
 *  the registry default (PATH lookup). */
export function getProviderBinaryOverride(agentId: string): string | undefined {
  // Local runtime configuration is read directly by the engine from TOML.
  // A removed override must not be resurrected by an older renderer cache.
  if (getActiveBridge()?.executionIdentity?.kind === "local") return undefined;
  const v = getProviderPrefs(agentId).binaryPath?.trim();
  return v ? v : undefined;
}

/** Does this agent support API-key auth? True when we know which env
 *  var to inject (PROVIDER_ENV_CONFIG entry exists). The runnable-agent
 *  predicate uses this to honour "Connected via API key" — without it,
 *  installed-but-not-CLI-signed-in agents are gated as "Sign in
 *  required" even though Providers panel shows them connected. */
export function supportsApiKey(agentId: string): boolean {
  return agentId in PROVIDER_ENV_CONFIG;
}
