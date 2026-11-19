
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

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let cancelled = false;
    // Unsubscribe immediately if native registration resolves after cleanup.
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

  // ENGINE_ERROR carries engine-scrubbed fields; captureException also scrubs before sending.
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
