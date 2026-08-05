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
// (apps/desktop/electron/keychain-accounts.ts) — mutually isolated the same way the old
// auth-storage.ts was.
// ──────────────────────────────────────────────────────────

import type { CommandHandler } from "../router";
import {
  deleteSecret,
  getSecret,
  replaceSecretIfUnchanged,
  secretsFilePath,
  setSecret,
} from "../../secret-store";
import { withCrossProcessFileLock } from "../../cross-process-lock";

const TOKENS_KEY = "auth-session:tokens";
const REFRESH_SKEW_MS = 60_000;
const AUTH_REQUEST_TIMEOUT_MS = 15_000;

type StoredTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  sub: string;
  email: string;
  name: string | null;
};

interface StoredTokenSnapshot {
  raw: string;
  tokens: StoredTokens;
}

export interface MainAuthSession {
  accessToken: string;
  sub: string;
  email: string;
  name: string | null;
}

type AuthSessionChangeListener = () => void | Promise<void>;
const sessionChangeListeners = new Set<AuthSessionChangeListener>();

function notifySessionChanged(): void {
  for (const listener of sessionChangeListeners) {
    try {
      void Promise.resolve(listener()).catch((error) => {
        console.warn(
          `[auth] session-change listener failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    } catch (error) {
      console.warn(
        `[auth] session-change listener failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** Main-only lifecycle hook. Renderer code cannot register listeners here. */
export function onMainAuthSessionChanged(
  listener: AuthSessionChangeListener,
): () => void {
  sessionChangeListeners.add(listener);
  return () => sessionChangeListeners.delete(listener);
}

/** Base URL of the web hub that hosts /handoff/*. Fixed to the deployed app in
 *  prod; overridable via env ONLY for local/preview iteration — matches
 *  auth-handoff.ts's handoffBaseUrl(). */
function handoffBaseUrl(): string {
  const raw =
    process.env.ZEROS_APP_BASE_URL ||
    process.env.VITE_APP_BASE_URL ||
    "https://app.zeros.build";
  return raw.replace(/\/+$/, "");
}

function decodeJwtExp(token: string): number | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const json = Buffer.from(
      payload.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const claims = JSON.parse(json) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function parseTokenSnapshot(raw: string | null): StoredTokenSnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value.accessToken !== "string" ||
      !value.accessToken ||
      typeof value.refreshToken !== "string" ||
      !value.refreshToken ||
      typeof value.expiresAt !== "number" ||
      !Number.isFinite(value.expiresAt) ||
      typeof value.sub !== "string" ||
      !value.sub ||
      typeof value.email !== "string" ||
      !value.email ||
      (value.name !== null && typeof value.name !== "string")
    ) {
      return null;
    }
    return { raw, tokens: value as StoredTokens };
  } catch {
    return null;
  }
}

function readTokenSnapshot(): StoredTokenSnapshot | null {
  return parseTokenSnapshot(getSecret(TOKENS_KEY));
}

function readTokens(): StoredTokens | null {
  return readTokenSnapshot()?.tokens ?? null;
}

function writeTokens(tokens: StoredTokens): void {
  setSecret(TOKENS_KEY, JSON.stringify(tokens));
}

/** Persist a freshly-redeemed token pair + identity into the keychain. Called
 *  IN-PROCESS by auth_redeem_handoff (auth-handoff.ts), NOT over IPC: the refresh
 *  token is written straight to safeStorage here and never returned to the
 *  renderer. There is deliberately no renderer-reachable "install session"
 *  command, so a renderer XSS can neither read the refresh token nor plant a
 *  forged session by installing attacker-supplied tokens. */
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
  notifySessionChanged();
}

// Outcome of a refresh attempt, split so the caller can tell a genuinely dead
// refresh token (clear the session) apart from a momentary outage (keep it).
type RefreshOutcome =
  | { status: "ok"; tokens: StoredTokens }
  | { status: "terminal"; expectedRaw?: string } // 401/403 — refresh token is dead; sign out.
  | { status: "transient" }; // offline / 5xx / 429 / bad body — keep tokens.

async function refreshTokens(
  snapshot: StoredTokenSnapshot,
): Promise<RefreshOutcome> {
  const current = snapshot.tokens;
  let res: Response;
  try {
    res = await fetch(`${handoffBaseUrl()}/handoff/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: current.refreshToken }),
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Offline / DNS / TLS / captive portal — NOT a dead token. Keep the session.
    console.warn(
      `[auth] refresh network error (keeping session): ${(err as Error).message}`,
    );
    return { status: "transient" };
  }
  if (!res.ok) {
    // The relay maps a dead refresh grant to 401 (403 defensively). Everything
    // else — 429, 5xx, an unexpected status — is transient: the token itself may
    // be fine, so we must NOT wipe it or the user gets logged out by a blip.
    if (res.status === 401 || res.status === 403) {
      console.warn(`[auth] refresh rejected as terminal: HTTP ${res.status}`);
      return { status: "terminal", expectedRaw: snapshot.raw };
    }
    console.warn(
      `[auth] refresh unavailable (keeping session): HTTP ${res.status}`,
    );
    return { status: "transient" };
  }
  let body: { access_token?: unknown; refresh_token?: unknown };
  try {
    body = (await res.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
    };
  } catch {
    return { status: "transient" };
  }
  const accessToken =
    typeof body.access_token === "string" ? body.access_token : "";
  if (!accessToken) return { status: "transient" };
  const refreshToken =
    typeof body.refresh_token === "string"
      ? body.refresh_token
      : current.refreshToken;
  const next: StoredTokens = {
    ...current,
    accessToken,
    refreshToken,
    expiresAt: decodeJwtExp(accessToken) ?? Date.now() + 60_000,
  };
  if (
    replaceSecretIfUnchanged(TOKENS_KEY, snapshot.raw, JSON.stringify(next))
  ) {
    return { status: "ok", tokens: next };
  }
  // A sign-in/sign-out or sibling worktree won while the network request was
  // in flight. Never resurrect or overwrite it with this stale response.
  const latest = readTokens();
  return latest ? { status: "ok", tokens: latest } : { status: "terminal" };
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
    inFlightRefresh = withCrossProcessFileLock(
      `${secretsFilePath()}.auth-session-refresh.lock`,
      async (): Promise<RefreshOutcome> => {
        // Re-read after acquiring the cross-worktree lock: a sibling may have
        // already rotated this single-use refresh token while we waited.
        const snapshot = readTokenSnapshot();
        if (!snapshot) return { status: "terminal" };
        if (snapshot.tokens.expiresAt - Date.now() >= REFRESH_SKEW_MS) {
          return { status: "ok", tokens: snapshot.tokens };
        }
        return refreshTokens(snapshot);
      },
      { staleAfterMs: 60_000, waitTimeoutMs: 65_000 },
    ).finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

export async function getValidSessionForMain(): Promise<MainAuthSession | null> {
  const tokens = readTokens();
  if (!tokens) return null;
  const toSession = (value: StoredTokens): MainAuthSession => ({
    accessToken: value.accessToken,
    sub: value.sub,
    email: value.email,
    name: value.name,
  });
  // Fast path: comfortably valid, no network at all.
  if (tokens.expiresAt - Date.now() >= REFRESH_SKEW_MS) {
    return toSession(tokens);
  }
  const outcome = await refreshOnce();
  if (outcome.status === "ok") return toSession(outcome.tokens);
  if (outcome.status === "terminal") {
    const removed =
      outcome.expectedRaw !== undefined &&
      replaceSecretIfUnchanged(TOKENS_KEY, outcome.expectedRaw, null);
    if (removed) notifySessionChanged();
    const latest = readTokens();
    return latest ? toSession(latest) : null;
  }
  // Transient: KEEP the stored tokens. Hand back the cached access token if it's
  // not yet actually expired (we refresh at exp−60s, so it usually has seconds
  // left); otherwise null WITHOUT clearing, so the next call simply retries.
  const latest = readTokens() ?? tokens;
  const stillValid = latest.expiresAt - Date.now() > 0;
  return stillValid ? toSession(latest) : null;
}

/** Main-process consumers use this rather than routing a privileged call back
 *  through renderer IPC. */
export async function getValidAccessTokenForMain(): Promise<string | null> {
  return (await getValidSessionForMain())?.accessToken ?? null;
}

export function getSessionUserForMain(): {
  sub: string;
  email: string;
  name: string | null;
} | null {
  const tokens = readTokens();
  return tokens
    ? { sub: tokens.sub, email: tokens.email, name: tokens.name }
    : null;
}

export const authGetAccessToken: CommandHandler = async () => {
  return { access_token: await getValidAccessTokenForMain() };
};

export const authGetSessionUser: CommandHandler = () => {
  return getSessionUserForMain();
};

export const authClearSession: CommandHandler = () => {
  deleteSecret(TOKENS_KEY);
  notifySessionChanged();
  return true;
};

export const authSignOutEverywhere: CommandHandler = async () => {
  // Capture the exact encrypted-record payload once. The final CAS removes
  // either that valid session or a malformed record, but never a newer login
  // that another shared dev worktree commits while revoke is in flight.
  const rawAtStart = getSecret(TOKENS_KEY);
  const snapshot = parseTokenSnapshot(rawAtStart);
  if (snapshot) {
    try {
      await fetch(`${handoffBaseUrl()}/handoff/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          refresh_token: snapshot.tokens.refreshToken,
        }),
        signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      console.warn(
        `[auth] revoke network call failed: ${(err as Error).message}`,
      );
      // Local teardown wins even if the network call fails — matches the old
      // signOut({scope:"global"}) contract's error handling.
    }
  }
  let removed =
    rawAtStart !== null &&
    replaceSecretIfUnchanged(TOKENS_KEY, rawAtStart, null);
  if (!removed && rawAtStart !== null) {
    // The record changed while revoke was in flight. Only a DIFFERENT account
    // may survive an explicit sign-out: a plain rotation of the SAME session
    // (this process's own refreshOnce, or a sibling dev worktree's) must still
    // be torn down, or the user keeps a session whose refresh token is already
    // revoked server-side and the UI flips back to signed-in on the next probe.
    const latest = readTokenSnapshot();
    if (latest && (!snapshot || latest.tokens.sub === snapshot.tokens.sub)) {
      removed = replaceSecretIfUnchanged(TOKENS_KEY, latest.raw, null);
    }
  }
  if (removed) notifySessionChanged();
  return true;
};
