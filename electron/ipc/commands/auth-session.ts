// ──────────────────────────────────────────────────────────
// IPC commands: Auth0 session storage + refresh (main-process-owned)
// ──────────────────────────────────────────────────────────
//
// Replaces the old SDK-in-the-renderer model. The refresh token NEVER
// crosses into the renderer's JS heap — main owns the full token pair
// (safeStorage), the renderer only ever asks for "a valid access token" or "who's
// signed in" and gets back exactly that, nothing more:
//
//   persistSession({accessToken, refreshToken, sub, email, name})  [in-process]
//       Called once, right after auth_redeem_handoff redeems a handoff ticket —
//       IN THE MAIN PROCESS, not over IPC. Stores the pair + identity claims (the
//       API-audience access token itself only carries scope/aud claims, not
//       profile info — identity is threaded through the handoff response instead,
//       see app.zeros.build/handoff/mint.ts). There is deliberately no renderer-
//       reachable install command: the refresh token never crosses into the
//       renderer, and a renderer XSS can't plant a forged session.
//
//   auth_get_access_token() → { access_token } | { access_token: null }
//       Returns a live access token, transparently refreshing first (via
//       app.zeros.build/handoff/refresh, which holds the Auth0 client secret so
//       this process never has to) if it's within REFRESH_SKEW_MS of expiry.
//
//       OFFLINE TOLERANCE (the whole point of splitting refresh outcomes): only a
//       TERMINAL refusal — the relay maps a dead/expired/revoked refresh token to
//       HTTP 401/403 — clears the stored session. A TRANSIENT failure (offline,
//       DNS, TLS, wake-from-sleep before Wi-Fi, or a 429/5xx from Cloudflare or
//       Auth0) KEEPS the token pair and returns the still-valid cached access
//       token (or null without clearing) so a momentary blip never forces a fresh
//       browser sign-in. Concurrent callers share ONE in-flight refresh, so a
//       burst of API calls near expiry can't race the same refresh token into a
//       rotation-reuse revocation.
//
//   auth_get_session_user() → { sub, email, name } | null
//       Decoded identity for UI state, without exposing either token.
//
//   auth_clear_session() → true
//       Local sign-out: drop the stored tokens. No network call — this device
//       only, mirrors the old client.auth.signOut({scope:"local"}).
//
//   auth_sign_out_everywhere() → true
//       Revokes the refresh token server-side (app.zeros.build/handoff/revoke)
//       then clears local storage — the compromise-recovery action.
//
// SECURITY: tokens are namespaced under "auth-session:" — distinct from the
// legacy "supabase:" namespace (now retired) and from generic keychain_* secrets
// (electron/keychain-accounts.ts) — mutually isolated the same way the old
// auth-storage.ts was.
// ──────────────────────────────────────────────────────────

import type { CommandHandler } from "../router";
import { deleteSecret, getSecret, setSecret } from "../../secret-store";

const TOKENS_KEY = "auth-session:tokens";
const REFRESH_SKEW_MS = 60_000;

type StoredTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  sub: string;
  email: string;
  name: string | null;
};

/** Base URL of the web hub that hosts /handoff/*. Fixed to the deployed app in
 *  prod; overridable via env ONLY for local/preview iteration — matches
 *  auth-handoff.ts's handoffBaseUrl(). */
function handoffBaseUrl(): string {
  const raw =
    process.env.ZEROS_APP_BASE_URL || process.env.VITE_APP_BASE_URL || "https://app.zeros.build";
  return raw.replace(/\/+$/, "");
}

function decodeJwtExp(token: string): number | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(json) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function readTokens(): StoredTokens | null {
  const raw = getSecret(TOKENS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

function writeTokens(tokens: StoredTokens): void {
  setSecret(TOKENS_KEY, JSON.stringify(tokens));
}

/** Persist a freshly-redeemed token pair + identity into the keychain. Called
 *  IN-PROCESS by auth_redeem_handoff (auth-handoff.ts), NOT over IPC: the refresh
 *  token is written straight to safeStorage here and never returned to the
 *  renderer. There is deliberately no renderer-reachable "install session"
 *  command, so a renderer XSS can neither read the refresh token nor plant a
 *  forged session by installing attacker-supplied tokens (H1). */
export function persistSession(input: {
  accessToken: string;
  refreshToken: string;
  sub: string;
  email: string;
  name: string | null;
}): void {
  if (!input.accessToken || !input.refreshToken || !input.sub || !input.email) {
    throw new Error("persistSession: missing required field");
  }
  writeTokens({
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: decodeJwtExp(input.accessToken) ?? Date.now() + 60_000,
    sub: input.sub,
    email: input.email,
    name: input.name,
  });
}

// Outcome of a refresh attempt, split so the caller can tell a genuinely dead
// refresh token (clear the session) apart from a momentary outage (keep it).
type RefreshOutcome =
  | { status: "ok"; tokens: StoredTokens }
  | { status: "terminal" } // 401/403 — refresh token is dead; sign out.
  | { status: "transient" }; // offline / 5xx / 429 / bad body — keep tokens.

async function refreshTokens(current: StoredTokens): Promise<RefreshOutcome> {
  let res: Response;
  try {
    res = await fetch(`${handoffBaseUrl()}/handoff/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: current.refreshToken }),
    });
  } catch (err) {
    // Offline / DNS / TLS / captive portal — NOT a dead token. Keep the session.
    console.warn(`[auth] refresh network error (keeping session): ${(err as Error).message}`);
    return { status: "transient" };
  }
  if (!res.ok) {
    // The relay maps a dead refresh grant to 401 (403 defensively). Everything
    // else — 429, 5xx, an unexpected status — is transient: the token itself may
    // be fine, so we must NOT wipe it or the user gets logged out by a blip.
    if (res.status === 401 || res.status === 403) {
      console.warn(`[auth] refresh rejected as terminal: HTTP ${res.status}`);
      return { status: "terminal" };
    }
    console.warn(`[auth] refresh unavailable (keeping session): HTTP ${res.status}`);
    return { status: "transient" };
  }
  let body: { access_token?: unknown; refresh_token?: unknown };
  try {
    body = (await res.json()) as { access_token?: unknown; refresh_token?: unknown };
  } catch {
    return { status: "transient" };
  }
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (!accessToken) return { status: "transient" };
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : current.refreshToken;
  const next: StoredTokens = {
    ...current,
    accessToken,
    refreshToken,
    expiresAt: decodeJwtExp(accessToken) ?? Date.now() + 60_000,
  };
  writeTokens(next);
  return { status: "ok", tokens: next };
}

// Single-flight guard: a burst of near-expiry callers (mount + resync + every
// control-plane request) must share ONE refresh, or they race the same refresh
// token through /handoff/refresh concurrently — and with Auth0 rotation the
// losers present an already-consumed token, which reads as terminal and (worse,
// under reuse-detection) can revoke the whole token family. The check-and-set is
// synchronous, so at most one refresh is ever in flight.
let inFlightRefresh: Promise<RefreshOutcome> | null = null;

function refreshOnce(): Promise<RefreshOutcome> {
  if (!inFlightRefresh) {
    inFlightRefresh = (async (): Promise<RefreshOutcome> => {
      // Re-read inside the lock: a refresh that JUST completed may already have
      // renewed the token, so a queued caller needn't refresh (or rotate) again.
      const current = readTokens();
      if (!current) return { status: "terminal" };
      if (current.expiresAt - Date.now() >= REFRESH_SKEW_MS) {
        return { status: "ok", tokens: current };
      }
      return refreshTokens(current);
    })().finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

export const authGetAccessToken: CommandHandler = async () => {
  const tokens = readTokens();
  if (!tokens) return { access_token: null };
  // Fast path: comfortably valid, no network at all.
  if (tokens.expiresAt - Date.now() >= REFRESH_SKEW_MS) {
    return { access_token: tokens.accessToken };
  }
  const outcome = await refreshOnce();
  if (outcome.status === "ok") return { access_token: outcome.tokens.accessToken };
  if (outcome.status === "terminal") {
    deleteSecret(TOKENS_KEY); // dead refresh token — force a fresh sign-in
    return { access_token: null };
  }
  // Transient: KEEP the stored tokens. Hand back the cached access token if it's
  // not yet actually expired (we refresh at exp−60s, so it usually has seconds
  // left); otherwise null WITHOUT clearing, so the next call simply retries.
  const stillValid = tokens.expiresAt - Date.now() > 0;
  return { access_token: stillValid ? tokens.accessToken : null };
};

export const authGetSessionUser: CommandHandler = () => {
  const tokens = readTokens();
  if (!tokens) return null;
  return { sub: tokens.sub, email: tokens.email, name: tokens.name };
};

export const authClearSession: CommandHandler = () => {
  deleteSecret(TOKENS_KEY);
  return true;
};

export const authSignOutEverywhere: CommandHandler = async () => {
  const tokens = readTokens();
  if (tokens) {
    try {
      await fetch(`${handoffBaseUrl()}/handoff/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: tokens.refreshToken }),
      });
    } catch (err) {
      console.warn(`[auth] revoke network call failed: ${(err as Error).message}`);
      // Local teardown wins even if the network call fails — matches the old
      // signOut({scope:"global"}) contract's error handling.
    }
  }
  deleteSecret(TOKENS_KEY);
  return true;
};
