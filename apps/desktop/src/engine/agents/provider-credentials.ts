import {
  providerCredentialsSchema,
  type ProviderCredentials,
} from "@zeros/protocol/provider-auth";

let credentials: ProviderCredentials | null = null;
/** Replaced atomically from the private parent pipe; never persisted, logged,
 * returned by inventory, or automatically projected into a cloud worker. */
export function seedProviderCredentials(value: unknown): boolean {
  const parsed = providerCredentialsSchema.safeParse(value);
  if (!parsed.success) return false;
  credentials = parsed.data;
  return true;
}
export function providerCredential(
  provider: string,
  auth: unknown,
  nowMs = Date.now(),
) {
  if (!["claude", "codex", "cursor"].includes(provider)) return null;
  const value =
    provider === "cursor" && auth === "subscription"
      ? credentials?.cursorSubscription
      : auth === "api-key" || (provider === "cursor" && auth !== "subscription")
        ? credentials?.[provider as "claude" | "codex" | "cursor"]
        : null;
  return value && (!value.expiresAtMs || value.expiresAtMs > nowMs)
    ? value
    : null;
}

/** Trusted host selection. Renderer env and repository configuration cannot
 * choose a different profile or read its credentials. */
export function providerAccountProfile(
  provider: string,
): {
  id: string;
  state: "connected" | "disconnected" | "expired";
  configDir?: string;
} | null {
  return provider === "claude" || provider === "codex" || provider === "cursor"
    ? (credentials?.accountProfiles?.[provider] ?? null)
    : null;
}
