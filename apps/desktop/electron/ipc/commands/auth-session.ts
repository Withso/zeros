// Main-process-owned desktop authentication session. The persisted account
// name remains `auth-session:tokens` for compatibility; WorkOS adds provider,
// internal-account, client-kind, and session identity fields without exposing
// refresh material to renderer IPC.

import type { CommandHandler } from "../router";
import {
  deleteSecret,
  getSecret,
  replaceSecretIfUnchanged,
  SecretStoreReadError,
  secretsFilePath,
  setSecret,
} from "../../secret-store";
import { withCrossProcessFileLock } from "../../cross-process-lock";
import { appBaseUrl } from "../../app-base-url";
import {
  mergeWorkOSRefresh,
  parseStoredTokenSnapshot,
  type StoredTokens,
  type StoredTokenSnapshot,
  type WorkOSStoredTokens,
} from "../../auth-session-record";
import type { WorkOSDesktopSession } from "../../workos-desktop-client";
import { workOSDesktopClientForMain } from "../../workos-desktop-runtime";
import { requestWorkOSDesktopRevocation } from "../../workos-desktop-revocation";
import { channel } from "../../../src/engine/runtime";
import { desktopAuthConfig } from "../../workos-desktop-config";
import { devWorkOSConfigurationIssue } from "../../dev-workos-auth-policy";
import { controlPlaneBaseUrl } from "../../workos-desktop-account";

const TOKENS_KEY = "auth-session:tokens";
const REFRESH_SKEW_MS = 60_000;
const AUTH_REQUEST_TIMEOUT_MS = 15_000;

export interface MainAuthSession {
  accessToken: string;
  sub: string;
  email: string;
  name: string | null;
  provider: "auth0" | "workos";
  accountId?: string;
  sessionId?: string;
  clientKind?: "desktop";
  authenticationMethod?: string | null;
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

function decodeJwtExp(token: string): number | null {
  try {
    const payload = token.split(".")[1] ?? "";
    const json = Buffer.from(
      payload.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const claims = JSON.parse(json) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1_000 : null;
  } catch {
    return null;
  }
}

function devUsesWorkOS(): boolean {
  if (channel() !== "dev") return false;
  try {
    return devWorkOSConfigurationIssue({
      auth: desktopAuthConfig(),
      appOrigin: appBaseUrl(),
      controlPlaneOrigin: controlPlaneBaseUrl(),
    }) === null;
  } catch {
    return false;
  }
}

function readTokenSnapshot(): StoredTokenSnapshot | null {
  const snapshot = parseStoredTokenSnapshot(getSecret(TOKENS_KEY));
  if (snapshot?.tokens.provider !== "auth0" || !devUsesWorkOS()) return snapshot;
  // Retire only Dev's old login after the new Alpha contract is complete.
  // CAS preserves a WorkOS sign-in concurrently installed by another worktree.
  if (replaceSecretIfUnchanged(TOKENS_KEY, snapshot.raw, null)) {
    console.info(
      "[auth] Legacy Dev session retired; sign in once with WorkOS for all Dev instances",
    );
    notifySessionChanged();
  }
  const latest = parseStoredTokenSnapshot(getSecret(TOKENS_KEY));
  return latest?.tokens.provider === "workos" ? latest : null;
}

function readTokens(): StoredTokens | null {
  return readTokenSnapshot()?.tokens ?? null;
}

function writeTokens(tokens: StoredTokens): void {
  setSecret(TOKENS_KEY, JSON.stringify(tokens));
}

/** Auth0 compatibility install, called only by the main-owned handoff redeem. */
export function persistSession(input: {
  accessToken: string;
  refreshToken: string;
  sub: string;
  email: string;
  name: string | null;
}): void {
  if (devUsesWorkOS()) throw new Error("Zeros Dev now requires WorkOS sign-in");
  if (!input.accessToken || !input.refreshToken || !input.sub || !input.email) {
    throw new Error("persistSession: missing required field");
  }
  writeTokens({
    provider: "auth0",
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: decodeJwtExp(input.accessToken) ?? Date.now() + 60_000,
    sub: input.sub,
    email: input.email,
    name: input.name,
  });
  notifySessionChanged();
}

/** WorkOS install accepts only a session already verified in Electron main and
 * enriched by authenticated `/v1/me`. It is intentionally not an IPC command. */
export function persistWorkOSSession(
  input: WorkOSDesktopSession & { accountId: string },
): void {
  if (
    !input.accessToken ||
    !input.refreshToken ||
    !input.providerSubject ||
    !input.sessionId ||
    !input.email ||
    !input.accountId ||
    input.clientKind !== "desktop"
  ) {
    throw new Error("persistWorkOSSession: missing required field");
  }
  writeTokens({
    provider: "workos",
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    sub: input.providerSubject,
    email: input.email,
    name: input.name,
    accountId: input.accountId,
    sessionId: input.sessionId,
    clientKind: "desktop",
    authenticationMethod: input.authenticationMethod,
  });
  notifySessionChanged();
}

type RefreshOutcome =
  | { status: "ok"; tokens: StoredTokens }
  | { status: "terminal"; expectedRaw?: string }
  | { status: "transient" };

function latestAfterLostCommit(
  successStatus: "ok" | "transient",
): RefreshOutcome {
  const latest = readTokens();
  if (!latest) return { status: "terminal" };
  return successStatus === "ok"
    ? { status: "ok", tokens: latest }
    : { status: "transient" };
}

async function refreshAuth0Tokens(
  snapshot: StoredTokenSnapshot,
): Promise<RefreshOutcome> {
  const current = snapshot.tokens;
  let response: Response;
  try {
    response = await fetch(`${appBaseUrl()}/handoff/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: current.refreshToken }),
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn(
      `[auth] refresh network error (keeping session): ${(error as Error).message}`,
    );
    return { status: "transient" };
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      console.warn(
        `[auth] refresh rejected as terminal: HTTP ${response.status}`,
      );
      return { status: "terminal", expectedRaw: snapshot.raw };
    }
    console.warn(
      `[auth] refresh unavailable (keeping session): HTTP ${response.status}`,
    );
    return { status: "transient" };
  }
  let body: { access_token?: unknown; refresh_token?: unknown };
  try {
    body = (await response.json()) as typeof body;
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
  return replaceSecretIfUnchanged(
    TOKENS_KEY,
    snapshot.raw,
    JSON.stringify(next),
  )
    ? { status: "ok", tokens: next }
    : latestAfterLostCommit("ok");
}

async function refreshWorkOSTokens(
  snapshot: StoredTokenSnapshot & { tokens: WorkOSStoredTokens },
): Promise<RefreshOutcome> {
  let providerOutcome;
  try {
    providerOutcome = await workOSDesktopClientForMain().refresh({
      refreshToken: snapshot.tokens.refreshToken,
      expectedSubject: snapshot.tokens.sub,
      expectedSessionId: snapshot.tokens.sessionId,
    });
  } catch (error) {
    console.warn(
      `[auth] WorkOS refresh unavailable (keeping session): ${(error as Error).message}`,
    );
    return { status: "transient" };
  }
  const merged = mergeWorkOSRefresh(snapshot.tokens, providerOutcome);
  if (merged.status === "terminal") {
    return { status: "terminal", expectedRaw: snapshot.raw };
  }

  // Every active response is durably rewritten even when WorkOS returned the
  // same refresh token. A transient post-rotation verification failure writes
  // only the replacement refresh token and withholds the bearer.
  const mustWrite =
    merged.status === "active" || merged.tokens !== snapshot.tokens;
  if (
    mustWrite &&
    !replaceSecretIfUnchanged(
      TOKENS_KEY,
      snapshot.raw,
      JSON.stringify(merged.tokens),
    )
  ) {
    return latestAfterLostCommit(
      merged.status === "active" ? "ok" : "transient",
    );
  }
  if (merged.status === "active") {
    return { status: "ok", tokens: merged.tokens };
  }
  return { status: "transient" };
}

async function refreshTokens(
  snapshot: StoredTokenSnapshot,
): Promise<RefreshOutcome> {
  return snapshot.tokens.provider === "workos"
    ? refreshWorkOSTokens(
        snapshot as StoredTokenSnapshot & { tokens: WorkOSStoredTokens },
      )
    : refreshAuth0Tokens(snapshot);
}

let inFlightRefresh: Promise<RefreshOutcome> | null = null;

function refreshOnce(): Promise<RefreshOutcome> {
  if (!inFlightRefresh) {
    inFlightRefresh = withCrossProcessFileLock(
      `${secretsFilePath()}.auth-session-refresh.lock`,
      async (): Promise<RefreshOutcome> => {
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

function toMainSession(value: StoredTokens): MainAuthSession {
  return {
    accessToken: value.accessToken,
    sub: value.sub,
    email: value.email,
    name: value.name,
    provider: value.provider,
    ...(value.accountId ? { accountId: value.accountId } : {}),
    ...(value.provider === "workos"
      ? {
          sessionId: value.sessionId,
          clientKind: value.clientKind,
          authenticationMethod: value.authenticationMethod,
        }
      : {}),
  };
}

async function getValidSessionFromTokens(
  tokens: StoredTokens | null,
): Promise<MainAuthSession | null> {
  if (!tokens) return null;
  if (tokens.expiresAt - Date.now() >= REFRESH_SKEW_MS) {
    return toMainSession(tokens);
  }
  const outcome = await refreshOnce();
  if (outcome.status === "ok") return toMainSession(outcome.tokens);
  if (outcome.status === "terminal") {
    const removed =
      outcome.expectedRaw !== undefined &&
      replaceSecretIfUnchanged(TOKENS_KEY, outcome.expectedRaw, null);
    if (removed) notifySessionChanged();
    const latest = readTokens();
    return latest ? toMainSession(latest) : null;
  }
  const latest = readTokens() ?? tokens;
  return latest.expiresAt - Date.now() > 0 ? toMainSession(latest) : null;
}

export async function getValidSessionForMain(): Promise<MainAuthSession | null> {
  return getValidSessionFromTokens(readTokens());
}

export async function getValidAccessTokenForMain(): Promise<string | null> {
  return (await getValidSessionForMain())?.accessToken ?? null;
}

export function getSessionUserForMain(): Omit<
  MainAuthSession,
  "accessToken"
> | null {
  const tokens = readTokens();
  if (!tokens) return null;
  const { accessToken: _accessToken, ...user } = toMainSession(tokens);
  return user;
}

/** Durable product/integration owner. Auth0 compatibility records fall back to
 * their provider subject; WorkOS records always carry the `/v1/me` account UUID. */
export function getProductAccountIdForMain(): string | null {
  const user = getSessionUserForMain();
  return user?.accountId ?? user?.sub ?? null;
}

/**
 * Remove a server-revoked WorkOS session without making another provider
 * request. Both stable identities must still match the captured monitor
 * binding, so a delayed SSE/401 from Session A cannot erase a replacement
 * Session B installed while the request was in flight.
 */
export function clearWorkOSSessionAfterServerRevocation(expected: {
  accountId: string;
  sessionId: string;
}): boolean {
  const snapshot = readTokenSnapshot();
  if (
    snapshot?.tokens.provider !== "workos" ||
    snapshot.tokens.accountId !== expected.accountId ||
    snapshot.tokens.sessionId !== expected.sessionId
  ) {
    return false;
  }
  const removed = replaceSecretIfUnchanged(TOKENS_KEY, snapshot.raw, null);
  if (removed) notifySessionChanged();
  return removed;
}

export const authGetAccessToken: CommandHandler = async () => {
  let tokens: StoredTokens | null;
  try {
    tokens = readTokens();
  } catch (error) {
    if (error instanceof SecretStoreReadError) return { access_token: null };
    throw error;
  }
  return {
    access_token:
      (await getValidSessionFromTokens(tokens))?.accessToken ?? null,
  };
};

export const authGetSessionUser: CommandHandler = () => {
  try {
    return getSessionUserForMain();
  } catch (error) {
    if (error instanceof SecretStoreReadError) return null;
    throw error;
  }
};

function sameAccount(left: StoredTokens, right: StoredTokens): boolean {
  return (left.accountId || left.sub) === (right.accountId || right.sub);
}

function clearCapturedSession(
  rawAtStart: string | null,
  snapshot: StoredTokenSnapshot | null,
  scope: "current" | "all",
): void {
  let removed =
    rawAtStart !== null &&
    replaceSecretIfUnchanged(TOKENS_KEY, rawAtStart, null);
  if (!removed && rawAtStart !== null) {
    const latest = readTokenSnapshot();
    const sameTarget =
      latest &&
      snapshot &&
      (scope === "all"
        ? sameAccount(latest.tokens, snapshot.tokens)
        : latest.tokens.provider === "workos" &&
          snapshot.tokens.provider === "workos" &&
          latest.tokens.sessionId === snapshot.tokens.sessionId);
    if (sameTarget && latest) {
      removed = replaceSecretIfUnchanged(TOKENS_KEY, latest.raw, null);
    }
  }
  if (removed) notifySessionChanged();
}

async function signOutWorkOS(scope: "current" | "all"): Promise<boolean> {
  const session = await getValidSessionForMain().catch(() => null);
  const rawAtStart = getSecret(TOKENS_KEY);
  const snapshot = parseStoredTokenSnapshot(rawAtStart);
  if (
    session?.provider === "workos" &&
    snapshot?.tokens.provider === "workos" &&
    session.sessionId === snapshot.tokens.sessionId
  ) {
    if (!(await requestWorkOSDesktopRevocation(scope, session.accessToken))) {
      console.warn("[auth] WorkOS revoke unavailable");
    }
  }
  clearCapturedSession(rawAtStart, snapshot, scope);
  return true;
}

export const authClearSession: CommandHandler = async () => {
  const snapshot = readTokenSnapshot();
  if (snapshot?.tokens.provider === "workos") {
    return signOutWorkOS("current");
  }
  deleteSecret(TOKENS_KEY);
  notifySessionChanged();
  return true;
};

async function signOutAuth0Everywhere(): Promise<boolean> {
  const rawAtStart = getSecret(TOKENS_KEY);
  const snapshot = parseStoredTokenSnapshot(rawAtStart);
  if (snapshot) {
    try {
      await fetch(`${appBaseUrl()}/handoff/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: snapshot.tokens.refreshToken }),
        signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      console.warn(
        `[auth] revoke network call failed: ${(error as Error).message}`,
      );
    }
  }
  clearCapturedSession(rawAtStart, snapshot, "all");
  return true;
}

export const authSignOutEverywhere: CommandHandler = async () => {
  const snapshot = readTokenSnapshot();
  return snapshot?.tokens.provider === "workos"
    ? signOutWorkOS("all")
    : signOutAuth0Everywhere();
};
