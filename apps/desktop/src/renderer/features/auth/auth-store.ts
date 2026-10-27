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

import { isLocalDevelopment, nativeInvoke } from "../../platform/runtime";

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
const identityListeners = new Set<(user: AuthUser | null) => void>();
let storedUser: AuthUser | null | undefined;
let generation = 0;
let pendingSignOuts = 0;

/** Main-owned identity is enough to release presentation, never a bearer. */
export const getStoredAuthUser = () => storedUser;
export function onStoredIdentityChange(listener: (user: AuthUser | null) => void): () => void {
  identityListeners.add(listener);
  return () => { identityListeners.delete(listener); };
}

function publishIdentity(user: AuthUser | null): void {
  if (JSON.stringify(storedUser) === JSON.stringify(user)) return;
  const previousAccount = storedUser?.accountId ?? storedUser?.sub;
  const nextAccount = user?.accountId ?? user?.sub;
  // Retire the old bearer before the new identity releases account caches.
  if (user === null || storedUser !== undefined && previousAccount !== nextAccount) notify(null);
  storedUser = user;
  for (const listener of identityListeners) listener(user);
}

function notify(next: AuthSessionInfo | null): void {
  for (const l of listeners) l(next);
}

/** Restore the current session: a live access token (main refreshes first if
 *  it's near expiry) + decoded identity. An absent live token does not prove
 *  sign-out: main can retain identity through an offline refresh failure. */
export async function getSession(): Promise<AuthSessionInfo | null> {
  if (isLocalDevelopment() || storedUser === null || pendingSignOuts > 0) return null;
  const version = generation;
  // Token refresh can atomically update identity metadata. Read the user only
  // after main settles that refresh so both values describe one stored record.
  const tokenRes = await nativeInvoke<{ access_token: string | null }>(
    "auth_get_access_token",
  );
  if (version !== generation || !tokenRes?.access_token) return null;
  const user = await nativeInvoke<AuthUser | null>("auth_get_session_user");
  return version === generation && user
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
  generation++;
  const session: AuthSessionInfo = {
    access_token: info.access_token,
    user: {
      sub: info.sub,
      email: info.email,
      name: info.name,
      provider: "auth0",
    },
  };
  publishIdentity(session.user);
  notify(session);
}

export async function signOut(scope: "local" | "global"): Promise<void> {
  pendingSignOuts++;
  generation++;
  publishIdentity(null);
  try {
    if (scope === "global") await nativeInvoke("auth_sign_out_everywhere");
    else await nativeInvoke("auth_clear_session");
  } finally { pendingSignOuts--; }
}

/** Re-probe main's stored session — used when "auth-store-changed" fires
 *  because a sibling dev worktree wrote to the shared secrets store. */
export async function resync(): Promise<AuthSessionInfo | null> {
  if (isLocalDevelopment() || pendingSignOuts > 0) return null;
  const version = ++generation;
  try {
    const user = await nativeInvoke<AuthUser | null>("auth_get_session_user");
    if (version !== generation) return null;
    publishIdentity(user);
    const session = await getSession();
    if (version !== generation) return null;
    // Refresh may replace or explicitly revoke the stored record. Re-read after
    // a token miss so offline and sign-out remain different states.
    const confirmed = session?.user ?? await nativeInvoke<AuthUser | null>("auth_get_session_user");
    if (version !== generation) return null;
    publishIdentity(confirmed);
    notify(session);
    return session;
  } catch (error) {
    if (version === generation) notify(null);
    throw error;
  }
}
