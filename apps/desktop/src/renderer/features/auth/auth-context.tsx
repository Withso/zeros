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
//   • resync() releases main's stored identity before waiting for token refresh.
//     That identity permits cached presentation; only a live session supplies
//     authenticated status and the synchronous access-token mirror.
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
  getStoredAuthUser,
  onStoredIdentityChange,
  onAuthStateChange,
  resync,
  signOut as storeSignOut,
  type AuthSessionInfo,
  type AuthUser,
  listSignedInAccounts,
  switchAccount as storeSwitchAccount,
  signOutAccount as storeSignOutAccount,
  type SignedInAccount,
  type SwitchAccountOutcome,
} from "./auth-store";
import { setAuthAccessToken } from "./auth-token";
import {
  isElectron,
  isLocalDevelopment,
  nativeInvoke,
  nativeListen,
} from "../../platform/runtime";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import { toast } from "../../shared/ui/primitives/elements";
import { useDismissStartupLoader } from "../../shared/ui/startup-loader";
import {
  safeBrowserSignInStartError,
  workOSSignInFailureMessage,
} from "./auth-errors";

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
  /** "loading" until the first session check or explicit session change. */
  status: AuthStatus;
  session: AuthSessionInfo | null;
  /** Main-owned presentation identity; it never authorizes account requests. */
  storedUser?: AuthUser | null;
  userId: string | null;
  email: string | null;
  /** Open the system browser. WorkOS PKCE/callback state lives entirely in
   *  Electron main. `addAccount` signs in another account with a fresh browser
   *  sign-in. */
  startBrowserSignIn: (options?: { addAccount?: boolean }) => Promise<AuthResult>;
  /** Accounts signed in on this device, the active one first. */
  accounts: SignedInAccount[];
  /** Re-read the signed-in accounts, for example when a menu opens. */
  refreshAccounts: () => Promise<void>;
  /** Make another signed-in account active without signing anything out. */
  switchAccount: (accountId: string) => Promise<SwitchAccountOutcome>;
  /** Sign out one account that is not the active one. */
  signOutAccount: (accountId: string) => Promise<void>;
  /** A LATER async failure of the browser sign-in (the browser round-trip
   *  completed but main couldn't finish it), so the LoginScreen can show it
   *  instead of hanging on the "continue in your browser" hint. Null when there
   *  is no pending error. */
  oauthError: string | null;
  /** Dismiss the current oauthError (e.g. the user starts a different sign-in). */
  clearOAuthError: () => void;
  /** Abort a pending browser sign-in so a callback arriving AFTER the user
   *  cancelled can't silently sign them in, and clear any pending error. Used
   *  by the "Cancel" affordance while waiting for the browser. */
  cancelPendingOAuth: () => void;
  /** Clear the session on THIS device (keychain + memory; web also unpairs). */
  signOut: () => Promise<void>;
  /** Revoke the account's sessions on ALL devices (global scope) — the recovery
   *  action for a suspected session/token compromise. */
  signOutEverywhere: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children, onStoredIdentity }: {
  children: React.ReactNode;
  onStoredIdentity?: (user: AuthUser | null) => void;
}) {
  if (!isElectron()) return <AuthConfigErrorScreen />;
  if (isLocalDevelopment()) {
    return (
      <AuthContext.Provider value={localDevelopmentAuth}>
        {children}
      </AuthContext.Provider>
    );
  }
  return <AuthProviderInner onStoredIdentity={onStoredIdentity}>{children}</AuthProviderInner>;
}

// No account, token, auth subscriptions or browser ceremony in Local. Retain
// signed-out status so account-dependent features never mistake it for login.
const localDevelopmentAuth: AuthContextValue = {
  status: "unauthenticated",
  session: null,
  storedUser: null,
  userId: null,
  email: null,
  startBrowserSignIn: async () => ({
    ok: false,
    error: "Zeros Local runs without a Zeros account. Use Zeros Dev to test sign-in.",
  }),
  accounts: [],
  refreshAccounts: async () => {},
  switchAccount: async () => "unavailable",
  signOutAccount: async () => {},
  oauthError: null,
  clearOAuthError: () => {},
  cancelPendingOAuth: () => {},
  signOut: async () => {},
  signOutEverywhere: async () => {},
};

/** Reconcile main-owned session updates and expose sign-in state, including
 * actionable Dev setup errors, without moving credential storage into React. */
function AuthProviderInner({ children, onStoredIdentity }: {
  children: React.ReactNode;
  onStoredIdentity?: (user: AuthUser | null) => void;
}) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [session, setSession] = useState<AuthSessionInfo | null>(null);
  const [storedUser, setStoredUser] = useState<AuthUser | null>(null);
  const [accounts, setAccounts] = useState<SignedInAccount[]>([]);
  const accountsReadRef = useRef(0);
  const refreshAccounts = useCallback(async () => {
    const read = ++accountsReadRef.current;
    const next = await listSignedInAccounts().catch(() => null);
    if (next && read === accountsReadRef.current) setAccounts(next);
  }, []);
  // The engine binds remote devices to the owner account; another account
  // taking over must end that binding first, exactly as sign-out does.
  const previousAccountRef = useRef<string | null>(null);
  // A LATER, asynchronous failure of the browser sign-in: the browser
  // round-trip finished but main couldn't complete the exchange. Surfaced to
  // the LoginScreen so a failed sign-in shows a real error instead of hanging
  // on the "continue in your browser" hint forever. Null when nothing is wrong.
  const [oauthError, setOAuthError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
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

    const applyIdentity = (user: AuthUser | null) => {
      if (!active) return;
      const account = user ? user.accountId ?? user.sub : null;
      if (previousAccountRef.current && account && previousAccountRef.current !== account) {
        try {
          getActiveBridge()?.signalOwnerSignedOut();
        } catch {
          /* bridge already unavailable */
        }
      }
      previousAccountRef.current = account;
      // Bind/restore caches before releasing the shell for this identity.
      onStoredIdentity?.(user);
      setStoredUser(user);
      void refreshAccounts();
    };
    const offIdentity = onStoredIdentityChange(applyIdentity);
    const known = getStoredAuthUser();
    if (known !== undefined) applyIdentity(known);
    const offStateChange = onAuthStateChange(apply);
    void resync()
      .catch((err) => {
        console.warn("[auth] session restore failed:", (err as Error)?.message);
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
        const message = workOSSignInFailureMessage(reason ?? "", recoveryCode);
        setOAuthError(message);
        // Adding an account happens while signed in, where no login screen shows it.
        if (getStoredAuthUser()) toast.error(message);
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
      void resync().catch(() => undefined);
    };
    window.addEventListener("online", onOnline);

    return () => {
      active = false;
      offStateChange();
      offIdentity();
      offStoreChanged?.();
      offWorkOSComplete?.();
      offWorkOSError?.();
      offSecurityRevoked?.();
      window.removeEventListener("online", onOnline);
    };
  }, [onStoredIdentity, refreshAccounts]);

  const startBrowserSignIn = useCallback(async (options?: { addAccount?: boolean }): Promise<AuthResult> => {
    // Clear any stale error from a prior attempt before starting fresh.
    setOAuthError(null);
    try {
      // Opens the hosted Zeros sign-in page and keeps state + verifier in
      // Electron main, outside renderer JS.
      const selected = await nativeInvoke<{
        mode?: "workos" | "unconfigured";
        expiresAt?: number;
      }>("auth_start_signin", options?.addAccount ? { addAccount: true } : undefined);
      if (selected?.mode === "unconfigured") {
        return {
          ok: false,
          error:
            "Zeros Dev could not load its sign-in settings. Check your connection and restart the Dev launcher to try again.",
        };
      }
      if (selected?.mode !== "workos") {
        return { ok: false, error: "Couldn't start sign-in." };
      }
      return {
        ok: true,
        expiresAt:
          typeof selected.expiresAt === "number" &&
          Number.isFinite(selected.expiresAt)
            ? selected.expiresAt
            : undefined,
      };
    } catch (err) {
      return {
        ok: false,
        error: safeBrowserSignInStartError(err),
      };
    }
  }, []);

  const cancelPendingOAuth = useCallback(() => {
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
    setStoredUser(null);
    setStatus("unauthenticated");
    setAuthAccessToken(null);
    setOAuthError(null);
  }, []);

  // Main continues with the most recently used other account, if one is left.
  const adoptNextAccount = useCallback(() => {
    void resync().catch(() => null);
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
    adoptNextAccount();
  }, [adoptNextAccount, finishLocalSignOut]);

  const signOutEverywhere = useCallback(async () => {
    try {
      // Global scope asks the server-side broker to enumerate and revoke every
      // active WorkOS session.
      await storeSignOut("global");
    } catch (err) {
      console.warn("[auth] global signOut failed:", (err as Error)?.message);
      toast.error("Signed out on this device. Other devices could not be signed out. Sign in again to retry.");
    }
    finishLocalSignOut();
    adoptNextAccount();
  }, [adoptNextAccount, finishLocalSignOut]);

  const switchAccount = useCallback(async (accountId: string) => {
    const outcome = await storeSwitchAccount(accountId).catch(() => "unavailable" as const);
    if (outcome === "signed_out") {
      toast.error("That account was signed out. Add it again to use it here.");
    } else if (outcome === "unavailable") {
      toast.error("Couldn't switch accounts. Check your connection and try again.");
    }
    await refreshAccounts();
    return outcome;
  }, [refreshAccounts]);

  const signOutAccount = useCallback(async (accountId: string) => {
    await storeSignOutAccount(accountId).catch((err) => {
      console.warn("[auth] account sign-out failed:", (err as Error)?.message);
    });
    await refreshAccounts();
  }, [refreshAccounts]);

  const value: AuthContextValue = {
    status,
    session,
    storedUser,
    userId: storedUser?.accountId ?? storedUser?.sub ?? null,
    email: storedUser?.email ?? null,
    startBrowserSignIn,
    accounts,
    refreshAccounts,
    switchAccount,
    signOutAccount,
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
    <div className="bg-bg1 text-fg2 fixed inset-0 z-modal flex flex-col items-center justify-center gap-3 px-6 text-center">
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
