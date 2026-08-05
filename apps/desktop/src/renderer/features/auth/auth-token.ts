// ──────────────────────────────────────────────────────────
// Synchronous access-token bridge (AuthProvider → relay transport)
// ──────────────────────────────────────────────────────────
//
// The relay client (ws-client.ts) must attach the current Auth0 access token to
// its CONNECTED frame so an account-binding engine can verify it — but the
// transport's send path is synchronous and lives below the React tree, so it
// can't await the main-process IPC round-trip. AuthProvider owns the session and
// pushes the latest access token here on every auth-state change (initial
// restore, sign-in, token refresh, sign-out); the transport reads it
// synchronously when it announces itself and on every reconnect.
//
// This is the user's OWN token riding INSIDE the already-E2EE relay channel — it
// is never exposed to the blind relay. It is intentionally NOT persisted here
// (main owns persistence via auth-session.ts); this is a live mirror only,
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
