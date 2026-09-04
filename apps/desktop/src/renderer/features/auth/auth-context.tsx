// ──────────────────────────────────────────────────────────
// Top-level auth provider for the Zeros desktop app
// ──────────────────────────────────────────────────────────
//
// The main process owns the full authentication token pair
// (apps/desktop/electron/ipc/commands/auth-session.ts); this provider is a thin,
// offline-tolerant mirror over IPC. It never sees a refresh token and has no
// browser persistence fallback.
//
// Lifecycle notes:
//   • getSession() on mount restores instantly from main's cache — no network
//     call unless the cached access token is near expiry, in which case main
//     refreshes transparently before answering.
//   • onAuthStateChange keeps React state in sync with auth-store's notify().
//   • Offline tolerance: a transient refresh network failure returns the STALE
//     access token from main's cache attempt only if still valid; a genuinely
//     dead refresh token clears main's stored session — same "only sign out on
//     an explicitly invalid token, never on a network blip" contract as before.
// ──────────────────────────────────────────────────────────

import React, {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  getSession,
  onAuthStateChange,
  resync,
  markSignedIn,
  signOut as storeSignOut,
  type AuthSessionInfo,
} from "./auth-store";
import { setAuthAccessToken } from "./auth-token";
import { isElectron, nativeInvoke, nativeListen } from "../../platform/runtime";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import { CHANNEL } from "../../config/release-channel";
import { useDismissStartupLoader } from "../../shared/ui/startup-loader";
import {
  safeBrowserSignInStartError,
  workOSSignInFailureMessage,
} from "./auth-errors";
import {
  schemeForChannel,
  type Channel,
  type DeepLinkScheme,
} from "../../../engine/runtime";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export interface AuthResult {
  ok: boolean;
  /** User-facing message when `ok` is false. */
  error?: string;
  /** Main-owned deadline for the pending browser ceremony. Presentation only;
   *  Electron main remains the authority that rejects an expired callback. */
  expiresAt?: number;
}

export interface AuthContextValue {
  /** "loading" until the first getSession() resolves. */
  status: AuthStatus;
  session: AuthSessionInfo | null;
  userId: string | null;
  email: string | null;
  /** Open the system browser. WorkOS PKCE/callback state lives entirely in
   *  Electron main; Auth0 retains the legacy web-ticket path until Phase 5. */
  startBrowserSignIn: () => Promise<AuthResult>;
  /** A LATER async failure of the desktop OAuth browser handoff (the browser
   *  round-trip completed but the returning deep link couldn't be redeemed), so
   *  the LoginScreen can show it instead of hanging on the "continue in your
   *  browser" hint. Null when there's no pending OAuth error. */
  oauthError: string | null;
  /** Dismiss the current oauthError (e.g. the user starts a different sign-in). */
  clearOAuthError: () => void;
  /** Abort a pending desktop OAuth handoff: invalidate the one-time nonce so a
   *  deep link arriving AFTER the user cancelled can't silently sign them in,
   *  and clear any pending error. Used by the LoginScreen's "Cancel" affordance
   *  on the "waiting for browser sign-in" state. */
  cancelPendingOAuth: () => void;
  /** Clear the session on THIS device (keychain + memory; web also unpairs). */
  signOut: () => Promise<void>;
  /** Revoke the account's sessions on ALL devices (global scope) — the recovery
   *  action for a suspected session/token compromise. */
  signOutEverywhere: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  if (!isElectron()) return <AuthConfigErrorScreen />;
  return <AuthProviderInner>{children}</AuthProviderInner>;
}

function AuthProviderInner({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [session, setSession] = useState<AuthSessionInfo | null>(null);
  // A LATER, asynchronous failure of the browser→desktop handoff: the browser
  // round-trip finished but the returning deep-link ticket couldn't be redeemed
  // (our nonce expired, or the redeem call failed). Surfaced to the LoginScreen so
  // a failed sign-in shows a real error instead of hanging on the "continue in
  // your browser" hint forever. Null when there's nothing wrong.
  const [oauthError, setOAuthError] = useState<string | null>(null);
  // Nonce + expiry binding the OAuth deep-link handoff to THIS app instance — a
  // leaked/unsolicited zeros://auth/callback can't be redeemed by another
  // instance, and the 5-min expiry caps the replay window for a nonce that
  // leaked via the browser URL.
  const pendingNonceRef = useRef<{ value: string; expiresAt: number } | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    let offHandoff: (() => void) | undefined;
    let offStoreChanged: (() => void) | undefined;
    let offWorkOSComplete: (() => void) | undefined;
    let offWorkOSError: (() => void) | undefined;
    let offSecurityRevoked: (() => void) | undefined;

    const apply = (next: AuthSessionInfo | null) => {
      if (!active) return;
      setSession(next);
      setStatus(next ? "authenticated" : "unauthenticated");
      // Mirror the live access token to the relay transport (web account-binding
      // reads it synchronously when announcing CONNECTED). Cleared on sign-out.
      setAuthAccessToken(next?.access_token ?? null);
    };

    getSession()
      .then(apply)
      .catch((err) => {
        console.warn("[auth] getSession failed:", (err as Error)?.message);
        if (active) setStatus("unauthenticated");
      });

    const offStateChange = onAuthStateChange((next) => apply(next));

    // Desktop OAuth handoff: main forwards the result of the browser sign-in
    // from the zeros://auth/callback deep link → redeem the ticket for our own
    // session (the desktop holds the PKCE verifier in its keychain — the
    // browser never had it).
    void nativeListen<{ ticket?: string; nonce?: string }>(
      "auth-handoff",
      async ({ ticket, nonce }) => {
        if (!active || !ticket) return;
        // Fail CLOSED: only redeem a handoff that ONE OF OUR instances started.
        // Two match sources, because dev worktrees share ONE login but all
        // register the SAME zeros-dev:// scheme, so macOS hands the returning
        // callback to a single instance — NOT necessarily the initiator:
        //   • LOCAL  — this instance's own pendingNonce (in-memory ref, else the
        //     persisted copy that survives a renderer reload / cold launch by
        //     the deep link). This is the initiator's own completion.
        //   • SHARED — the pending handoff in main's keychain (auth_peek_handoff),
        //     which a SIBLING worktree wrote via auth_begin_handoff. Lets the
        //     instance the OS happened to pick finish a sign-in another worktree
        //     began; the initiator then picks up the session from the shared
        //     store (see the auth-store-changed listener below).
        // A nonce matching NEITHER is unsolicited/foreign (CSRF, cold-launch
        // noise) and is rejected — blocking login-CSRF / session-fixation via a
        // planted deep link. The verifier never leaves main, so peek is safe.
        const localPending = pendingNonceRef.current ?? readPendingNonce();
        let sharedPending: { value: string; expiresAt: number } | null = null;
        try {
          const peek = await nativeInvoke<{
            nonce?: string | null;
            expiresAt?: number | null;
          }>("auth_peek_handoff");
          if (peek?.nonce) {
            sharedPending = {
              value: peek.nonce,
              expiresAt:
                typeof peek.expiresAt === "number"
                  ? peek.expiresAt
                  : Date.now() + 60_000,
            };
          }
        } catch {
          /* peek unavailable — fall back to the local pending nonce only */
        }
        const matchedLocal = Boolean(
          localPending && nonce && localPending.value === nonce,
        );
        const matchedShared = Boolean(
          sharedPending && nonce && sharedPending.value === nonce,
        );
        const matched = matchedLocal
          ? localPending
          : matchedShared
            ? sharedPending
            : null;
        if (!matched || Date.now() > matched.expiresAt) {
          // Classify for ops logs without leaking which case to the user.
          const why = !(localPending || sharedPending)
            ? "no pending handoff"
            : !nonce
              ? "missing nonce"
              : !matched
                ? "nonce mismatch"
                : "nonce expired";
          console.warn(`[auth] sign-in handoff rejected — ${why}`);
          // Surface the "expired" retry hint ONLY on the INITIATING instance (a
          // local match) — a legit slow sign-in the user should retry. A sibling
          // that merely received a shared handoff, and any missing/mismatched
          // nonce (unsolicited / foreign deep link), stays SILENT — showing UI
          // for a planted link would itself be a vector.
          if (matchedLocal) {
            pendingNonceRef.current = null;
            clearPendingNonce();
            setOAuthError(
              "That browser sign-in expired before it finished. Click Sign in to try again.",
            );
          }
          return;
        }
        pendingNonceRef.current = null;
        clearPendingNonce();
        // Redeem the OPAQUE ticket in the MAIN process (it holds the PKCE
        // verifier). Main persists the token pair into the keychain itself and
        // returns ONLY the access token + identity — the refresh token never
        // enters this renderer heap. The browser never held our session:
        // only the single-use ticket crossed zeros://, worthless without the
        // verifier.
        const redeemed = await nativeInvoke<{
          access_token?: string;
          sub?: string;
          email?: string;
          name?: string | null;
          error?: string;
        }>("auth_redeem_handoff", { ticket, nonce });
        if (!redeemed?.access_token || !redeemed?.sub || !redeemed?.email) {
          console.warn(
            `[auth] sign-in handoff redeem failed: ${redeemed?.error ?? "unknown"}`,
          );
          setOAuthError(workOSSignInFailureMessage("exchange_failed", null));
          return;
        }
        // Main already wrote the session; just mirror it into renderer state.
        markSignedIn({
          access_token: redeemed.access_token,
          sub: redeemed.sub,
          email: redeemed.email,
          name: redeemed.name ?? null,
        });
        setOAuthError(null);
        // Success → onAuthStateChange (via markSignedIn's notify) flips the gate.
      },
    ).then((off) => {
      if (active) offHandoff = off;
      else off();
    });

    // Live cross-instance session propagation. All dev worktrees share ONE
    // secrets.json, but this store only reads it via IPC on demand — so a
    // sign-in/sign-out in ANOTHER worktree stayed invisible here until a reload
    // (the bug this fixes). Main watches the shared store and fires
    // "auth-store-changed"; we re-probe (main is the source of truth either way,
    // so a single resync() covers both "signed out here, did a sibling sign in"
    // and "signed in here, did a sibling sign out or rotate tokens").
    void nativeListen("auth-store-changed", async () => {
      if (!active) return;
      try {
        await resync();
      } catch (err) {
        console.warn(
          "[auth] store-change resync failed:",
          (err as Error)?.message,
        );
      }
    }).then((off) => {
      if (active) offStoreChanged = off;
      else off();
    });

    // WorkOS completion carries no OAuth artifact. Main has already verified
    // and stored the session; renderer only re-reads its bounded mirror.
    void nativeListen("auth-signin-complete", async () => {
      if (!active) return;
      pendingNonceRef.current = null;
      clearPendingNonce();
      try {
        const next = await resync();
        if (!next) throw new Error("session unavailable");
        setOAuthError(null);
      } catch {
        setOAuthError(workOSSignInFailureMessage("exchange_failed", null));
      }
    }).then((off) => {
      if (active) offWorkOSComplete = off;
      else off();
    });

    void nativeListen<{ reason?: string; recoveryCode?: string }>(
      "auth-signin-error",
      ({ reason, recoveryCode }) => {
        if (!active) return;
        console.warn("[auth] WorkOS sign-in failed:", reason ?? "unknown");
        setOAuthError(workOSSignInFailureMessage(reason ?? "", recoveryCode));
      },
    ).then((off) => {
      if (active) offWorkOSError = off;
      else off();
    });

    void nativeListen<{ reason?: string }>(
      "auth-security-revoked",
      async ({ reason }) => {
        if (!active) return;
        try {
          getActiveBridge()?.signalOwnerSignedOut();
        } catch {
          /* bridge already unavailable */
        }
        await resync().catch(() => null);
        if (!active) return;
        setOAuthError(
          reason === "account.revoked" || reason === "account_deleted"
            ? "Your Zeros account is no longer active. Sign in again only if access has been restored."
            : "This session is no longer active. Sign in again to continue.",
        );
      },
    ).then((off) => {
      if (active) offSecurityRevoked = off;
      else off();
    });

    const onOnline = () => {
      void nativeInvoke("auth_security_revalidate").catch(() => undefined);
    };
    window.addEventListener("online", onOnline);

    return () => {
      active = false;
      offStateChange();
      offHandoff?.();
      offStoreChanged?.();
      offWorkOSComplete?.();
      offWorkOSError?.();
      offSecurityRevoked?.();
      window.removeEventListener("online", onOnline);
    };
  }, []);

  const startBrowserSignIn = useCallback(async (): Promise<AuthResult> => {
    // Clear any stale handoff error from a prior attempt before starting fresh.
    setOAuthError(null);
    try {
      // In WorkOS mode this command opens the hosted Zeros provider page and
      // retains state + verifier in Electron main, outside renderer JS. Auth0
      // mode returns a compatibility marker and continues below.
      const selected = await nativeInvoke<{
        mode?: "auth0" | "workos" | "unconfigured";
        expiresAt?: number;
      }>("auth_start_signin");
      if (selected?.mode === "unconfigured") {
        return {
          ok: false,
          error:
            "Zeros Dev sign-in is not configured for Alpha WorkOS. Add the shared Alpha development auth profile and restart Zeros Dev.",
        };
      }
      if (selected?.mode === "workos") {
        return {
          ok: true,
          expiresAt:
            typeof selected.expiresAt === "number" &&
            Number.isFinite(selected.expiresAt)
              ? selected.expiresAt
              : undefined,
        };
      }
      if (selected?.mode !== "auth0") {
        return { ok: false, error: "Couldn't start sign-in." };
      }

      // One-time nonce: the auth-handoff listener fails CLOSED on a missing/
      // mismatched nonce (blocks login-CSRF via a planted deep link). Persisted so
      // a renderer reload / cold launch BY the deep link still matches; valid
      // 10 min for a slow first-time consent / 2FA.
      const nonce =
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const expiresAt = Date.now() + 10 * 60_000;
      pendingNonceRef.current = { value: nonce, expiresAt };
      savePendingNonce(nonce, expiresAt);

      // The web hub owns all OAuth. Desktop + prod default to the deployed
      // origin; VITE_APP_BASE_URL overrides for local / preview iteration.
      const base = (
        (import.meta.env.VITE_APP_BASE_URL as string | undefined) ||
        "https://app.zeros.build"
      ).replace(/\/+$/, "");

      // The MAIN process mints the PKCE verifier (kept in safeStorage) and
      // returns ONLY its S256 challenge — the renderer never sees the verifier.
      // /handoff/mint binds the issued ticket to this challenge, so the opaque
      // ticket that returns over zeros:// is useless to anyone without the
      // verifier (handoff-PKCE).
      const begin = await nativeInvoke<{ challenge?: string }>(
        "auth_begin_handoff",
        {
          nonce,
          // Persist the SAME expiry in main's shared pending record so a sibling
          // worktree that completes this handoff enforces the identical window.
          expiresAt,
        },
      );
      if (!begin?.challenge)
        return { ok: false, error: "Couldn't start sign-in." };
      // stable = zeros://, beta = zeros-beta://, dev = zeros-dev:// — /launch
      // builds the returning deep link from this scheme, so the OS routes it back
      // to the SAME app (channel) that started the sign-in, never a sibling.
      const scheme = await resolveDesktopScheme();
      const url =
        `${base}/launch` +
        `?scheme=${encodeURIComponent(scheme)}` +
        `&nonce=${encodeURIComponent(nonce)}` +
        `&challenge=${encodeURIComponent(begin.challenge)}`;
      await nativeInvoke("shell_open_url", { url });
      return { ok: true, expiresAt };
    } catch (err) {
      return {
        ok: false,
        error: safeBrowserSignInStartError(err),
      };
    }
  }, []);

  const cancelPendingOAuth = useCallback(() => {
    // Invalidate the one-time nonce so a deep link arriving after cancel can't
    // redeem (the handoff listener fails closed on a missing pending nonce).
    pendingNonceRef.current = null;
    clearPendingNonce();
    setOAuthError(null);
    void nativeInvoke("auth_cancel_signin").catch(() => undefined);
  }, []);

  // Shared local teardown for both sign-out scopes.
  const finishLocalSignOut = useCallback(() => {
    // Tell the engine the owner signed out before local session state is torn
    // down, so remote cloud clients cannot keep an owner-bound session alive.
    try {
      getActiveBridge()?.signalOwnerSignedOut();
    } catch {
      /* bridge already gone — nothing bound to clear */
    }
    setSession(null);
    setStatus("unauthenticated");
    setAuthAccessToken(null);
    setOAuthError(null);
    clearPendingNonce();
  }, []);

  const signOut = useCallback(async () => {
    try {
      // Local scope: sign out THIS device only — don't revoke the user's
      // sessions on other devices.
      await storeSignOut("local");
    } catch (err) {
      // Local sign-out should always win even if the network call fails.
      console.warn(
        "[auth] signOut network call failed:",
        (err as Error)?.message,
      );
    }
    finishLocalSignOut();
  }, [finishLocalSignOut]);

  const signOutEverywhere = useCallback(async () => {
    try {
      // Global scope asks the server-side broker to enumerate and revoke every
      // active WorkOS session (or uses the Auth0 compatibility revoke path).
      await storeSignOut("global");
    } catch (err) {
      console.warn("[auth] global signOut failed:", (err as Error)?.message);
    }
    finishLocalSignOut();
  }, [finishLocalSignOut]);

  const value: AuthContextValue = {
    status,
    session,
    userId: session?.user.accountId ?? session?.user.sub ?? null,
    email: session?.user.email ?? null,
    startBrowserSignIn,
    oauthError,
    clearOAuthError: () => setOAuthError(null),
    cancelPendingOAuth,
    signOut,
    signOutEverywhere,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Full-screen fallback for a non-Electron context — there is no browser
 *  fallback for auth (desktop-only product, 2026-06-25). */
function AuthConfigErrorScreen() {
  // AuthGate is not mounted in a non-Electron context, so this terminal
  // replacement surface owns dismissal of the HTML startup loader.
  useDismissStartupLoader(true);

  return (
    <div className="bg-bg1 text-fg2 fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-fg1 text-sm font-medium">
        Sign-in isn't available
      </div>
      <div className="text-muted-fg max-w-[380px] text-xs leading-relaxed">
        Zeros sign-in requires the desktop app.
      </div>
    </div>
  );
}

export { AuthContext };

// ── helpers ──────────────────────────────────────────────────────────────

// OAuth handoff nonce, persisted so it survives a renderer reload OR a cold
// launch (the desktop app may be relaunched BY the zeros:// deep link, after
// which the in-memory pendingNonceRef is empty). It is NOT a secret — a
// single-use, short-lived CSRF binding between THIS app instance's
// startBrowserSignIn and the returning deep link — so plain localStorage is fine
// (and it must NOT go in the keychain, which is the auth session's surface).
const OAUTH_NONCE_KEY = "zeros.auth.oauth-nonce";

function savePendingNonce(value: string, expiresAt: number): void {
  try {
    globalThis.localStorage?.setItem(
      OAUTH_NONCE_KEY,
      JSON.stringify({ value, expiresAt }),
    );
  } catch {
    /* storage disabled — the in-memory ref still covers the same-session case */
  }
}

function readPendingNonce(): { value: string; expiresAt: number } | null {
  try {
    const raw = globalThis.localStorage?.getItem(OAUTH_NONCE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { value?: unknown; expiresAt?: unknown };
    if (typeof p.value === "string" && typeof p.expiresAt === "number") {
      return { value: p.value, expiresAt: p.expiresAt };
    }
  } catch {
    /* corrupt / disabled storage → treat as absent */
  }
  return null;
}

function clearPendingNonce(): void {
  try {
    globalThis.localStorage?.removeItem(OAUTH_NONCE_KEY);
  } catch {
    /* ignore */
  }
}

// The desktop deep-link scheme (zeros:// stable, zeros-beta:// beta, zeros-dev://
// dev) is constant for the life of the process, so resolve it once and reuse it —
// avoids an app_info IPC round-trip on every Hosted AuthKit sign-in click.
let cachedScheme: DeepLinkScheme | null = null;

async function resolveDesktopScheme(): Promise<DeepLinkScheme> {
  if (cachedScheme) return cachedScheme;
  // Derive from the CHANNEL, not runtimeMode: a Beta build is runtimeMode "prod"
  // yet must return zeros-beta:// (else the returning link resolves to whichever
  // app owns bare zeros:// — the prod/beta collision). Fall back to the renderer's
  // OWN build-time channel (flags.ts CHANNEL, baked from VITE_ZEROS_CHANNEL) so a
  // missing app_info still schemes correctly per channel.
  let scheme: DeepLinkScheme = schemeForChannel(CHANNEL);
  try {
    // app_info.channel is the MAIN process's authoritative channel — the same
    // value apps/desktop/electron/deep-link.ts registered + validates against, so the scheme
    // we build the /launch URL with can never be one main rejects.
    const info = await nativeInvoke<{ channel?: Channel }>("app_info");
    if (info?.channel) scheme = schemeForChannel(info.channel);
  } catch {
    /* keep the build-channel default */
  }
  cachedScheme = scheme;
  return scheme;
}
