// ──────────────────────────────────────────────────────────
// Renderer-side authentication session mirror (Electron only)
// ──────────────────────────────────────────────────────────
//
// The main process owns the full token pair
// (apps/desktop/electron/ipc/commands/auth-session.ts). This module is a thin,
// offline-tolerant mirror: it asks main for a live access token or signed-in
// identity and never sees a refresh token. It deliberately has no browser
// persistence fallback.
// ──────────────────────────────────────────────────────────

import { nativeInvoke } from "../../platform/runtime";

export type AuthUser = {
  sub: string;
  email: string;
  name: string | null;
  provider: "auth0" | "workos";
  accountId?: string;
  sessionId?: string;
  clientKind?: "desktop";
  authenticationMethod?: string | null;
};
export type AuthSessionInfo = { access_token: string; user: AuthUser };

type Listener = (session: AuthSessionInfo | null) => void;

const listeners = new Set<Listener>();

function notify(next: AuthSessionInfo | null): void {
  for (const l of listeners) l(next);
}

/** Restore the current session: a live access token (main refreshes first if
 *  it's near expiry) + decoded identity. Null on either call failing/absent —
 *  treated as signed-out, same as a getSession() cache-miss used to be. */
export async function getSession(): Promise<AuthSessionInfo | null> {
  // Token refresh can atomically update identity metadata. Read the user only
  // after main settles that refresh so both values describe one stored record.
  const tokenRes = await nativeInvoke<{ access_token: string | null }>(
    "auth_get_access_token",
  );
  if (!tokenRes?.access_token) return null;
  const user = await nativeInvoke<AuthUser | null>("auth_get_session_user");
  return tokenRes?.access_token && user
    ? { access_token: tokenRes.access_token, user }
    : null;
}

/** Subscribe to session changes (install / sign-out / cross-instance resync).
 *  Returns an unsubscribe function. */
export function onAuthStateChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reflect a freshly-redeemed session into the renderer mirror. Main already
 *  persisted the FULL token pair in the keychain inside auth_redeem_handoff — the
 *  renderer never receives (nor forwards) the refresh token, so this only mirrors
 *  the identity + short-lived access token and notifies subscribers. */
export function markSignedIn(info: {
  access_token: string;
  sub: string;
  email: string;
  name: string | null;
}): void {
  notify({
    access_token: info.access_token,
    user: {
      sub: info.sub,
      email: info.email,
      name: info.name,
      provider: "auth0",
    },
  });
}

export async function signOut(scope: "local" | "global"): Promise<void> {
  if (scope === "global") await nativeInvoke("auth_sign_out_everywhere");
  else await nativeInvoke("auth_clear_session");
  notify(null);
}

/** Re-probe main's stored session — used when "auth-store-changed" fires
 *  because a sibling dev worktree wrote to the shared secrets store. */
export async function resync(): Promise<AuthSessionInfo | null> {
  const session = await getSession();
  notify(session);
  return session;
}
