// ──────────────────────────────────────────────────────────
// PostHog analytics — renderer client
// ──────────────────────────────────────────────────────────
//
// Anonymous, metadata-only product analytics + error tracking.
//
// Hard rules enforced here:
//   • autocapture OFF        — never auto-grab DOM text/clicks (would
//                              leak code, file paths, chat content).
//   • session recording OFF  — would record the user's code on screen.
//   • person_profiles:        'identified_only' + we NEVER call identify()
//                              → every event is anonymous (no person
//                              profile, ~4× cheaper, no PII).
//   • Only EXPLICIT capture() calls — each one sends metadata only.
//
// Dev vs prod routes to two different PostHog projects ("Zeros Dev"
// vs "Zeros"), keyed off the main process's authoritative runtime
// mode (apps/desktop/electron/runtime-mode.ts via the app_info IPC command), so
// dev activity never pollutes prod analytics.
//
// Runs in the desktop renderer. Init no-ops anywhere a project key isn't
// configured or the user has opted out.
//
// The PostHog SDK is loaded with a DYNAMIC import so its ~200 KB
// bundle stays out of the entry chunk and is fetched only when
// analytics actually initializes (i.e. not for opted-out users or
// contributors without keys). We import the full "no-external"
// bundle because Electron's CSP blocks PostHog's default runtime
// loading of extensions from its CDN.
// ──────────────────────────────────────────────────────────

import type { PostHog } from "posthog-js";
import { scrubError } from "@zeros/protocol/scrub";
import { isAnalyticsOptedOut, setAnalyticsOptedOut } from "./consent";
import { isElectron, nativeInvoke } from "../../runtime";

type RuntimeMode = "dev" | "prod";

interface AppInfo {
  runtimeMode: RuntimeMode;
  version: string;
  platform: string;
  arch: string;
}

let ph: PostHog | null = null;
let initPromise: Promise<void> | null = null;

// Events emitted before the SDK finishes loading are buffered and
// flushed once it's ready, so an early crash (or the first app_opened)
// isn't lost to the async init. Bounded so a never-initializing client
// can't grow it without limit.
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
  const key = mode === "dev" ? dev : prod;
  return key || undefined;
}

function surface(): "electron" | "browser" {
  return isElectron() ? "electron" : "browser";
}

/** Resolve runtime mode + app metadata. Authoritative source is the
 *  main process (knows IS_DEV); falls back to import.meta.env.DEV for
 *  the browser-only dev harness where there's no native bridge. */
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

/** Initialize PostHog. Idempotent. No-ops when the user opted out or when no
 * project key is configured, including open-source/contributor builds. */
export function initAnalytics(): Promise<void> {
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

    const mod = await import("posthog-js/dist/module.full.no-external");
    const posthog = (mod as unknown as { default: PostHog }).default;

    posthog.init(key, {
      api_host: host(),
      ui_host: UI_HOST,
      // ── Privacy contract (see header) ──
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      capture_performance: false,
      person_profiles: "identified_only",
      persistence: "localStorage",
    });

    // Super properties — attached to every event. Metadata only.
    posthog.register({
      app_surface: surface(),
      app_version: info.version,
      os: info.platform,
      arch: info.arch,
      runtime_mode: info.runtimeMode,
    });

    ph = posthog;
    // Fan out PostHog flag loads/refreshes to useFeatureFlag() subscribers
    // (see flags.ts). Registered once; lives for the app's lifetime.
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

/** Capture a product event. Metadata only — callers must never pass
 *  code, prompts, file paths, branch names, or any user content. */
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

/** The anonymous PostHog distinct id, or undefined when analytics is off /
 *  not yet initialized. Feedback submissions attach it so a report can be
 *  cross-referenced with the sender's PostHog events + error-tracking issues
 *  (which already sync to the issue tracker). Metadata only — the id is PostHog's own
 *  anonymous identifier, never an email or name. */
export function analyticsDistinctId(): string | undefined {
  try {
    return ph?.get_distinct_id() ?? undefined;
  } catch {
    return undefined;
  }
}

/** Report an error to PostHog error tracking. Pass exceptions from Zeros' OWN
 *  code (UI crashes, IPC failures, native/main-process crashes). The error is
 *  ALWAYS scrubbed here (message + stack → redacted, truncated metadata) before
 *  it leaves the process, so every error path — window.onerror,
 *  unhandledrejection, the ErrorBoundary, the native crash relay — is covered
 *  by the same privacy rule without each call site having to remember. Building
 *  a fresh Error from the scrubbed fields also drops any `cause` chain / custom
 *  props that could smuggle user content. (ENGINE_ERROR is already scrubbed
 *  engine-side; re-scrubbing here is idempotent.) */
export function captureException(
  error: unknown,
  props?: Record<string, unknown>,
): void {
  const s = scrubError(error);
  const err = new Error(s.message);
  err.name = s.name;
  if (s.stack) err.stack = s.stack;
  // Bake severity into the exception NAME so it survives into error-tracking
  // issues — and downstream issue titles via `{event.properties.name}`. The
  // synthetic `$error_tracking_issue_created` event drops custom props
  // (severity/area) but keeps the name, so this is the only channel that
  // reaches the tracker. Idempotent (skips an already-prefixed name) and
  // deterministic per call site, so issue grouping stays stable.
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

/** Report a HANDLED error — a catch block that would otherwise swallow it into
 *  a toast / console — to error tracking, SCRUBBED to metadata (error
 *  class/name + redacted message/stack; never raw paths, prompts, or secrets).
 *  Use for UNEXPECTED failures in feature code (bridge RPC faults, persistence
 *  errors, connectivity faults). Tagged `handled:true` to separate these from
 *  crashes. No-op when analytics is disabled / not yet ready (buffers like
 *  captureException). Don't use for expected control flow (e.g. a git error
 *  already counted by trackGitOp) — that's noise. */
export function reportError(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  // captureException scrubs; this just tags the error as handled + low-severity.
  // Default handled errors to "minor"; a caller can override via context.
  captureException(error, { handled: true, severity: "minor", ...context });
}

/** Flip analytics on/off at runtime (from Settings → Privacy). */
export async function setAnalyticsEnabled(enabled: boolean): Promise<void> {
  setAnalyticsOptedOut(!enabled);
  if (enabled) {
    if (ph) {
      try {
        ph.opt_in_capturing();
      } catch {
        /* best-effort */
      }
    } else {
      // Never initialized (was opted out at boot) — start now.
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

// ──────────────────────────────────────────────────────────
// Feature flags (read side)
// ──────────────────────────────────────────────────────────
//
// flags.ts layers the local-override + default logic and the React hook on
// top of these. They live here because only this module holds the posthog-js
// instance. Registered for change-fan-out inside initAnalytics().

const flagListeners = new Set<() => void>();

/** Raw PostHog evaluation of a boolean flag, or `undefined` when analytics
 *  isn't active (opted out / no key / flags not loaded yet). Callers supply
 *  the default — for early-stage gating that's OFF (see flags.ts). */
export function isFeatureEnabledRaw(key: string): boolean | undefined {
  try {
    return ph?.isFeatureEnabled(key);
  } catch {
    return undefined;
  }
}

/** Subscribe to PostHog flag loads/refreshes. Returns an unsubscribe. Safe to
 *  call before analytics initializes — the callback fires once flags arrive. */
export function onFlagsChanged(cb: () => void): () => void {
  flagListeners.add(cb);
  return () => flagListeners.delete(cb);
}
