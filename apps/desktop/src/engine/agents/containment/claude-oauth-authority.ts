import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, rm } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";

import { zerosStateRoot } from "../../db/paths";

const CLAUDE_OAUTH_TOKEN_ENDPOINT =
  "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ACCESS_EXPIRY_SKEW_MS = 5 * 60_000;
const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const MAX_KEYCHAIN_COMMAND_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 64 * 1024;
const MAX_REFRESH_RESPONSE_BYTES = 64 * 1024;
const REFRESH_TIMEOUT_MS = 15_000;
const REFRESH_TRANSIENT_ATTEMPTS = 2;
const REFRESH_TRANSIENT_RETRY_DELAY_MS = 750;
const SAFE_REFRESH_FAILURES = new Set([
  "Claude OAuth refresh request failed",
  "Claude OAuth refresh request was rejected",
  "Claude OAuth refresh response was invalid",
  "Claude OAuth refresh response exceeded its size limit",
]);
/** Network faults, rate limits, and server errors leave the stored rotating
 * token valid, so they may be retried; a definitive rejection may not. */
const TRANSIENT_REFRESH_FAILURE = "Claude OAuth refresh request failed";

export type ClaudeCredentialReadResult =
  | { readonly status: "available"; readonly value: string }
  | { readonly status: "absent" }
  | { readonly status: "unavailable" };

export interface ClaudeOAuthRefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

interface ClaudeOAuthRecord extends Record<string, unknown> {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

interface ClaudeCredentialDocument extends Record<string, unknown> {
  claudeAiOauth: ClaudeOAuthRecord;
}

export interface ClaudeOAuthAuthorityDependencies {
  readonly readCredential: () => Promise<ClaudeCredentialReadResult>;
  /** Atomically reconcile `next` against the exact credential that produced
   * its single-use refresh token. A cross-process winner may be returned. */
  readonly commitCredential: (
    previous: string,
    next: string,
  ) => Promise<string>;
  readonly refreshToken: (
    refreshToken: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<ClaudeOAuthRefreshResult>;
  readonly withRefreshLock?: <T>(task: () => Promise<T>) => Promise<T>;
  readonly now?: () => number;
}

function safeToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= MAX_TOKEN_BYTES
  );
}

function parseCredential(raw: string): ClaudeCredentialDocument {
  if (Buffer.byteLength(raw) > MAX_CREDENTIAL_BYTES) {
    throw new Error("Claude OAuth credential exceeded its size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Claude OAuth credential was invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Claude OAuth credential was invalid");
  }
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) {
    throw new Error("Claude OAuth credential was invalid");
  }
  const record = oauth as Record<string, unknown>;
  if (!safeToken(record.accessToken)) {
    throw new Error("Claude OAuth credential was invalid");
  }
  if (record.refreshToken !== undefined && !safeToken(record.refreshToken)) {
    throw new Error("Claude OAuth credential was invalid");
  }
  if (
    record.expiresAt !== undefined &&
    (!Number.isSafeInteger(record.expiresAt) || Number(record.expiresAt) <= 0)
  ) {
    throw new Error("Claude OAuth credential was invalid");
  }
  return parsed as ClaudeCredentialDocument;
}

function serializedCredential(document: ClaudeCredentialDocument): string {
  const value = JSON.stringify(document);
  if (Buffer.byteLength(value) > MAX_CREDENTIAL_BYTES) {
    throw new Error("Claude OAuth credential exceeded its size limit");
  }
  return value;
}

function credentialNeedsRefresh(
  document: ClaudeCredentialDocument,
  now: number,
): boolean {
  const expiresAt = document.claudeAiOauth.expiresAt;
  return (
    !Number.isSafeInteger(expiresAt) ||
    Number(expiresAt) <= now + ACCESS_EXPIRY_SKEW_MS
  );
}

function sameCredentialIdentity(
  left: ClaudeCredentialDocument,
  right: ClaudeCredentialDocument,
): boolean {
  return (
    left.claudeAiOauth.accessToken === right.claudeAiOauth.accessToken &&
    left.claudeAiOauth.refreshToken === right.claudeAiOauth.refreshToken &&
    left.claudeAiOauth.expiresAt === right.claudeAiOauth.expiresAt
  );
}

function projectedCredential(document: ClaudeCredentialDocument): string {
  const oauth = { ...document.claudeAiOauth };
  delete oauth.refreshToken;
  return serializedCredential({ ...document, claudeAiOauth: oauth });
}

function safeRefreshResult(value: ClaudeOAuthRefreshResult): boolean {
  return (
    safeToken(value.accessToken) &&
    safeToken(value.refreshToken) &&
    Number.isSafeInteger(value.expiresIn) &&
    value.expiresIn >= 60 &&
    value.expiresIn <= 7 * 24 * 60 * 60
  );
}

function timeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Claude OAuth refresh timed out")),
    timeoutMs,
  );
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

export class ClaudeOAuthAuthority {
  private refreshInFlight: Promise<string> | null = null;
  private readonly now: () => number;

  constructor(private readonly dependencies: ClaudeOAuthAuthorityDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async readProjectedCredential(options?: {
    readonly signal?: AbortSignal;
  }): Promise<ClaudeCredentialReadResult> {
    const source = await this.dependencies.readCredential();
    if (source.status !== "available") return source;
    const current = parseCredential(source.value);
    let raw = source.value;
    if (credentialNeedsRefresh(current, this.now())) {
      try {
        raw = await this.refreshCurrent(source.value, options?.signal);
      } catch (error) {
        const fallback = await this.stillValidCurrentCredential(error);
        if (fallback === null) throw error;
        raw = fallback;
      }
    }
    return {
      status: "available",
      value: projectedCredential(parseCredential(raw)),
    };
  }

  async getAccessToken(options?: {
    readonly forceRefresh?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<string | null> {
    const source = await this.dependencies.readCredential();
    if (source.status !== "available") return null;
    const current = parseCredential(source.value);
    const mustRefresh =
      options?.forceRefresh === true ||
      credentialNeedsRefresh(current, this.now());
    if (!mustRefresh) return current.claudeAiOauth.accessToken;
    if (!current.claudeAiOauth.refreshToken) return null;
    try {
      const raw = await this.refreshCurrent(source.value, options?.signal);
      return parseCredential(raw).claudeAiOauth.accessToken;
    } catch (error) {
      // forceRefresh callers have proven the current access token dead; only
      // skew-triggered proactive refreshes may keep serving the live token.
      if (options?.forceRefresh === true) throw error;
      const fallback = await this.stillValidCurrentCredential(error);
      if (fallback === null) throw error;
      return parseCredential(fallback).claudeAiOauth.accessToken;
    }
  }

  /** A failed proactive refresh must not take down work the stored access
   * token can still authorize. Returns the raw credential when its access
   * token has not actually expired (ignoring the proactive skew), or null when
   * the failure has to propagate. */
  private async stillValidCurrentCredential(
    error: unknown,
  ): Promise<string | null> {
    if (
      !(error instanceof Error) ||
      error.message === "Claude OAuth credential refresh was cancelled"
    ) {
      return null;
    }
    const source = await this.dependencies.readCredential();
    if (source.status !== "available") return null;
    const current = parseCredential(source.value);
    const expiresAt = current.claudeAiOauth.expiresAt;
    if (!Number.isSafeInteger(expiresAt) || Number(expiresAt) <= this.now()) {
      return null;
    }
    return source.value;
  }

  private refreshCurrent(
    observedRaw: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    // Cancellation is an admission decision, not ownership of the shared
    // rotating-token refresh. A caller that is already cancelled must not
    // create a rejected single-flight promise that a simultaneous healthy
    // caller then inherits. Once admitted, the host authority completes the
    // refresh under its own deadline because abandoning a consumed rotating
    // token could lose the only valid successor credential.
    if (signal?.aborted) {
      return Promise.reject(
        new Error("Claude OAuth credential refresh was cancelled"),
      );
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refreshOnce(observedRaw).finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  private async refreshOnce(observedRaw: string): Promise<string> {
    const task = () => this.refreshOnceLocked(observedRaw);
    return this.dependencies.withRefreshLock
      ? this.dependencies.withRefreshLock(task)
      : task();
  }

  private async refreshOnceLocked(observedRaw: string): Promise<string> {
    let source = await this.dependencies.readCredential();
    if (source.status !== "available") {
      throw new Error("Claude OAuth credential became unavailable");
    }
    let current = parseCredential(source.value);
    const observed = parseCredential(observedRaw);
    if (
      !sameCredentialIdentity(current, observed) &&
      !credentialNeedsRefresh(current, this.now())
    ) {
      return source.value;
    }
    let refreshed: ClaudeOAuthRefreshResult | undefined;
    for (let attempt = 1; refreshed === undefined; attempt++) {
      const refreshToken = current.claudeAiOauth.refreshToken;
      if (!refreshToken) {
        throw new Error("Claude OAuth refresh token is unavailable");
      }
      // Once a rotating-token POST starts, a caller cancellation must not abort
      // the shared refresh and discard a response that may contain the only valid
      // successor token. The authority's own deadline remains mandatory.
      const timed = timeoutSignal(undefined, REFRESH_TIMEOUT_MS);
      try {
        const candidate = await this.dependencies.refreshToken(refreshToken, {
          signal: timed.signal,
        });
        if (!safeRefreshResult(candidate)) {
          throw new Error("invalid refresh response");
        }
        refreshed = candidate;
      } catch (error) {
        // A competing Claude/SDK process may have consumed the rotating token.
        // Prefer its newly committed, still-valid Keychain value rather than
        // turning a harmless race into a login prompt.
        const reread = await this.dependencies.readCredential();
        if (reread.status === "available") {
          const winner = parseCredential(reread.value);
          if (
            !sameCredentialIdentity(winner, current) &&
            !credentialNeedsRefresh(winner, this.now())
          ) {
            return reread.value;
          }
          // A rotated-but-expiring winner still carries the only valid
          // successor token, so a retry must consume the re-read credential.
          source = reread;
          current = winner;
        }
        if (
          error instanceof Error &&
          error.message === TRANSIENT_REFRESH_FAILURE &&
          attempt < REFRESH_TRANSIENT_ATTEMPTS
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, REFRESH_TRANSIENT_RETRY_DELAY_MS),
          );
          continue;
        }
        if (
          error instanceof Error &&
          SAFE_REFRESH_FAILURES.has(error.message)
        ) {
          throw new Error(error.message);
        }
        throw new Error("Claude OAuth refresh provider failed");
      } finally {
        timed.dispose();
      }
    }
    const expiresAt = this.now() + refreshed.expiresIn * 1000;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new Error("Claude OAuth refresh expiry was invalid");
    }
    const next = serializedCredential({
      ...current,
      claudeAiOauth: {
        ...current.claudeAiOauth,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt,
      },
    });
    try {
      const committed = await this.dependencies.commitCredential(
        source.value,
        next,
      );
      current = parseCredential(committed);
      if (credentialNeedsRefresh(current, this.now())) {
        throw new Error("committed credential is expired");
      }
      return committed;
    } catch {
      throw new Error("Claude OAuth credential persistence failed");
    }
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_REFRESH_RESPONSE_BYTES) {
    throw new Error("Claude OAuth refresh response exceeded its size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REFRESH_RESPONSE_BYTES) {
        throw new Error(
          "Claude OAuth refresh response exceeded its size limit",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function requestClaudeOAuthRefresh(
  refreshToken: string,
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly signal?: AbortSignal;
  } = {},
): Promise<ClaudeOAuthRefreshResult> {
  if (!safeToken(refreshToken)) {
    throw new Error("Claude OAuth refresh credential was invalid");
  }
  const timed = timeoutSignal(options.signal, REFRESH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(CLAUDE_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: timed.signal,
    });
  } catch {
    timed.dispose();
    throw new Error("Claude OAuth refresh request failed");
  }
  try {
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      // Only a definitive client rejection proves the stored token is no
      // longer accepted; rate limits and server faults must surface as
      // retryable failures instead of demanding a re-login.
      throw new Error(
        response.status === 400 ||
        response.status === 401 ||
        response.status === 403
          ? "Claude OAuth refresh request was rejected"
          : TRANSIENT_REFRESH_FAILURE,
      );
    }
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Claude OAuth refresh response was invalid");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await boundedResponseText(response));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          "Claude OAuth refresh response exceeded its size limit"
      ) {
        throw error;
      }
      throw new Error("Claude OAuth refresh response was invalid");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Claude OAuth refresh response was invalid");
    }
    const value = parsed as Record<string, unknown>;
    const result = {
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresIn: value.expires_in,
    } as ClaudeOAuthRefreshResult;
    if (!safeRefreshResult(result)) {
      throw new Error("Claude OAuth refresh response was invalid");
    }
    return result;
  } finally {
    timed.dispose();
  }
}

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_TIMEOUT_MS = 5_000;
const REFRESH_LOCK_WAIT_MS = 30_000;
const REFRESH_LOCK_STALE_MS = 60_000;
const REFRESH_LOCK_RETRY_MS = 50;
const defaultAuthorities = new Map<string, ClaudeOAuthAuthority>();

function keychainEnvironment(hostHome: string): NodeJS.ProcessEnv {
  return {
    HOME: hostHome,
    PATH: "/usr/bin:/bin",
    ...(process.env.USER ? { USER: process.env.USER } : {}),
    ...(process.env.LOGNAME ? { LOGNAME: process.env.LOGNAME } : {}),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
  };
}

function macAccountName(): string {
  try {
    const account = userInfo().username.trim();
    if (account && !account.includes("\0")) return account;
  } catch {
    // Fall through to the launch environment used by the macOS app.
  }
  const account = (process.env.USER ?? process.env.LOGNAME ?? "").trim();
  if (!account || account.includes("\0")) {
    throw new Error("Claude Keychain account is unavailable");
  }
  return account;
}

async function readMacClaudeCredential(
  hostHome: string,
  account: string,
): Promise<ClaudeCredentialReadResult> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-a",
        account,
        "-w",
        "-s",
        CLAUDE_KEYCHAIN_SERVICE,
      ],
      {
        encoding: "utf8",
        timeout: KEYCHAIN_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: MAX_CREDENTIAL_BYTES + 4096,
        env: keychainEnvironment(hostHome),
      },
      (error, stdout) => {
        if (!error) {
          resolve({ status: "available", value: stdout.trim() });
          return;
        }
        const exitCode = (error as NodeJS.ErrnoException).code;
        resolve(
          String(exitCode) === "44"
            ? { status: "absent" }
            : { status: "unavailable" },
        );
      },
    );
  });
}

async function writeMacClaudeCredential(
  hostHome: string,
  account: string,
  value: string,
): Promise<void> {
  if (
    Buffer.byteLength(value) > MAX_KEYCHAIN_COMMAND_BYTES ||
    value.includes("\n")
  ) {
    throw new Error("Claude Keychain credential was invalid");
  }
  await new Promise<void>((resolve, reject) => {
    // Match the pinned Claude runtime's macOS persistence path: Apple's
    // `security add-generic-password -U ... -X <hex>`. `-w` without a password
    // cannot consume a pipe and silently stores an empty item; Security.framework
    // prompts for a new executable. The engine never shells out, captures, or
    // logs this argv, and contained processes cannot access host process/keychain
    // authority. Keep the credential bound small enough for macOS ARG_MAX.
    const child = spawn(
      "/usr/bin/security",
      [
        "add-generic-password",
        "-U",
        "-a",
        account,
        "-s",
        CLAUDE_KEYCHAIN_SERVICE,
        "-X",
        Buffer.from(value, "utf8").toString("hex"),
      ],
      {
        env: keychainEnvironment(hostHome),
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Claude Keychain update timed out"));
    }, KEYCHAIN_TIMEOUT_MS);
    timeout.unref?.();
    child.once("error", () =>
      finish(new Error("Claude Keychain update failed")),
    );
    child.once("close", (code) =>
      finish(
        code === 0 ? undefined : new Error("Claude Keychain update failed"),
      ),
    );
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function inspectMacClaudeRefreshLock(
  lockPath: string,
): Promise<"absent" | "present" | "retired"> {
  let staleHandle;
  try {
    staleHandle = await open(lockPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw new Error("Claude OAuth refresh lock is unavailable");
  }
  try {
    const metadata = await staleHandle.stat();
    const current = await lstat(lockPath);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      current.isSymbolicLink() ||
      current.dev !== metadata.dev ||
      current.ino !== metadata.ino
    ) {
      throw new Error("Claude OAuth refresh lock is unsafe");
    }
    if (
      metadata.size > 256 ||
      Date.now() - metadata.mtimeMs <= REFRESH_LOCK_STALE_MS
    ) {
      return "present";
    }
    let retireStaleLock = metadata.size === 0;
    if (!retireStaleLock) {
      try {
        const parsed = JSON.parse(await staleHandle.readFile("utf8")) as {
          version?: unknown;
          pid?: unknown;
        };
        retireStaleLock =
          parsed.version === 1 &&
          Number.isSafeInteger(parsed.pid) &&
          Number(parsed.pid) > 0 &&
          !isProcessAlive(Number(parsed.pid));
      } catch {
        // A crash between O_EXCL creation and the fsynced owner record can
        // leave an empty or partial JSON file. Every production task holding
        // this lock has a deadline well below the stale window, so an old
        // malformed record cannot represent a valid owner.
        retireStaleLock = true;
      }
    }
    if (!retireStaleLock) return "present";
    const beforeRetire = await lstat(lockPath);
    if (
      beforeRetire.isSymbolicLink() ||
      beforeRetire.dev !== metadata.dev ||
      beforeRetire.ino !== metadata.ino
    ) {
      return "present";
    }
    await rm(lockPath, { force: true });
    return "retired";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw new Error("Claude OAuth refresh lock is unavailable");
  } finally {
    await staleHandle.close();
  }
}

export async function withMacClaudeRefreshLock<T>(
  task: () => Promise<T>,
  options: { readonly lockRoot?: string } = {},
): Promise<T> {
  const lockRoot =
    options.lockRoot ?? path.join(zerosStateRoot(), "credentials");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  await chmod(lockRoot, 0o700);
  const lockPath = path.join(lockRoot, "claude-oauth-refresh.lock");
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  while (true) {
    const existing = await inspectMacClaudeRefreshLock(lockPath);
    if (existing === "retired") continue;
    if (existing === "present") {
      if (Date.now() >= deadline) {
        throw new Error("Claude OAuth refresh lock timed out");
      }
      await new Promise((resolve) =>
        setTimeout(resolve, REFRESH_LOCK_RETRY_MS),
      );
      continue;
    }

    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }

    // Keep lock acquisition separate from the protected task. In particular,
    // an unrelated task error whose code happens to be EEXIST must propagate;
    // it is not evidence that another process owns this lock.
    let owned;
    let outcome:
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: unknown };
    try {
      owned = await handle.stat();
      await handle.writeFile(
        `${JSON.stringify({ version: 1, pid: process.pid, at: Date.now() })}\n`,
        "utf8",
      );
      await handle.sync();
      outcome = { ok: true, value: await task() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    let cleanupFailure: unknown;
    try {
      if (owned) {
        const current = await lstat(lockPath);
        if (current.dev === owned.dev && current.ino === owned.ino) {
          await rm(lockPath, { force: true });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        cleanupFailure = error;
      }
    }
    await handle.close().catch((error) => {
      cleanupFailure ??= error;
    });
    if (cleanupFailure) {
      if (!outcome.ok) {
        throw new AggregateError(
          [outcome.error, cleanupFailure],
          "Claude OAuth refresh failed and its lock cleanup was not proven",
        );
      }
      throw cleanupFailure;
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}

async function commitMacClaudeCredential(
  hostHome: string,
  account: string,
  previousRaw: string,
  nextRaw: string,
): Promise<string> {
  const previous = parseCredential(previousRaw);
  const next = parseCredential(nextRaw);
  const currentSource = await readMacClaudeCredential(hostHome, account);
  if (currentSource.status !== "available") {
    throw new Error("Claude Keychain update failed");
  }
  const current = parseCredential(currentSource.value);
  if (!sameCredentialIdentity(current, previous)) {
    return currentSource.value;
  }
  await writeMacClaudeCredential(hostHome, account, nextRaw);
  const verifiedSource = await readMacClaudeCredential(hostHome, account);
  if (verifiedSource.status !== "available") {
    throw new Error("Claude Keychain update verification failed");
  }
  const verified = parseCredential(verifiedSource.value);
  if (
    !sameCredentialIdentity(verified, next) &&
    credentialNeedsRefresh(verified, Date.now())
  ) {
    throw new Error("Claude Keychain update verification failed");
  }
  return verifiedSource.value;
}

/** Trusted-engine authority for the exact Claude Code macOS Keychain item.
 * The rotating Claude refresh token stays in Keychain and is serialized across
 * Zeros Dev processes; SDK refresh callbacks receive only the access token. */
export function defaultMacClaudeOAuthAuthority(
  hostHome: string = homedir(),
): ClaudeOAuthAuthority | null {
  if (process.platform !== "darwin") return null;
  const account = macAccountName();
  const key = createHash("sha256")
    .update(`${hostHome}\0${account}`)
    .digest("hex");
  const existing = defaultAuthorities.get(key);
  if (existing) return existing;
  const authority = new ClaudeOAuthAuthority({
    readCredential: () => readMacClaudeCredential(hostHome, account),
    commitCredential: (previous, next) =>
      commitMacClaudeCredential(hostHome, account, previous, next),
    refreshToken: (refreshToken, options) =>
      requestClaudeOAuthRefresh(refreshToken, options),
    withRefreshLock: withMacClaudeRefreshLock,
  });
  defaultAuthorities.set(key, authority);
  return authority;
}
