// Keep the released desktop import surface for Personal and organization-local runtimes.
import {
  RuntimeClient as SharedRuntimeClient,
  parseRuntimeConnectionTarget as parseSharedTarget,
  type RuntimeClientEnvironment,
  type RuntimeConnectionTarget,
  type CloudRuntimeConnectionTargetRefresher,
  type CloudAccessConfirmer, type CloudConnectionTicketRenewer,
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

// Only browser harnesses use this channel-specific fallback; Electron must resolve its bound port.
const ENGINE_PORT_BY_CHANNEL: Record<Channel, number> = {
  dev: ENGINE_BASE_PORT_DEV,
  alpha: ENGINE_BASE_PORT_ALPHA,
  beta: ENGINE_BASE_PORT_BETA,
  stable: ENGINE_BASE_PORT_PROD,
};
const DEFAULT_ENGINE_PORT = ENGINE_PORT_BY_CHANNEL[CHANNEL];

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
        // Never guess a native port; a sibling instance or an old process may own it.
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

/** Drop the cached port so the next connect re-resolves it over native IPC. */
export function invalidateEnginePort(): void {
  cachedPortPromise = null;
}

/** Port and bearer identify one sidecar generation and must rotate together. */
export function invalidateEngineToken(): void {
  cachedTokenPromise = null;
}

/** Authenticate loopback upgrades so a webpage cannot impersonate the renderer; cache the bearer only for this sidecar generation. */
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
    // An empty bearer is only accepted by a tokenless standalone harness.
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
    confirmCloudAccessEnded?: CloudAccessConfirmer;
    renewCloudConnectionTicket?: CloudConnectionTicketRenewer;
  } = {}) {
    super(target, { ...options, environment: desktopEnvironment() });
  }
}
