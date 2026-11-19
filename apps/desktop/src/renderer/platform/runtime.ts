import { useEffect, useState } from "react";

import { parseNativeErrorMessage } from "@zeros/protocol/native-error";

interface ZerosNativeBridge {
  readonly localDevelopment?: boolean;
  readonly asyncCanvasWheel?: boolean;
  maintainAttachmentSources?(retainedIds: string[]): Promise<string[]>;
  beforeQuit?(prepare: () => Promise<void>): () => void;
  prepareAttachmentFile?(file: File, id: string): Promise<string | null>;
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  on<T = unknown>(eventName: string, handler: (payload: T) => void): () => void;
}

export async function maintainNativeAttachmentSources(retainedIds: string[]): Promise<string[] | null> {
  return (typeof window !== "undefined" && window.__ZEROS_NATIVE__?.maintainAttachmentSources?.(retainedIds)) || null;
}

export function onNativeBeforeQuit(prepare: () => Promise<void>): () => void {
  return (typeof window !== "undefined" && window.__ZEROS_NATIVE__?.beforeQuit?.(prepare)) || (() => {});
}

export async function prepareNativeAttachmentFile(file: Blob, id: string): Promise<string | null> {
  if (typeof File === "undefined" || !(file instanceof File)) return null;
  return (typeof window !== "undefined" && window.__ZEROS_NATIVE__?.prepareAttachmentFile?.(file, id)) || null;
}

declare global {
  interface Window {
    __ZEROS_NATIVE__?: ZerosNativeBridge;
  }
}

// Use useNativeRuntime in React so late preload injection updates the UI.
export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.__ZEROS_NATIVE__;
}

// Only a host that disables visual pinch zoom can let Design handle the wheel asynchronously.
export function hasAsyncCanvasWheel(): boolean {
  return typeof window !== "undefined" && window.__ZEROS_NATIVE__?.asyncCanvasWheel === true;
}

// Main supplies this mode before the first render.
export function isLocalDevelopment(): boolean {
  return (
    typeof window !== "undefined" &&
    window.__ZEROS_NATIVE__?.localDevelopment === true
  );
}

// Compatibility alias for isElectron.
export function isNativeRuntime(): boolean {
  return isElectron();
}

// Distinguish missing preload, which a window reload may recover, from a browser tab.
export function isExpectedElectron(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Electron/i.test(navigator.userAgent);
}

export function runtimeName(): "electron" | "browser" {
  return isElectron() ? "electron" : "browser";
}

// Electron wraps command rejections; restore a handler code encoded by NativeCommandError.
export interface NativeInvokeError extends Error {
  code?: string;
  /** The untouched `Error invoking remote method …` text, for logs. */
  rawMessage: string;
}

// Strip Electron's transport wrapper before showing handler rejections in toasts.
export async function nativeInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isElectron()) {
    throw new Error(
      `[Zeros] nativeInvoke("${cmd}") called without a native runtime — ` +
        `this feature requires the Mac app`,
    );
  }
  try {
    return await window.__ZEROS_NATIVE__!.invoke<T>(cmd, args);
  } catch (error) {
    throw normalizeNativeInvokeError(error, cmd);
  }
}

export function normalizeNativeInvokeError(
  error: unknown,
  cmd: string,
): NativeInvokeError {
  const rawMessage =
    error instanceof Error ? error.message : String(error ?? "");
  const parsed = parseNativeErrorMessage(rawMessage);
  const normalized = new Error(
    parsed.message || `[Zeros] native command "${cmd}" failed`,
    // Keep the original reachable for debugging without printing it.
    { cause: error },
  ) as NativeInvokeError;
  if (parsed.code) normalized.code = parsed.code;
  normalized.rawMessage = rawMessage;
  return normalized;
}

// Browser callers get a no-op unsubscribe without guarding the subscription.
export async function nativeListen<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (isElectron()) {
    return window.__ZEROS_NATIVE__!.on<T>(event, handler);
  }
  return () => {};
}

const READY_POLL_INTERVAL_MS = 100;
const READY_POLL_DEADLINE_MS = 3_000;

// A shared poll catches a late preload without a timer per hook.
let cachedReady: boolean = isElectron();
const readyListeners = new Set<(ready: boolean) => void>();

function notifyReady(next: boolean) {
  if (cachedReady === next) return;
  cachedReady = next;
  for (const fn of readyListeners) {
    try {
      fn(next);
    } catch (err) {
      console.error("[Zeros] useNativeRuntime listener threw:", err);
    }
  }
}

let pollHandle: number | null = null;
let pollStartedAt = 0;
function ensurePollStarted() {
  if (typeof window === "undefined") return;
  if (pollHandle !== null) return;
  if (cachedReady) return;
  pollStartedAt = Date.now();
  pollHandle = window.setInterval(() => {
    if (isElectron()) {
      notifyReady(true);
      if (pollHandle !== null) {
        window.clearInterval(pollHandle);
        pollHandle = null;
      }
      return;
    }
    if (Date.now() - pollStartedAt >= READY_POLL_DEADLINE_MS) {
      if (pollHandle !== null) {
        window.clearInterval(pollHandle);
        pollHandle = null;
      }
    }
  }, READY_POLL_INTERVAL_MS);
}

export interface NativeRuntimeState {
  ready: boolean;
  expectedElectron: boolean;
  status: "ready" | "browser" | "preload-missing";
}

// Native readiness stays true for this window once preload is observed.
export function useNativeRuntime(): NativeRuntimeState {
  const [ready, setReady] = useState<boolean>(cachedReady);

  useEffect(() => {
    // Subscribe before rechecking and replaying readiness so effects cannot miss a late preload.
    const sync = (next: boolean) => setReady(next);
    readyListeners.add(sync);

    if (!cachedReady && isElectron()) {
      notifyReady(true);
    } else {
      ensurePollStarted();
    }
    sync(cachedReady);

    return () => {
      readyListeners.delete(sync);
    };
  }, []);

  const expectedElectron = isExpectedElectron();
  const status: NativeRuntimeState["status"] = ready
    ? "ready"
    : expectedElectron
      ? "preload-missing"
      : "browser";

  return { ready, expectedElectron, status };
}
