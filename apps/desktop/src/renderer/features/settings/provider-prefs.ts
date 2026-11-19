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
  authMethod: ProviderAuthMethod;
  /** Distinguishes explicit SDK browser login from Cursor's old ignored CLI choice. */
  cursorSubscription?: true;
  binaryPath?: string;
  gatewayBaseUrl?: string;
}

// Preserve this persisted preference prefix; API key values live in the keychain.
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

// Account sign-in capability is independent of whether a runtime is bundled.
const API_KEY_ONLY_AGENT_IDS = new Set<string>();

export function isApiKeyOnly(agentId: string): boolean {
  return API_KEY_ONLY_AGENT_IDS.has(agentId);
}

export function getProviderPrefs(agentId: string): ProviderPrefs {
  const fallback: ProviderPrefs =
    agentId === "cursor" || isApiKeyOnly(agentId)
      ? { authMethod: "apiKey" }
      : { ...DEFAULT_PREFS };
  const prefs =
    hydrated.get(agentId) ??
    getSetting<ProviderPrefs>(KEY_PREFIX + agentId, fallback);
  // Legacy Cursor CLI choices were ignored; only explicit subscription opt-in replaces API-key auth.
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
  // Electron main sends subscription credentials to the engine's private stdin, not through the renderer.
  cursor: {
    envVar: "CURSOR_API_KEY",
    secretAccount: SECRET_ACCOUNTS.CURSOR_API_KEY,
  },
};

// The display gets variable names and keychain slots, not key values.
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

export function getProviderBinaryOverride(agentId: string): string | undefined {
  // Let the local engine read TOML so stale renderer state cannot restore a removed override.
  if (getActiveBridge()?.executionIdentity?.kind === "local") return undefined;
  const v = getProviderPrefs(agentId).binaryPath?.trim();
  return v ? v : undefined;
}

export function supportsApiKey(agentId: string): boolean {
  return agentId in PROVIDER_ENV_CONFIG;
}
