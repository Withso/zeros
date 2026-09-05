// ──────────────────────────────────────────────────────────
// Synchronous access-token bridge (AuthProvider → local engine binding)
// ──────────────────────────────────────────────────────────
//
// The local sidecar client (ws-client.ts) attaches the current access token to
// its CONNECTED frame so the engine can bind itself to the signed-in Zeros
// account. The send path is synchronous and lives below the React tree, so it
// cannot await an Electron-main round trip. AuthProvider owns the session and
// pushes the latest token here on restore, sign-in, refresh, and sign-out.
//
// Cloud engines never receive this reusable WorkOS bearer: their WebSocket is
// bound by a one-use control-plane admission. The value is intentionally not
// persisted here (Electron main owns persistence); this is a live mirror only,
// cleared on sign-out.
// ──────────────────────────────────────────────────────────

let currentAccessToken: string | null = null;

/** AuthProvider calls this on every auth-state change (null on sign-out). */
export function setAuthAccessToken(token: string | null | undefined): void {
  currentAccessToken = token || null;
}

/** Transport reads the live access token when building/refreshing CONNECTED. */
export function getAuthAccessToken(): string | null {
  return currentAccessToken;
}
