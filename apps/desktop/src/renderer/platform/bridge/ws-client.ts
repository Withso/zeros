// Desktop environment for the shared RuntimeClient. Keep this released import
// surface and native cache/default behavior intact for Local and organization-local.
import {
  RuntimeClient as SharedRuntimeClient,
  parseRuntimeConnectionTarget as parseSharedTarget,
  type RuntimeClientEnvironment,
  type RuntimeConnectionTarget,
  type CloudRuntimeConnectionTargetRefresher,
  type CloudSdkSocketFactory,
} from "./runtime-client";
export * from "./runtime-client";

import {
  ENGINE_BASE_PORT_ALPHA,
  ENGINE_BASE_PORT_BETA,
  ENGINE_BASE_PORT_DEV,
  ENGINE_BASE_PORT_PROD,
} from "../../../engine/runtime";
import { getAuthAccessToken } from "../../features/auth/auth-token";
import { CHANNEL, type Channel } from "../../config/release-channel";

// Fallback only — in the Mac app, native get_engine_port (step 2) always wins
// and returns the engine's actually-bound port. This matters solely for a
// plain browser harness, where it must match the engine channel baked into the
// renderer. Native get_engine_port remains authoritative in every desktop app.
//
// A total Record (not a ternary chain) so adding a channel is a COMPILE ERROR
// here instead of silently falling through to Production's port — which would
// point an Alpha harness at the Stable engine.
const ENGINE_PORT_BY_CHANNEL: Record<Channel, number> = {
  dev: ENGINE_BASE_PORT_DEV,
  alpha: ENGINE_BASE_PORT_ALPHA,
  beta: ENGINE_BASE_PORT_BETA,
  stable: ENGINE_BASE_PORT_PROD,
};
const DEFAULT_ENGINE_PORT = ENGINE_PORT_BY_CHANNEL[CHANNEL];

/**
 * Resolve the engine port. Cached at module level so the reconnect
 * timer doesn't hit native IPC on every retry. The cache can be
 * invalidated via `invalidateEnginePort()` — used by the in-place
 * project swap, where Electron respawns the engine on a fresh port
 * and we need to drop the old value before the next connect().
 */
let cachedPortPromise: Promise<number> | null = null;
let cachedTokenPromise: Promise<string> | null = null;
function resolveEnginePort(): Promise<number> {
  if (cachedPortPromise) return cachedPortPromise;
  cachedPortPromise = (async () => {
    if (typeof window === "undefined") return DEFAULT_ENGINE_PORT;

    const injected = (window as unknown as { __ZEROS_PORT__?: number })
      .__ZEROS_PORT__;
    if (
      typeof injected === "number" &&
      Number.isFinite(injected) &&
      injected > 0
    ) {
      return injected;
    }

    const { isExpectedElectron, isNativeRuntime, nativeInvoke } =
      await import("../runtime");
    if (isNativeRuntime()) {
      try {
        const port = await nativeInvoke<number | null>("get_engine_port");
        if (typeof port === "number" && port > 0) return port;
        throw new Error("native engine port is not ready");
      } catch (err) {
        // A native app must never guess the base port: a previous process or
        // sibling instance may own it. Clear the rejected promise and retry the
        // authoritative IPC resolution on the reconnect ladder instead.
        console.warn("[Zeros] get_engine_port failed:", err);
        void import("../observability/analytics/posthog").then((m) =>
          m.reportError(err, { source: "get_engine_port" }),
        );
        throw err;
      }
    }
    if (isExpectedElectron()) {
      throw new Error("native preload bridge is not ready");
    }

    return DEFAULT_ENGINE_PORT;
  })().catch((error) => {
    cachedPortPromise = null;
    throw error;
  });
  return cachedPortPromise;
}

/** Drop the cached engine port. Call when the engine respawns on a
 *  new port (in-place project swap) — the next connect() will
 *  re-resolve via native IPC. */
export function invalidateEnginePort(): void {
  cachedPortPromise = null;
}

/** Port and bearer identify one sidecar generation and must rotate together. */
export function invalidateEngineToken(): void {
  cachedTokenPromise = null;
}

/**
 * Resolve the loopback /ws auth token. The engine requires it on the
 * upgrade so a website that opens a cross-origin ws:// to 127.0.0.1 can't pose
 * as the renderer. Cached for one engine generation; forceReconnect clears it
 * because every replacement engine mints a fresh authority token.
 */
function resolveEngineToken(): Promise<string> {
  if (cachedTokenPromise) return cachedTokenPromise;
  cachedTokenPromise = (async () => {
    if (typeof window === "undefined") return "";
    const injected = (window as unknown as { __ZEROS_WS_TOKEN__?: string })
      .__ZEROS_WS_TOKEN__;
    if (typeof injected === "string" && injected) return injected;
    try {
      const { isNativeRuntime, nativeInvoke } = await import("../runtime");
      if (isNativeRuntime()) {
        const token = await nativeInvoke<string | null>("get_engine_token");
        if (typeof token === "string" && token) return token;
      }
    } catch (err) {
      console.warn("[Zeros] get_engine_token failed:", err);
    }
    // No token (standalone dev harness against a tokenless engine) → connect
    // without one; a token-gated engine will simply reject and we retry.
    return "";
  })();
  return cachedTokenPromise;
}

function desktopEnvironment(): RuntimeClientEnvironment {
  return {
    get controlPlaneOrigin() { return (import.meta.env.VITE_CONTROL_PLANE_URL as string | undefined) || "https://api.zeros.build"; },
    get allowHttpLoopback() { return !!import.meta.env.DEV; },
    createWebSocket: (url, protocols) => protocols ? new WebSocket(url, protocols) : new WebSocket(url),
    resolveEnginePort, resolveEngineToken, invalidateEnginePort, invalidateEngineToken,
    getAuthAccessToken, logger: console,
  };
}

export function parseRuntimeConnectionTarget(raw: unknown, now = Date.now()): RuntimeConnectionTarget {
  return parseSharedTarget(raw, now, desktopEnvironment());
}

export class RuntimeClient extends SharedRuntimeClient {
  constructor(target: RuntimeConnectionTarget = { kind: "local" }, options: {
    refreshCloudConnectionTarget?: CloudRuntimeConnectionTargetRefresher;
    createCloudSdkSocket?: CloudSdkSocketFactory;
  } = {}) {
    super(target, { ...options, environment: desktopEnvironment() });
  }
}
