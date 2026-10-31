// Main-process-owned desktop authentication session. The persisted account
// name remains `auth-session:tokens` for compatibility; WorkOS adds provider,
// internal-account, client-kind, and session identity fields without exposing
// refresh material to renderer IPC.

import type { CommandHandler } from "../router";
import { IS_LOCAL_DEVELOPMENT } from "../../runtime-mode";
import {
  deleteSecret,
  getSecret,
  replaceSecretIfUnchanged,
  SecretStoreReadError,
  secretsFilePath,
  setSecret,
  updateSecretValues,
} from "../../secret-store";
import { withCrossProcessFileLock } from "../../cross-process-lock";
import { appBaseUrl } from "../../app-base-url";
import {
  mergeWorkOSRefresh,
  parseParkedSessions,
  parseStoredTokenSnapshot,
  serializeParkedSessions,
  type StoredTokens,
  type StoredTokenSnapshot,
  type WorkOSRefreshMerge,
  type WorkOSStoredTokens,
} from "../../auth-session-record";
import type { WorkOSDesktopSession } from "../../workos-desktop-client";
import { workOSDesktopClientForMain } from "../../workos-desktop-runtime";
import { requestWorkOSDesktopRevocation } from "../../workos-desktop-revocation";
import { controlPlaneFetch } from "../../control-plane-fetch";
import { channel } from "../../../src/engine/runtime";
import { desktopAuthConfig } from "../../workos-desktop-config";
import { devWorkOSConfigurationIssue, workspaceDevAuthProfile } from "../../dev-workos-auth-policy";
import { controlPlaneBaseUrl } from "../../workos-desktop-account";

const TOKENS_KEY = "auth-session:tokens";
// Other signed-in WorkOS accounts. The active account stays in TOKENS_KEY, so
// older builds and sibling Dev worktrees keep reading one session.
const PARKED_KEY = "auth-session:parked";
/** Signed-in accounts per device, the active one included. */
export const MAX_SIGNED_IN_ACCOUNTS = 12;
const REFRESH_SKEW_MS = 60_000;
const AUTH_REQUEST_TIMEOUT_MS = 15_000;
const SESSION_LOCK_OPTIONS = { staleAfterMs: 60_000, waitTimeoutMs: 65_000 };

/** Park times order accounts by recent use, so they never tie. */
function nextParkedAt(parked: ReadonlyMap<string, { parkedAt: number }>): number {
  let latest = 0;
  for (const entry of parked.values()) latest = Math.max(latest, entry.parkedAt);
  return Math.max(Date.now(), latest + 1);
}

/** The active and parked entries. One this device can no longer decrypt (for
 * example after a Keychain reset) reads as absent, as `getSecret` does. */
function readSessionEntries(): Record<string, string | null> {
  return { [TOKENS_KEY]: getSecret(TOKENS_KEY), [PARKED_KEY]: getSecret(PARKED_KEY) };
}

/** Write the active and parked entries in one transaction. An undecryptable
 * entry would block that transaction forever; it is unrecoverable, so it is
 * replaced entry by entry, as the single-session install always did. */
function updateSessionEntries(
  update: (values: Record<string, string | null>) => Record<string, string | null>,
): void {
  try {
    updateSecretValues([TOKENS_KEY, PARKED_KEY], update);
  } catch (error) {
    if (!(error instanceof SecretStoreReadError)) throw error;
    const next = update(readSessionEntries());
    for (const key of [TOKENS_KEY, PARKED_KEY]) {
      const value = next[key] ?? null;
      if (value === null) deleteSecret(key);
      else setSecret(key, value);
    }
  }
}

/** Serializes refresh rotation with every write that moves a session. */
function sessionLockPath(): string {
  return `${secretsFilePath()}.auth-session-refresh.lock`;
}

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

/** Enable the one-time Dev migration only after the full Alpha contract passes. */
function devUsesWorkOS(): boolean {
  if (channel() !== "dev") return false;
  try {
    return devWorkOSConfigurationIssue({
      auth: desktopAuthConfig(),
      appOrigin: appBaseUrl(),
      controlPlaneOrigin: controlPlaneBaseUrl(),
      localProfile: workspaceDevAuthProfile(),
      isolated: process.env.ZEROS_ISOLATE === "1",
    }) === null;
  } catch {
    return false;
  }
}

/** Read shared credentials, retiring only a matching legacy Dev snapshot and
 * preserving a WorkOS session concurrently installed by another worktree. */
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
 * enriched by authenticated `/v1/me`. It is intentionally not an IPC command.
 * Another account's active session is parked, not replaced. */
export async function persistWorkOSSession(
  input: WorkOSDesktopSession & { accountId: string },
): Promise<void> {
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
  const next: WorkOSStoredTokens = {
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
  };
  const retired: WorkOSStoredTokens[] = [];
  await withCrossProcessFileLock(sessionLockPath(), async () => {
    updateSessionEntries((values) => {
      // The fallback for an undecryptable entry may run this a second time.
      retired.length = 0;
      const active = parseStoredTokenSnapshot(values[TOKENS_KEY])?.tokens;
      const parked = parseParkedSessions(values[PARKED_KEY]);
      const replaced = parked.get(next.accountId);
      if (replaced) retired.push(replaced.tokens);
      parked.delete(next.accountId);
      if (active?.provider === "workos" && active.accountId !== next.accountId) {
        parked.set(active.accountId, { tokens: active, parkedAt: nextParkedAt(parked) });
      } else if (active?.provider === "workos" && active.sessionId !== next.sessionId) {
        // Signing the same account in again leaves no device holding the old session.
        retired.push(active);
      }
      // Keep the most recently used accounts within the device limit.
      const oldest = [...parked.values()].sort((a, b) => b.parkedAt - a.parkedAt)
        .slice(MAX_SIGNED_IN_ACCOUNTS - 1);
      for (const entry of oldest) {
        parked.delete(entry.tokens.accountId);
        retired.push(entry.tokens);
      }
      return {
        [TOKENS_KEY]: JSON.stringify(next),
        [PARKED_KEY]: serializeParkedSessions(parked),
      };
    });
  }, SESSION_LOCK_OPTIONS);
  notifySessionChanged();
  for (const tokens of retired) void revokeRetiredSession(tokens);
}

/** Best effort: a retired session the device no longer holds is revoked while
 * its bearer is live; otherwise provider policy ends it. */
async function revokeRetiredSession(tokens: WorkOSStoredTokens): Promise<void> {
  if (tokens.expiresAt <= Date.now()) return;
  await requestWorkOSDesktopRevocation("current", tokens.accessToken, controlPlaneFetch).catch(() => false);
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
      sessionLockPath(),
      async (): Promise<RefreshOutcome> => {
        const snapshot = readTokenSnapshot();
        if (!snapshot) return { status: "terminal" };
        if (snapshot.tokens.expiresAt - Date.now() >= REFRESH_SKEW_MS) {
          return { status: "ok", tokens: snapshot.tokens };
        }
        return refreshTokens(snapshot);
      },
      SESSION_LOCK_OPTIONS,
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
  if (IS_LOCAL_DEVELOPMENT) return null;
  return getValidSessionFromTokens(readTokens());
}

export async function getValidAccessTokenForMain(): Promise<string | null> {
  return (await getValidSessionForMain())?.accessToken ?? null;
}

export function getSessionUserForMain(): Omit<
  MainAuthSession,
  "accessToken"
> | null {
  if (IS_LOCAL_DEVELOPMENT) return null;
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

/** The bearer names its account, so a renderer read that straddles an
 * account switch can discard a token that belongs to the previous account. */
export const authGetAccessToken: CommandHandler = async () => {
  let tokens: StoredTokens | null;
  try {
    tokens = readTokens();
  } catch (error) {
    if (error instanceof SecretStoreReadError) return { access_token: null, account: null };
    throw error;
  }
  const session = await getValidSessionFromTokens(tokens);
  return {
    access_token: session?.accessToken ?? null,
    account: session ? session.accountId ?? session.sub : null,
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
        : (latest.tokens.provider === "auth0" && snapshot.tokens.provider === "auth0" &&
           latest.tokens.refreshToken === snapshot.tokens.refreshToken) ||
          latest.tokens.provider === "workos" &&
          snapshot.tokens.provider === "workos" &&
          latest.tokens.sessionId === snapshot.tokens.sessionId);
    if (sameTarget && latest) {
      removed = replaceSecretIfUnchanged(TOKENS_KEY, latest.raw, null);
    }
  }
  if (removed) notifySessionChanged();
}

async function signOutWorkOS(scope: "current" | "all"): Promise<boolean> {
  const rawAtStart = getSecret(TOKENS_KEY);
  const snapshot = parseStoredTokenSnapshot(rawAtStart);
  const session = await getValidSessionForMain().catch(() => null);
  let revoked = false;
  if (
    session?.provider === "workos" &&
    snapshot?.tokens.provider === "workos" &&
    session.sessionId === snapshot.tokens.sessionId
  ) {
    revoked = await requestWorkOSDesktopRevocation(scope, session.accessToken, controlPlaneFetch).catch(() => false);
    if (!revoked) {
      console.warn("[auth] WorkOS revoke unavailable");
    }
  }
  clearCapturedSession(rawAtStart, snapshot, scope);
  if (scope === "all" && !revoked) throw new Error("Signed out on this device. Could not sign out other devices. Sign in again to retry.");
  return true;
}

export const authClearSession: CommandHandler = async (args) => {
  const accountId = typeof args?.accountId === "string" ? args.accountId : null;
  const snapshot = readTokenSnapshot();
  if (
    accountId !== null &&
    !(snapshot?.tokens.provider === "workos" && snapshot.tokens.accountId === accountId)
  ) {
    return signOutParkedAccount(accountId);
  }
  if (snapshot?.tokens.provider === "workos") {
    await signOutWorkOS("current");
    await promoteNextParkedAccount();
    return true;
  }
  if (snapshot?.tokens.provider === "auth0" && snapshot.tokens.refreshToken.startsWith("z0d_")) {
    return signOutAuth0("current");
  }
  deleteSecret(TOKENS_KEY);
  notifySessionChanged();
  return true;
};

async function signOutAuth0(scope: "current" | "all"): Promise<boolean> {
  const rawAtStart = getSecret(TOKENS_KEY);
  const snapshot = parseStoredTokenSnapshot(rawAtStart);
  let revoked = false;
  if (snapshot) {
    try {
      const response = await fetch(`${appBaseUrl()}/handoff/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: snapshot.tokens.refreshToken, scope }),
        signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
      });
      revoked = response.ok;
    } catch {
      console.warn("[auth] revoke unavailable");
    }
  }
  clearCapturedSession(rawAtStart, snapshot, scope);
  if (scope === "all" && !revoked) throw new Error("Signed out on this device. Could not sign out other devices. Sign in again to retry.");
  return true;
}

export const authSignOutEverywhere: CommandHandler = async () => {
  const snapshot = readTokenSnapshot();
  if (snapshot?.tokens.provider !== "workos") return signOutAuth0("all");
  try {
    return await signOutWorkOS("all");
  } finally {
    await promoteNextParkedAccount();
  }
};

export interface SignedInAccount {
  accountId: string;
  email: string;
  name: string | null;
  active: boolean;
}

/** Signed-in accounts for presentation: the active one first, then the most
 * recently used. Never includes token material. */
export function listSignedInAccountsForMain(): SignedInAccount[] {
  if (IS_LOCAL_DEVELOPMENT) return [];
  const values = readSessionEntries();
  const active = parseStoredTokenSnapshot(values[TOKENS_KEY])?.tokens;
  const activeId = active ? active.accountId ?? active.sub : null;
  const accounts: SignedInAccount[] = active
    ? [{ accountId: activeId!, email: active.email, name: active.name, active: true }]
    : [];
  const parked = [...parseParkedSessions(values[PARKED_KEY]).values()]
    .sort((a, b) => b.parkedAt - a.parkedAt);
  for (const { tokens } of parked) {
    if (tokens.accountId === activeId) continue;
    accounts.push({ accountId: tokens.accountId, email: tokens.email, name: tokens.name, active: false });
  }
  return accounts;
}

/** Store a parked account's tokens, or remove the account with null. */
function writeParkedSession(accountId: string, tokens: WorkOSStoredTokens | null): void {
  updateSessionEntries((values) => {
    const parked = parseParkedSessions(values[PARKED_KEY]);
    const current = parked.get(accountId);
    if (!tokens) parked.delete(accountId);
    else parked.set(accountId, { tokens, parkedAt: current?.parkedAt ?? nextParkedAt(parked) });
    return { ...values, [PARKED_KEY]: serializeParkedSessions(parked) };
  });
}

/** Refresh a parked session without touching the active record. */
async function refreshParkedSession(tokens: WorkOSStoredTokens): Promise<WorkOSRefreshMerge> {
  try {
    const outcome = await workOSDesktopClientForMain().refresh({
      refreshToken: tokens.refreshToken,
      expectedSubject: tokens.sub,
      expectedSessionId: tokens.sessionId,
    });
    return mergeWorkOSRefresh(tokens, outcome);
  } catch (error) {
    console.warn(
      `[auth] WorkOS refresh unavailable for a parked account: ${(error as Error).message}`,
    );
    return { status: "transient", tokens };
  }
}

export type SwitchAccountOutcome =
  | "switched"
  | "current"
  | "missing"
  | "signed_out"
  | "unavailable";

/**
 * Make a parked account active and park the current one, in one write under
 * the refresh lock. An expiring target is refreshed first; a rejected refresh
 * removes only that account, and an unreachable provider leaves both as they
 * were, so a failed switch never signs out the account in use.
 */
export async function switchWorkOSAccount(
  accountId: string,
  options: { onlyIfSignedOut?: boolean } = {},
): Promise<SwitchAccountOutcome> {
  if (IS_LOCAL_DEVELOPMENT) return "unavailable";
  const outcome = await withCrossProcessFileLock(sessionLockPath(), async (): Promise<SwitchAccountOutcome> => {
    const values = readSessionEntries();
    const active = parseStoredTokenSnapshot(values[TOKENS_KEY])?.tokens;
    if (active?.provider === "workos" && active.accountId === accountId) return "current";
    if (active?.provider === "auth0") return "unavailable";
    // A sign-in that finished meanwhile wins over continuing after sign-out.
    if (options.onlyIfSignedOut && active) return "current";
    let tokens = parseParkedSessions(values[PARKED_KEY]).get(accountId)?.tokens;
    if (!tokens) return "missing";
    if (tokens.expiresAt - Date.now() < REFRESH_SKEW_MS) {
      const refreshed = await refreshParkedSession(tokens);
      if (refreshed.status === "terminal") {
        writeParkedSession(accountId, null);
        return "signed_out";
      }
      // A rotated refresh token must survive even when the switch stops here.
      if (refreshed.tokens !== tokens) writeParkedSession(accountId, refreshed.tokens);
      tokens = refreshed.tokens;
      if (refreshed.status === "transient" && tokens.expiresAt <= Date.now()) return "unavailable";
    }
    const target = tokens;
    updateSessionEntries((current) => {
      const nowActive = parseStoredTokenSnapshot(current[TOKENS_KEY])?.tokens;
      const parked = parseParkedSessions(current[PARKED_KEY]);
      parked.delete(accountId);
      if (nowActive?.provider === "workos" && nowActive.accountId !== accountId) {
        parked.set(nowActive.accountId, { tokens: nowActive, parkedAt: nextParkedAt(parked) });
      }
      return {
        [TOKENS_KEY]: JSON.stringify(target),
        [PARKED_KEY]: serializeParkedSessions(parked),
      };
    });
    return "switched";
  }, SESSION_LOCK_OPTIONS);
  if (outcome === "switched" || outcome === "signed_out") notifySessionChanged();
  return outcome;
}

/** After the active account signs out, continue with the most recently used
 * parked account that can still sign in; otherwise stay signed out. */
async function promoteNextParkedAccount(): Promise<void> {
  try {
    if (readTokens()) return;
    const candidates = listSignedInAccountsForMain().filter((account) => !account.active);
    for (const candidate of candidates) {
      const outcome = await switchWorkOSAccount(candidate.accountId, { onlyIfSignedOut: true });
      if (outcome !== "signed_out" && outcome !== "missing") return;
    }
  } catch (error) {
    // Sign-out already succeeded; the login screen still offers these accounts.
    console.warn(`[auth] next account unavailable after sign-out: ${(error as Error).message}`);
  }
}

/** Remove a parked account on this device and revoke its session. */
async function signOutParkedAccount(accountId: string): Promise<boolean> {
  let revocable: WorkOSStoredTokens | null = null;
  await withCrossProcessFileLock(sessionLockPath(), async () => {
    let tokens = parseParkedSessions(readSessionEntries()[PARKED_KEY]).get(accountId)?.tokens;
    if (!tokens) return;
    // Revocation needs a live bearer; an already rejected session needs none.
    if (tokens.expiresAt - Date.now() < REFRESH_SKEW_MS) {
      const refreshed = await refreshParkedSession(tokens);
      tokens = refreshed.status === "active" ? refreshed.tokens : undefined;
    }
    revocable = tokens ?? null;
    writeParkedSession(accountId, null);
  }, SESSION_LOCK_OPTIONS);
  const tokens = revocable as WorkOSStoredTokens | null;
  if (tokens) {
    const revoked = await requestWorkOSDesktopRevocation("current", tokens.accessToken, controlPlaneFetch).catch(() => false);
    if (!revoked) console.warn("[auth] WorkOS revoke unavailable for a parked account");
  }
  return true;
}

export const authListAccounts: CommandHandler = () => {
  try {
    return { accounts: listSignedInAccountsForMain() };
  } catch (error) {
    if (error instanceof SecretStoreReadError) return { accounts: [] };
    throw error;
  }
};

export const authSwitchAccount: CommandHandler = async (args) => {
  const accountId = typeof args?.accountId === "string" ? args.accountId : "";
  if (!accountId || accountId.length > 128) throw new Error("Choose a signed-in account");
  return { status: await switchWorkOSAccount(accountId) };
};
