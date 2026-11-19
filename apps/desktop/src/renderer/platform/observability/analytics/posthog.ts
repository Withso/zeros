
import type { PostHog } from "posthog-js";
import { scrubError } from "@zeros/protocol/scrub";
import { isAnalyticsOptedOut, setAnalyticsOptedOut } from "./consent";
import { isElectron, isLocalDevelopment, nativeInvoke } from "../../runtime";
import { subscribePreferenceCache } from "../../personal-preferences";
import { CHANNEL } from "../../../config/release-channel";
import { clientReleaseChannel } from "../../../../../shared/client-compatibility";

type RuntimeMode = "dev" | "prod";

interface AppInfo {
  runtimeMode: RuntimeMode;
  version: string;
  platform: string;
  arch: string;
}

let ph: PostHog | null = null;
let initPromise: Promise<void> | null = null;

// Cap buffered events and errors in case analytics never initializes.
type Buffered =
  | { kind: "event"; event: string; props?: Record<string, unknown> }
  | { kind: "exception"; error: Error; props?: Record<string, unknown> };
const buffer: Buffered[] = [];
const MAX_BUFFER = 20;

const DEFAULT_HOST = "https://us.i.posthog.com";
const UI_HOST = "https://us.posthog.com";

function host(): string {
  return (import.meta.env.VITE_POSTHOG_HOST || "").trim() || DEFAULT_HOST;
}

function keyForRuntime(mode: RuntimeMode): string | undefined {
  const prod = (import.meta.env.VITE_POSTHOG_KEY_PROD || "").trim();
  const dev = (import.meta.env.VITE_POSTHOG_KEY_DEV || "").trim();
  const key = prod || (mode === "dev" ? dev : "");
  return key || undefined;
}

function surface(): "electron" | "browser" {
  return isElectron() ? "electron" : "browser";
}

/** Prefer main-process app_info; browser development has no native runtime authority. */
async function loadAppInfo(): Promise<AppInfo> {
  if (isElectron()) {
    try {
      const info = await nativeInvoke<AppInfo>("app_info");
      if (info && (info.runtimeMode === "dev" || info.runtimeMode === "prod")) {
        return info;
      }
    } catch {
      /* bridge not ready / command missing — fall through */
    }
  }
  return {
    runtimeMode: import.meta.env.DEV ? "dev" : "prod",
    version: "unknown",
    platform: typeof navigator !== "undefined" ? navigator.platform : "unknown",
    arch: "unknown",
  };
}

function flushBuffer(): void {
  if (!ph) return;
  for (const item of buffer.splice(0)) {
    try {
      if (item.kind === "event") ph.capture(item.event, item.props);
      else ph.captureException(item.error, item.props);
    } catch {
      /* best-effort */
    }
  }
}

export function initAnalytics(): Promise<void> {
  if (isLocalDevelopment()) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (isAnalyticsOptedOut()) return;

    const info = await loadAppInfo();
    const key = keyForRuntime(info.runtimeMode);
    if (!key) {
      console.info(
        `[Zeros] analytics: no PostHog key for ${info.runtimeMode} runtime — disabled. ` +
          `Set VITE_POSTHOG_KEY_${info.runtimeMode.toUpperCase()} to enable.`,
      );
      return;
    }

    // Load lazily after the opt-out check; Electron CSP blocks PostHog's CDN-loaded extensions.
    const mod = await import("posthog-js/dist/module.full.no-external");
    const posthog = (mod as unknown as { default: PostHog }).default;

    posthog.init(key, {
      api_host: host(),
      ui_host: UI_HOST,
      // Keep DOM and session capture off to protect user code and chat; never call identify() so identified_only does not create person profiles for these events.
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      capture_performance: false,
      person_profiles: "identified_only",
      persistence: "localStorage",
    });

    posthog.register({
      app_surface: surface(),
      app_version: info.version,
      os: info.platform,
      arch: info.arch,
      runtime_mode: info.runtimeMode,
      release_channel: clientReleaseChannel(CHANNEL),
    });

    ph = posthog;
    try {
      posthog.onFeatureFlags(() => {
        for (const l of flagListeners) l();
      });
    } catch {
      /* best-effort */
    }
    capture("app_opened");
    flushBuffer();
  })();
  return initPromise;
}

/** Only send explicit metadata: no code, prompts, paths, branch names, or other user content. */
export function capture(event: string, props?: Record<string, unknown>): void {
  if (ph) {
    try {
      ph.capture(event, props);
    } catch {
      /* best-effort */
    }
    return;
  }
  if (!isAnalyticsOptedOut() && buffer.length < MAX_BUFFER) {
    buffer.push({ kind: "event", event, props });
  }
}

/** Feedback can correlate telemetry by PostHog's distinct ID without attaching a name or email. */
export function analyticsDistinctId(): string | undefined {
  try {
    return ph?.get_distinct_id() ?? undefined;
  } catch {
    return undefined;
  }
}

/** Scrub at the export boundary and rebuild the Error so causes and custom properties cannot carry user content. */
export function captureException(
  error: unknown,
  props?: Record<string, unknown>,
): void {
  const s = scrubError(error);
  const err = new Error(s.message);
  err.name = s.name;
  if (s.stack) err.stack = s.stack;
  // Put severity in the exception name because PostHog's issue-created event drops custom properties.
  const severity =
    typeof props?.severity === "string" ? props.severity : undefined;
  if (severity) {
    const current = err.name || "Error";
    if (!current.startsWith("[")) err.name = `[${severity}] ${current}`;
  }
  if (ph) {
    try {
      ph.captureException(err, props);
    } catch {
      /* best-effort */
    }
    return;
  }
  if (!isAnalyticsOptedOut() && buffer.length < MAX_BUFFER) {
    buffer.push({ kind: "exception", error: err, props });
  }
}

/** Report unexpected handled faults, not expected control flow that already has a product event. */
export function reportError(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  captureException(error, { handled: true, severity: "minor", ...context });
}

export async function setAnalyticsEnabled(enabled: boolean): Promise<void> {
  setAnalyticsOptedOut(!enabled);
  await applyAnalyticsEnabled(enabled);
}

async function applyAnalyticsEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    if (ph) {
      try {
        ph.opt_in_capturing();
      } catch {
        /* best-effort */
      }
    } else {
      // Clear the memoized no-op if the user opted out at boot.
      initPromise = null;
      await initAnalytics();
    }
  } else if (ph) {
    try {
      ph.opt_out_capturing();
    } catch {
      /* best-effort */
    }
  }
}

subscribePreferenceCache("zeros-analytics:opt-out", () => {
  void applyAnalyticsEnabled(!isAnalyticsOptedOut());
});


const flagListeners = new Set<() => void>();

/** Undefined is unknown; the caller owns the flag default. */
export function isFeatureEnabledRaw(key: string): boolean | undefined {
  try {
    return ph?.isFeatureEnabled(key);
  } catch {
    return undefined;
  }
}

/** Subscribers can register before the SDK initializes. */
export function onFlagsChanged(cb: () => void): () => void {
  flagListeners.add(cb);
  return () => flagListeners.delete(cb);
}
