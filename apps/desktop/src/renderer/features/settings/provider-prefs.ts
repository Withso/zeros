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
import { bridgeSettingsWrite } from "../../platform/bridge/workspace-bridge";

export type ProviderAuthMethod = "cli" | "apiKey";

export interface ProviderPrefs {
  /** "cli" = sign in via the vendor's own CLI; "apiKey" = inject the
   *  vendor's env var (ANTHROPIC_API_KEY / OPENAI_API_KEY) read from
   *  the keychain at spawn time. Defaults to "cli". */
  authMethod: ProviderAuthMethod;
  /** Optional absolute path or alternate command name for the CLI
   *  binary. Empty/undefined = use the registry default from $PATH. */
  binaryPath?: string;
  /** Claude-only: optional gateway base URL injected as
   *  ANTHROPIC_BASE_URL. Empty/undefined = direct to api.anthropic.com. */
  gatewayBaseUrl?: string;
}

const KEY_PREFIX = "provider-prefs:";

export const DEFAULT_PREFS: ProviderPrefs = {
  authMethod: "cli",
};

// Agents whose runtime is a bundled SDK (no user-installed CLI to sign
// into), so the provider API key is the ONE mandatory credential — there
// is no CLI-vs-API-key choice. Cursor (@cursor/sdk) is the first such
// agent. Consumed by the Providers panel (renders API-key-only, no
// toggle) and the runnable predicate (authenticated:false ⇒ no key ⇒ not
// ready), which must stay in lockstep.
const API_KEY_ONLY_AGENT_IDS = new Set<string>(["cursor"]);

/** True when the agent authenticates solely via its provider API key —
 *  a bundled-SDK runtime with no CLI sign-in path. */
export function isApiKeyOnly(agentId: string): boolean {
  return API_KEY_ONLY_AGENT_IDS.has(agentId);
}

export function getProviderPrefs(agentId: string): ProviderPrefs {
  // API-key-only agents (Cursor/@cursor/sdk) authenticate via their
  // provider key, so default them to API-key mode (the CLI/OAuth path is
  // a hidden fallback). Every other agent defaults to CLI sign-in.
  const fallback: ProviderPrefs = isApiKeyOnly(agentId)
    ? { authMethod: "apiKey" }
    : { ...DEFAULT_PREFS };
  const prefs = getSetting<ProviderPrefs>(KEY_PREFIX + agentId, fallback);
  // Coerce a stale persisted "cli" choice back to apiKey for API-key-only
  // agents — a leftover toggle from before they went key-only must not
  // withhold the env var the SDK needs at spawn (deriveProviderEnv only
  // injects it in apiKey mode).
  if (isApiKeyOnly(agentId) && prefs.authMethod !== "apiKey") {
    return { ...prefs, authMethod: "apiKey" };
  }
  return prefs;
}

export function setProviderPrefs(agentId: string, prefs: ProviderPrefs): void {
  setSetting(KEY_PREFIX + agentId, prefs);
  writeThroughToUserSettings(agentId, prefs);
}

/** Mirror provider choices into the engine-owned
 *  ~/.zeros/settings.toml ([providers.<agentId>]) so the user file is the
 *  durable record. localStorage stays the synchronous read cache. This is
 *  fire-and-forget — a
 *  missed mirror self-heals on the next save. */
function writeThroughToUserSettings(
  agentId: string,
  prefs: ProviderPrefs,
): void {
  const bridge = getActiveBridge();
  if (!bridge) return;
  const table = {
    auth: prefs.authMethod === "apiKey" ? "api-key" : "cli",
    executable_path: prefs.binaryPath?.trim() || null,
    base_url: prefs.gatewayBaseUrl?.trim() || null,
  };
  void bridgeSettingsWrite(bridge, "user", {
    providers: { [agentId]: table },
  }).catch(() => {
    /* best-effort mirror */
  });
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
  // Cursor authenticates via CURSOR_API_KEY (bills to the user's Cursor
  // plan). BOTH backends honour it: the @cursor/sdk reads it at spawn, and
  // the cursor-agent CLI (now the default) reads CURSOR_API_KEY directly
  // ("can also use CURSOR_API_KEY env var" per `cursor-agent --help`). So a
  // user who pasted an API key works on either backend with no re-login;
  // users who'd rather `cursor-agent login` just leave the key unset.
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
  if (config.gatewayBaseUrlVar && prefs.gatewayBaseUrl) {
    env[config.gatewayBaseUrlVar] = prefs.gatewayBaseUrl;
  }

  return env;
}

/** Convenience accessor for the saved CLI binary override. Returns
 *  undefined when the user hasn't customised it — caller falls back to
 *  the registry default (PATH lookup). */
export function getProviderBinaryOverride(agentId: string): string | undefined {
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
