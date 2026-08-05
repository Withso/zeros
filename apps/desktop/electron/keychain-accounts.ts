// ──────────────────────────────────────────────────────────
// Renderer keychain access policy
// ──────────────────────────────────────────────────────────
//
// The generic keychain_* IPC bridge (apps/desktop/electron/ipc/commands/secrets.ts) lets the
// renderer read/write the OS keychain (safeStorage via secret-store.ts). Without
// a guard it can touch ANY account in the store — including main-only secrets
// (the GitHub OAuth token, and the Auth0 refresh token under "auth-session:" —
// apps/desktop/electron/ipc/commands/auth-session.ts — which the renderer never reads
// directly; it only ever gets a live access token or decoded identity claims
// back from that module's own dedicated auth_* commands). A renderer compromise
// (e.g. XSS in rendered agent / markdown content) could then enumerate and
// exfiltrate every secret if this bridge had no allowlist.
//
// So the bridge is allowlisted to exactly what the renderer legitimately owns:
//   • vendor API keys — the well-known SECRET_ACCOUNTS names, and
//   • per-agent / per-gateway auth under the `agent::` prefix (keychainFor()).
// Everything else — `github_oauth` (main-managed), `auth-session:*` (use the
// dedicated auth_* commands instead), and any future secret — is denied.
// Defense-in-depth on top of sandbox:true + contextIsolation +
// DevTools-closed-in-packaged.
// ──────────────────────────────────────────────────────────

/** Well-known vendor API-key accounts the renderer manages (Settings →
 *  Providers and the agent auth modal). MUST stay in sync with SECRET_ACCOUNTS
 *  in apps/desktop/src/renderer/platform/secrets.ts (the renderer source of truth; mirrored here because
 *  the main process can't import renderer modules). */
const VENDOR_ACCOUNTS = new Set<string>([
  "openai-api-key",
  "anthropic-api-key",
  "cursor-api-key",
  "factory-api-key",
]);

/** True if the renderer may read/write this keychain account through the
 *  generic keychain_* bridge. Per-agent / per-gateway keys are dynamic
 *  (keychainFor → `agent::<id>::<var>`), so they're matched by prefix. */
export function isRendererKeychainAccount(account: string): boolean {
  if (VENDOR_ACCOUNTS.has(account)) return true;
  if (account.startsWith("agent::")) return true;
  // MCP secret env vars (`mcp::<ENV_NAME>`) — the renderer stores these (Settings
  // → MCP) and couriers them into the agent's process env at spawn. Same dynamic-
  // prefix treatment as the per-agent keys above. See apps/desktop/src/renderer/features/agent/mcp-secrets.ts.
  if (account.startsWith("mcp::")) return true;
  // Environment vault (`envvault::user`, `envvault::repo::<root>`) — ALL
  // UI-managed env vars live here encrypted, one JSON map per scope; the
  // renderer stores them (Settings/repo page → Environment) and couriers them
  // into the agent's process env at spawn. See apps/desktop/src/renderer/features/agent/env-vault.ts.
  if (account.startsWith("envvault::")) return true;
  // LEGACY `env::<NAME>` — the pre-vault 🔒 flow's per-name secret values.
  // Nothing writes these anymore; the prefix stays allowlisted so the one-time
  // vault migration (apps/desktop/src/renderer/features/settings/migrate-legacy.ts,
  // ensureEnvSecretsInVault) can still READ them into `envvault::user`. The
  // accounts are kept (not deleted) after migration as a safety net.
  if (account.startsWith("env::")) return true;
  return false;
}
