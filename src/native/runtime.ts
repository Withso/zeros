// ──────────────────────────────────────────────────────────
// Zeros Native Runtime — Electron IPC façade
// ──────────────────────────────────────────────────────────
//
// Every React call site that needs the desktop shell (git,
// keychain, terminal, folder dialogs, deep links, sidecar engine,
// etc.) goes through this module. Feature-detects whether we're
// running inside the packaged Electron app vs a plain browser
// (`pnpm dev`) and routes IPC accordingly.
//
// Detection: `window.__ZEROS_NATIVE__` is set by the preload
// script (electron/preload.ts). When present, we're running
// inside Electron's renderer and all native commands are
// available. When absent, we're in a browser-only Vite dev
// harness — read-style façade functions return empty / null,
// write-style ones throw "requires the Mac app".
//
// 2026-05-23 hardening (the "Browser requires the Mac app" bug):
//
//   The old `isElectron()` was a non-reactive synchronous check
//   on `window.__ZEROS_NATIVE__`. React components captured its
//   value at render time and never updated — so if the preload
//   bridge hadn't injected yet (build race, HMR refresh, stale
//   `dist-electron/preload.cjs` after a branch switch, partial
//   tsup write), the whole app degraded to "browser mode" and
//   stuck there until something else forced a re-render.
//
//   This module now exposes three layers of detection:
//
//    1. `isElectron()`              — sync, for non-React code.
//                                     Reads the bridge directly.
//    2. `useNativeRuntime()`        — React hook; re-renders the
//                                     moment the bridge appears,
//                                     even if it arrives late.
//    3. `isExpectedElectron()`      — sync, reads navigator.userAgent.
//                                     Distinguishes "actually in a
//                                     browser" from "in Electron but
//                                     preload bridge is missing"
//                                     (the latter is recoverable —
//                                     reload the window).
// ──────────────────────────────────────────────────────────

import { useEffect, useState } from "react";

interface ZerosNativeBridge {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  on<T = unknown>(eventName: string, handler: (payload: T) => void): () => void;
}

declare global {
  interface Window {
    __ZEROS_NATIVE__?: ZerosNativeBridge;
  }
}

/** Synchronous one-shot check. Use this only from non-React code
 *  (engine, native fs façade, gateway). React components should
 *  use `useNativeRuntime()` so the UI updates when a late-arriving
 *  preload bridge becomes available. */
export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.__ZEROS_NATIVE__;
}

/** Back-compat alias — same semantics as isElectron() now that
 *  the native shell abstraction is simplified. Kept so existing
 *  call sites keep compiling; prefer isElectron() in new code. */
export function isNativeRuntime(): boolean {
  return isElectron();
}

/** Does navigator.userAgent claim we're in Electron? Used to tell
 *  the two failure modes apart:
 *
 *   - `isExpectedElectron() && !isElectron()` → in Electron, but
 *     the preload bridge didn't inject. This is RECOVERABLE — a
 *     window reload usually re-runs the preload and the bridge
 *     comes back. The UI shows a recovery banner with a Reload
 *     button instead of the dead-end "requires the Mac app"
 *     message.
 *
 *   - `!isExpectedElectron() && !isElectron()` → genuinely
 *     running in a browser (someone opened http://localhost:5193
 *     in Chrome). The dead-end message is correct here. */
export function isExpectedElectron(): boolean {
  if (typeof navigator === "undefined") return false;
  return /electron/i.test(navigator.userAgent);
}

/** Short name of the active runtime for diagnostics / log lines. */
export function runtimeName(): "electron" | "browser" {
  return isElectron() ? "electron" : "browser";
}

/** Call a native command. Errors from the underlying bridge
 *  surface via the promise rejection — callers handle them the
 *  same way they did under the old native invoke bridge. */
export async function nativeInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isElectron()) {
    return window.__ZEROS_NATIVE__!.invoke<T>(cmd, args);
  }
  throw new Error(
    `[Zeros] nativeInvoke("${cmd}") called without a native runtime — ` +
      `this feature requires the Mac app`,
  );
}

/** Subscribe to a named event emitted from the main process.
 *  Returns an unsubscribe function. In browser-only dev mode
 *  no-ops (returns a no-op unsubscribe) so callers don't need
 *  to guard. */
export async function nativeListen<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (isElectron()) {
    return window.__ZEROS_NATIVE__!.on<T>(event, handler);
  }
  return () => {};
}

// ──────────────────────────────────────────────────────────
// Reactive detection (useNativeRuntime hook)
// ──────────────────────────────────────────────────────────
//
// Why a polling loop instead of a one-time check:
//
//   The preload bridge is normally injected before any renderer
//   script runs (contextBridge.exposeInMainWorld() is synchronous
//   in the preload context). But there are real edge cases where
//   the bridge appears AFTER React's first render:
//
//    - Vite HMR refresh while preload.cjs is being rebuilt by
//      tsup (the renderer's JS reloads but the preload window-
//      global is already there — except when tsup is mid-write
//      and Electron loaded a partial/old preload).
//    - Branch-switch dev workflow: pnpm electron:dev keeps
//      running; user switches branches; tsup picks up new
//      preload.ts source; brief window where dist-electron/
//      preload.cjs is being overwritten.
//    - An external worktree tool triggering a workspace-level
//      rebuild can leave the renderer loaded against a stale bridge.
//
//   Polling every 100ms for the first 3 seconds catches every
//   one of these without burning power — after the bridge is
//   detected, we stop polling forever (the bridge can't go
//   away without a full window reload, which would re-run this
//   effect anyway).

const READY_POLL_INTERVAL_MS = 100;
const READY_POLL_DEADLINE_MS = 3_000;

/** A module-level cache so concurrent hook callers share one
 *  detection state. Avoids N timers running in parallel. */
let cachedReady: boolean = isElectron();
const readyListeners = new Set<(ready: boolean) => void>();

function notifyReady(next: boolean) {
  if (cachedReady === next) return;
  cachedReady = next;
  for (const fn of readyListeners) {
    try {
      fn(next);
    } catch (err) {
      // A bad subscriber shouldn't kill the fan-out.
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
  /** True when `window.__ZEROS_NATIVE__` is present. Flips from
   *  false → true exactly once per window load (and never back). */
  ready: boolean;
  /** True when `navigator.userAgent` says "Electron". Means the
   *  user IS running the Mac app — if `ready` stays false past
   *  the poll deadline, the preload bridge failed to inject and
   *  a window reload is the recovery path. */
  expectedElectron: boolean;
  /** Best-guess failure mode for the recovery banner.
   *   - "ready"     → bridge present; everything fine.
   *   - "browser"   → genuinely in a browser tab; no recovery
   *                   possible from inside the renderer.
   *   - "preload-missing" → in Electron but bridge missing.
   *                         Recoverable by reloading the window. */
  status: "ready" | "browser" | "preload-missing";
}

/** React hook that reactively tracks the native bridge. Subscribes
 *  to a module-level bus that polls for `window.__ZEROS_NATIVE__`
 *  for the first 3 seconds after mount. Once the bridge is
 *  detected, the state is sticky-true for the lifetime of this
 *  window (the bridge can't unload mid-session — only a full
 *  reload would, and that remounts everything). */
export function useNativeRuntime(): NativeRuntimeState {
  const [ready, setReady] = useState<boolean>(cachedReady);

  useEffect(() => {
    // Subscribe FIRST so we don't miss a state flip that happens
    // between mount and effect run.
    const sync = (next: boolean) => setReady(next);
    readyListeners.add(sync);

    // Recheck synchronously — the bridge may have appeared
    // between render and effect.
    if (!cachedReady && isElectron()) {
      notifyReady(true);
    } else {
      // Make sure the shared poll is running. Idempotent.
      ensurePollStarted();
    }

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
