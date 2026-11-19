
import { existsSync } from "node:fs";
import path from "node:path";
import { opSettingsResolve } from "./ops";
import { CODEX_AUTH_ENV } from "../agents/adapters/shared/provider-connection";
import {
  providerCredential,
  providerAccountProfile,
  providerAuthenticationMethod,
} from "../agents/provider-credentials";

/** Keep the Claude gateway variable in sync with the renderer's provider preferences. */
const GATEWAY_ENV_VAR: Record<string, string> = {
  claude: "ANTHROPIC_BASE_URL",
};

/** Recheck provenance so repository settings cannot redirect credentials or select an executable. */
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

/** Registry probes must use the same trusted auth selection as spawns. */
export function providerAuthMode(
  cwd: string,
  agentId: string,
): "api-key" | "cli" | "subscription" | undefined {
  try {
    const resolved = opSettingsResolve(cwd);
    const source = resolved.sources[`providers.${agentId}.auth`];
    const providers = resolved.effective.providers;
    const configured = isPlainObject(providers) && isPlainObject(providers[agentId])
      ? providers[agentId].auth : undefined;
    const auth = selectedAuthentication(agentId, configured, source).auth;
    return auth === "api-key" || auth === "cli" || auth === "subscription"
      ? auth
      : undefined;
  } catch {
    return undefined;
  }
}

export function usesProviderApiKey(cwd: string, agentId: string): boolean {
  return providerAuthMode(cwd, agentId) === "api-key";
}

/** Headless spawns lack renderer config, so trusted TOML fills routing and binary gaps. Managed auth policy overrides the in-memory selection from the private host pipe. */
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
  // Only the private host selection can set an account profile root after the caller environment is merged.
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
    // A subscription choice must not fall back to an inherited key after sign-out or expiry.
    env.CURSOR_API_KEY = credential?.apiKey ?? "";
  } else if (keyVar && selection.native && selection.auth === "api-key") {
    // A renderer or shell key cannot replace the selected native key, even after that key is removed.
    env[keyVar] = credential?.apiKey ?? "";
    if (agentId === "claude") {
      env.ANTHROPIC_AUTH_TOKEN = "";
      env.CLAUDE_CODE_OAUTH_TOKEN = "";
    }
  } else if (keyVar && !env[keyVar] && credential)
    env[keyVar] = credential.apiKey;
  // Codex app-server needs an explicit login; only this projection can signal the selected API-key mode.
  if (agentId === "codex") {
    if (selection.auth === "api-key") env[CODEX_AUTH_ENV] = "api-key";
    else delete env[CODEX_AUTH_ENV];
  }

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

  // Ignore stale executable paths so the default binary can still resolve.
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
