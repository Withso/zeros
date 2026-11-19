import { getSetting, setSetting } from "../../platform/settings";
import type { ProviderPrefs } from "./provider-prefs";

export type ConnectionMethod = "account" | "cli" | "apiKey";
const ENTRY_KEY = "providers:subscription-entry:";

// Use identity from this connection only; API keys may not identify an account.
export function connectedAccountLabel(method: ConnectionMethod, identity?: string): string {
  const account = identity?.trim();
  return `${account || (method === "apiKey" ? "API key" : method === "cli" ? "CLI" : "Account")} is connected`;
}

// Account and CLI share auth="cli" (Cursor uses "subscription"); resolve this fallback until native state confirms the method.
export function connectionMethod(
  provider: string,
  prefs: ProviderPrefs,
): ConnectionMethod {
  if (prefs.authMethod === "apiKey") return "apiKey";
  if (provider === "cursor") return "account";
  return getSetting<string>(ENTRY_KEY + provider, "account") === "cli"
    ? "cli"
    : "account";
}
export function rememberConnectionMethod(
  provider: string,
  method: ConnectionMethod,
): void {
  if (method !== "apiKey") setSetting(ENTRY_KEY + provider, method);
}
export function connectionLabel(
  connected: boolean,
  prefs: ProviderPrefs,
  name = "agent",
  method?: ConnectionMethod,
): string {
  if (!connected) return `Configure ${name}`;
  if (prefs.gatewayBaseUrl) {
    try {
      const host = new URL(prefs.gatewayBaseUrl).hostname;
      if (host === "ai-gateway.vercel.sh")
        return "Connected via Vercel Gateway";
      return `Connected via ${host}`;
    } catch {
      /* Legacy invalid URL: keep the configured auth label. */
    }
  }
  if (method === "cli") return "Connected via CLI";
  return prefs.authMethod === "apiKey"
    ? "Connected via API"
    : "Connected via subscription";
}
