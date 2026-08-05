// ──────────────────────────────────────────────────────────
// Invite-link plumbing for the team-accept flow.
//
// Three entry paths converge on one pending-token slot:
//   1. zeros://invite?token=…       (deep link; main forwards verbatim)
//   2. https://app.zeros.build/invite?token=…  (email link, pasted)
//   3. a bare token, pasted
// The token is held in-memory only (never persisted — it's a join
// credential) until SettingsPage consumes it into the Join-team
// dialog and calls the accept endpoint (works in the zero-team state,
// where no Administration panel exists to host a join box). ShellRouter
// installs the deep-link listener.
// ──────────────────────────────────────────────────────────

import { useEffect } from "react";
import { onDeepLink } from "../../platform/app";

/** Extract an invite token from a deep link, an https invite URL, or a
 *  bare pasted token. Returns null when `raw` is none of those. */
export function parseInviteToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Bare token: 32 bytes base64url = 43 chars of [A-Za-z0-9_-].
  if (/^[A-Za-z0-9_-]{43}$/.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const isInviteRoute =
    // zeros://invite?token=… / zeros-dev://invite?token=… → host "invite"
    (url.protocol.startsWith("zeros") && url.host === "invite") ||
    // https://app.zeros.build/invite?token=… — pinned to our own host so a
    // random webpage's HTTPS link does not parse as an invite.
    (url.protocol === "https:" &&
      url.host === "app.zeros.build" &&
      url.pathname.replace(/\/+$/, "").endsWith("/invite"));
  if (!isInviteRoute) return null;
  const token = url.searchParams.get("token");
  return token && /^[A-Za-z0-9_-]{20,200}$/.test(token) ? token : null;
}

// ── Pending-token slot (module singleton, in-memory only) ──

let pendingToken: string | null = null;
const listeners = new Set<() => void>();

export function setPendingInviteToken(token: string): void {
  pendingToken = token;
  for (const l of [...listeners]) l();
}

/** Read-and-clear: the join box consumes the token exactly once. */
export function consumePendingInviteToken(): string | null {
  const t = pendingToken;
  pendingToken = null;
  return t;
}

/** Drop any pending token without consuming it — called on sign-out so a
 *  deep-linked invite for account A can't bleed into account B's Join box. */
export function clearPendingInviteToken(): void {
  pendingToken = null;
}

export function subscribePendingInvite(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Installed ABOVE the AuthGate (always mounted): turns zeros://invite deep
 *  links into a pending token + a navigation intent. Mounting above the gate
 *  means a link arriving while signed OUT (or cold-launching the app) still
 *  captures the token — the Join box consumes it after sign-in — instead of
 *  being dropped because no listener existed yet. `onInvite`
 *  navigates to Settings → Team; harmless while signed out (the gate
 *  shows login) and the persisted section makes the post-sign-in mount land
 *  there. */
export function useInviteDeepLink(onInvite: () => void): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onDeepLink((url) => {
      const token = parseInviteToken(url);
      if (!token) return;
      setPendingInviteToken(token);
      onInvite();
    }).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
    // onInvite is stable-enough by contract (callers pass a useCallback);
    // re-subscribing on identity change is harmless either way.
  }, [onInvite]);
}
