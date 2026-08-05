// ──────────────────────────────────────────────────────────
// AnalyticsBoot — headless analytics bootstrap
// ──────────────────────────────────────────────────────────
//
// Mounted once near the root of AppShell. On mount it:
//   1. initializes PostHog (no-op when unsupported, opted out, or unconfigured),
//   2. installs global error → error-tracking listeners (the React
//      ErrorBoundary covers render errors; these cover the rest).
//
// (The first-run privacy notice used to fire here as a toast; it was
//  removed — it belongs on a future bottom-left BANNER, not a toast.)
//
// Renders nothing. Mirrors the other boot components in app-shell.tsx
// (LoadModelCatalogOnBoot, PreWarmAgents, …).
// ──────────────────────────────────────────────────────────

import { useEffect } from "react";
import { initAnalytics, captureException } from "./posthog";
import { useBridge } from "../../bridge/use-bridge";
import { nativeListen } from "../../runtime";

export function AnalyticsBoot() {
  const bridge = useBridge();

  useEffect(() => {
    void initAnalytics();

    const onError = (e: ErrorEvent) =>
      captureException(e.error ?? new Error(e.message), {
        source: "window.onerror",
        severity: "major",
        area: "renderer",
      });
    const onRejection = (e: PromiseRejectionEvent) =>
      captureException(e.reason, {
        source: "unhandledrejection",
        severity: "major",
        area: "renderer",
      });
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // Native crash forwarding: the Electron main process (apps/desktop/electron/main.ts) and the
  // engine supervisor (apps/desktop/electron/sidecar.ts) push crashes over IPC so PostHog
  // error tracking sees faults that happen OUTSIDE the renderer. Metadata +
  // app-internal stacks only — never user content. No-ops outside the native
  // desktop runtime (nativeListen returns a no-op unsubscribe there).
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let cancelled = false;
    const track = (p: Promise<() => void>) =>
      void p.then((u) => (cancelled ? u() : unsubs.push(u)));

    track(
      nativeListen<{
        source?: string;
        name?: string;
        message?: string;
        stack?: string;
      }>("main-process-error", (e) => {
        const err = new Error(e?.message || "main process error");
        if (e?.name) err.name = e.name;
        if (e?.stack) err.stack = e.stack;
        captureException(err, {
          origin: "electron-main",
          source: e?.source,
          severity: "critical",
          area: "electron-main",
        });
      }),
    );
    track(
      nativeListen<{ code?: number | null; signal?: string | null }>(
        "engine-crash",
        (e) => {
          captureException(
            new Error(
              `engine crashed (code=${e?.code ?? "null"} signal=${e?.signal ?? "null"})`,
            ),
            {
              origin: "engine",
              exit_code: e?.code,
              signal: e?.signal,
              severity: "critical",
              area: "engine",
            },
          );
        },
      ),
    );

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, []);

  // Engine error forwarding (gap A): the engine forwards CAUGHT errors (git /
  // workspace / file ops, plus a safety net for any uncaught handler error)
  // over the bridge as ENGINE_ERROR. Already scrubbed engine-side — we just
  // hand it to error tracking, tagged origin:engine.
  useEffect(() => {
    if (!bridge) return;
    return bridge.on("ENGINE_ERROR", (raw) => {
      const e = raw as {
        origin?: string;
        name?: string;
        message?: string;
        stack?: string;
        code?: string;
        severity?: string;
      };
      const err = new Error(e?.message || "engine error");
      if (e?.name) err.name = e.name;
      if (e?.stack) err.stack = e.stack;
      captureException(err, {
        origin: "engine",
        source: e?.origin,
        code: e?.code,
        severity: e?.severity || "major",
        area: "engine",
      });
    });
  }, [bridge]);

  return null;
}
