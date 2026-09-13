import { getSetting, setSetting } from "../../platform/settings";
import type { ProviderPrefs } from "./provider-prefs";

export type ConnectionMethod = "account" | "cli" | "apiKey";
const ENTRY_KEY = "providers:subscription-entry:";

// Preserve auth="cli" / Cursor auth="subscription" serialization. This is a
// synchronous UI fallback until the native account store confirms its method.
// Native state selects isolated Account profiles versus the device CLI store.
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
  return prefs.authMethod === "apiKey"
    ? "Connected via API"
    : "Connected via subscription";
}
