// ──────────────────────────────────────────────────────────
// The Cua Driver as a private child of Zeros
// ──────────────────────────────────────────────────────────
//
// Zeros starts its own copy of the Cua Driver on first use. The child talks to
// Zeros only over stdio and opens no socket, so nothing else on the Mac can
// drive it, and macOS attributes its Accessibility and Screen Recording use to
// Zeros. The runtime accepts Standard sessions only, telemetry is off, and the
// child gets a private HOME instead of the user's.
//
// The SDK is ESM with a native library, so main imports it only on first use.
// ──────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  PrivateWorkerOptions,
  SessionPermissionMode,
  TrustedSessionOptions,
} from "@trycua/cua-driver";

import {
  ComputerDriverLostError,
  type ComputerDriverHost,
  type ComputerDriverResult,
  type ComputerDriverSession,
} from "./ports";

interface CallOptions {
  signal: AbortSignal;
}

/** A tool result as the SDK returns it. */
export interface CuaToolResult {
  text: string;
  images: ReadonlyArray<{ mimeType: string; dataBase64: string }>;
  structuredJson?: string;
  isError: boolean;
  errorCode?: string;
}

export interface CuaWorker {
  metadata(options?: CallOptions): Promise<unknown>;
  shutdown(options?: CallOptions): Promise<void>;
}

export interface CuaTrustedSession {
  callTool(
    name: string,
    argumentsJson: string,
    options?: CallOptions,
  ): Promise<CuaToolResult>;
  close(): void;
}

/** The parts of `@trycua/cua-driver` Zeros uses. */
export interface CuaSdk {
  CuaDriver: {
    createPrivateWorker(options: PrivateWorkerOptions): CuaWorker;
  };
  createTrustedSession(
    driver: CuaWorker,
    options: TrustedSessionOptions,
  ): CuaTrustedSession;
  SessionPermissionMode: { readonly Standard: SessionPermissionMode };
  DriverError: { instanceOf(value: unknown): boolean };
  /** Prompts for Accessibility and Screen Recording on behalf of Zeros. */
  requestMacOsPermissions(): { accessibility: boolean; screenRecording: boolean };
}

export interface CuaDriverHostOptions {
  loadSdk(): Promise<CuaSdk>;
  /** The staged `cua-driver` executable, or null when this build has none. */
  binaryPath(): string | null;
  /** The bundle ID macOS knows Zeros by. */
  hostBundleId: string;
  /** The driver's HOME, private to Zeros. */
  home: string;
  inheritStderr?: boolean;
  /** Delays before each restart after the driver stopped unexpectedly. The
   * last one repeats. A call that succeeds resets the count. */
  restartBackoffMs?: readonly number[];
  sessionTtlSeconds?: number;
  sessionIdleTtlSeconds?: number;
  now?(): number;
  log?(message: string): void;
}

const DEFAULT_RESTART_BACKOFF_MS = [0, 1_000, 5_000, 15_000, 30_000] as const;
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60;
const DEFAULT_SESSION_IDLE_TTL_SECONDS = 15 * 60;
const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;
/** The worker's stdio channel is gone or unusable. */
const LOST_TAGS = new Set(["Worker", "Transport", "Shutdown", "Protocol"]);
const UNAVAILABLE =
  "Computer use is unavailable in this copy of Zeros. Reinstall Zeros and try again.";

/** Which `DriverError` this is, by its tag, or null for any other error. */
function driverErrorTag(sdk: CuaSdk, error: unknown): string | null {
  if (!sdk.DriverError.instanceOf(error)) return null;
  const tag = (error as { tag?: unknown }).tag;
  return typeof tag === "string" ? tag : null;
}

function innerText(error: unknown, key: string): string {
  const inner = (error as { inner?: unknown }).inner;
  if (!inner || typeof inner !== "object") return "";
  const value = (inner as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function structuredJson(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function cuaDriverResult(result: CuaToolResult): ComputerDriverResult {
  return {
    isError: result.isError === true,
    errorCode:
      typeof result.errorCode === "string" && result.errorCode
        ? result.errorCode
        : null,
    text: typeof result.text === "string" ? result.text : "",
    structured: structuredJson(result.structuredJson),
    images: Array.isArray(result.images)
      ? result.images.flatMap((image) =>
          typeof image?.dataBase64 === "string" &&
          typeof image.mimeType === "string"
            ? [{ data: image.dataBase64, mimeType: image.mimeType }]
            : [],
        )
      : [],
  };
}

/** A refusal the driver raised as an error rather than a result. */
function toolFailure(tag: string, error: unknown): ComputerDriverResult {
  const result = (errorCode: string | null, text: string): ComputerDriverResult => ({
    isError: true,
    errorCode,
    text,
    structured: null,
    images: [],
  });
  switch (tag) {
    case "Tool":
      return result(
        innerText(error, "errorCode") || null,
        innerText(error, "message"),
      );
    case "InvalidArguments":
      return result("invalid_arguments", innerText(error, "reason"));
    case "ActionInterrupted":
      return result(
        "action_interrupted",
        innerText(error, "reason") || "The action was interrupted.",
      );
    default:
      return result(tag.toLowerCase(), innerText(error, "reason"));
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The computer action was cancelled.");
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createCuaDriverHost(
  options: CuaDriverHostOptions,
): ComputerDriverHost {
  const backoff = options.restartBackoffMs?.length
    ? options.restartBackoffMs
    : DEFAULT_RESTART_BACKOFF_MS;
  const now = options.now ?? Date.now;
  const sessionTtl = BigInt(
    options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
  );
  const idleTtl = BigInt(
    options.sessionIdleTtlSeconds ?? DEFAULT_SESSION_IDLE_TTL_SECONDS,
  );
  let sdk: CuaSdk | null = null;
  let worker: CuaWorker | null = null;
  let losses = 0;
  let lostAt = 0;
  const open = new Set<() => void>();

  const closeSessions = () => {
    for (const close of [...open]) close();
  };

  /** Forget a worker whose channel broke. The next session starts another
   * after the backoff. */
  const lose = (lost: CuaWorker) => {
    if (worker !== lost) return;
    worker = null;
    losses += 1;
    lostAt = now();
    closeSessions();
    void lost.shutdown().catch(() => undefined);
  };

  const loadSdk = async (): Promise<CuaSdk> => {
    if (sdk) return sdk;
    try {
      sdk = await options.loadSdk();
    } catch (error) {
      options.log?.(
        `computer-use driver SDK failed to load: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new Error(UNAVAILABLE);
    }
    return sdk;
  };

  const start = async (
    loaded: CuaSdk,
    signal: AbortSignal,
  ): Promise<CuaWorker> => {
    if (losses > 0) {
      const wait =
        (backoff[Math.min(losses - 1, backoff.length - 1)] ?? 0) -
        (now() - lostAt);
      if (wait > 0) await delay(wait, signal);
    }
    if (worker) return worker;
    if (signal.aborted) throw abortReason(signal);
    const binaryPath = options.binaryPath();
    if (!binaryPath) {
      options.log?.(
        "computer-use driver executable is missing; a checkout stages it with `pnpm stage:cua-driver`",
      );
      throw new Error(UNAVAILABLE);
    }
    try {
      worker = loaded.CuaDriver.createPrivateWorker({
        binaryPath,
        hostBundleId: options.hostBundleId,
        startupTimeoutMs: BigInt(STARTUP_TIMEOUT_MS),
        shutdownTimeoutMs: BigInt(SHUTDOWN_TIMEOUT_MS),
        configuredDriver: {
          claudeCodeCompatibility: false,
          authorization: {
            allowedModes: [loaded.SessionPermissionMode.Standard],
            compatibilityMode: loaded.SessionPermissionMode.Standard,
            unrestrictedAcknowledged: false,
            maxSessionTtlSeconds: sessionTtl,
            maxIdleTtlSeconds: idleTtl,
          },
        },
        // The driver accepts only variables on its own allowlist.
        environment: [
          { name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "0" },
          { name: "CUA_TELEMETRY_ENABLED", value: "false" },
          { name: "HOME", value: options.home },
        ],
        inheritStderr: options.inheritStderr === true,
      });
    } catch (error) {
      losses += 1;
      lostAt = now();
      const tag = driverErrorTag(loaded, error);
      options.log?.(
        `computer-use driver failed to start: ${
          tag ? `${tag} ${innerText(error, "reason")}` : String(error)
        }`,
      );
      throw new ComputerDriverLostError(
        "Computer use could not start. Try again.",
      );
    }
    return worker;
  };

  /** A running worker that still answers. A worker that died while idle is
   * replaced before any session is handed out. */
  const healthyWorker = async (
    loaded: CuaSdk,
    signal: AbortSignal,
  ): Promise<CuaWorker> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = worker ?? (await start(loaded, signal));
      try {
        await current.metadata({ signal });
        return current;
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        const tag = driverErrorTag(loaded, error);
        if (!tag || !LOST_TAGS.has(tag)) throw error;
        lose(current);
      }
    }
    throw new ComputerDriverLostError();
  };

  /** After an interrupted action, whether the worker is still there. */
  const stillRunning = async (
    loaded: CuaSdk,
    current: CuaWorker,
  ): Promise<boolean> => {
    if (worker !== current) return false;
    try {
      await current.metadata();
      return true;
    } catch (error) {
      const tag = driverErrorTag(loaded, error);
      return !tag || !LOST_TAGS.has(tag);
    }
  };

  return {
    async openSession(label, signal) {
      const loaded = await loadSdk();
      const current = await healthyWorker(loaded, signal);
      let session: CuaTrustedSession;
      try {
        session = loaded.createTrustedSession(current, {
          publicSession: label,
          mode: loaded.SessionPermissionMode.Standard,
          ttlSeconds: sessionTtl,
          idleTtlSeconds: idleTtl,
        });
      } catch (error) {
        const tag = driverErrorTag(loaded, error);
        if (tag && LOST_TAGS.has(tag)) {
          lose(current);
          throw new ComputerDriverLostError();
        }
        throw error;
      }
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        open.delete(close);
        try {
          session.close();
        } catch {
          // Already revoked with its worker.
        }
      };
      open.add(close);
      const wrapped: ComputerDriverSession = {
        async call(tool, args, callSignal) {
          if (closed || worker !== current) {
            // Tell the controller to open a new session; nothing was sent.
            return {
              isError: true,
              errorCode: "session_unavailable",
              text: "The computer-use session ended.",
              structured: null,
              images: [],
            };
          }
          try {
            const result = await session.callTool(tool, JSON.stringify(args), {
              signal: callSignal,
            });
            losses = 0;
            return cuaDriverResult(result);
          } catch (error) {
            if (callSignal.aborted) throw abortReason(callSignal);
            const tag = driverErrorTag(loaded, error);
            if (!tag) throw error;
            if (
              LOST_TAGS.has(tag) ||
              (tag === "ActionInterrupted" &&
                !(await stillRunning(loaded, current)))
            ) {
              lose(current);
              throw new ComputerDriverLostError();
            }
            return toolFailure(tag, error);
          }
        },
        close,
      };
      return wrapped;
    },

    async stop() {
      const current = worker;
      worker = null;
      closeSessions();
      if (!current) return;
      try {
        await current.shutdown();
      } catch {
        // A worker that already exited has nothing left to stop.
      }
    },
  };
}

/** `CFBundleIdentifier` from an XML Info.plist. */
export function bundleIdFromInfoPlist(plist: string): string | null {
  const match =
    /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>\s*([A-Za-z0-9.-]{1,255})\s*<\/string>/.exec(
      plist,
    );
  return match?.[1] ?? null;
}

/** The running app's bundle ID: `com.zeros` and its channel variants when
 * packaged, Electron's own in development. */
export function runningAppBundleId(
  executablePath: string,
  fallback: string,
): string {
  try {
    const plist = readFileSync(
      path.join(path.dirname(executablePath), "..", "Info.plist"),
      "utf8",
    );
    return bundleIdFromInfoPlist(plist) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Where the driver executable lives: in Resources when packaged, and under
 * `binaries/` once `pnpm stage:cua-driver` has run in a checkout. */
export function cuaDriverBinaryPath(options: {
  packaged: boolean;
  resourcesPath: string;
  repoRoot: string;
  exists(file: string): boolean;
}): string | null {
  const candidate = options.packaged
    ? path.join(options.resourcesPath, "cua-driver")
    : path.join(options.repoRoot, "binaries", "cua-driver");
  return options.exists(candidate) ? candidate : null;
}

/** Imports the SDK. A packaged app loads it from `app.asar.unpacked`: its
 * native library is opened by path, which cannot point into the archive. */
export async function importCuaSdk(options: {
  packaged: boolean;
  resourcesPath: string;
}): Promise<CuaSdk> {
  if (!options.packaged) {
    const sdk: CuaSdk = await import("@trycua/cua-driver");
    return sdk;
  }
  const entry = path.join(
    options.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@trycua",
    "cua-driver",
    "dist",
    "index.js",
  );
  return (await import(pathToFileURL(entry).href)) as CuaSdk;
}
