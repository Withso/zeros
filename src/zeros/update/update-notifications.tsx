// ──────────────────────────────────────────────────────────
// Auto-update notifications (renderer orchestration)
// ──────────────────────────────────────────────────────────
//
// Owns ALL user-facing update UX. Mounted once at the app root, ABOVE the
// AuthGate (AppShell) so the staged-update toast can appear on every screen.
// Checking/downloading is main-process-owned and continues with no window.
// useAnyAgentRunning reads a global zustand store, so no provider is needed:
//
//   • A persistent "New update available" toast (See changes · [Restart when
//     idle] · Restart) only after the platform installer confirms staging.
//     "Restart when idle" appears ONLY while an agent is running and defers the
//     restart until every agent goes idle, so we never kill a live turn.
//   • Dismissing (×) suppresses the toast and re-surfaces it after
//     RESHOW_INTERVAL_MS. The update also auto-applies on the next quit, so this
//     is a gentle "get it now" nudge, not a hard gate.
//   • The macOS "Check for Updates" menu item (menu-check-for-updates event)
//     runs a manual check and, when nothing's newer, shows a "You're up to
//     date!" toast.
//
// The actual download/install lives in electron/updater.ts; this is just the
// view. Under `pnpm dev` (no packaged main) the updater no-ops, so a manual
// check always reports "up to date" and the pending toast never appears.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";

import { isElectron, nativeInvoke, nativeListen } from "@/native/runtime";
import { useUpdater } from "@/native/updater";
import { useAnyAgentRunning } from "@/zeros/agent/sessions-store";
import {
  dismissUpdateToast,
  showUpdateToast,
  toast,
} from "@/zeros/ui/primitives/elements";

const CHANGELOG_URL = "https://zeros.build/changelog";

// How long to suppress the toast after the user dismisses it (×). The update is
// already downloaded and auto-applies on the next quit, so re-surfacing every
// hour just nags — a few hours strikes the balance. Tune freely.
const RESHOW_INTERVAL_MS = 4 * 60 * 60 * 1000;

// Require the app to stay continuously idle this long before a deferred
// "Restart when idle" fires, so a brief gap between turns doesn't restart
// mid-task.
const IDLE_GRACE_MS = 30 * 1000;

function openChangelog(): void {
  if (isElectron()) {
    void nativeInvoke("shell_open_url", { url: CHANGELOG_URL });
  } else {
    window.open(CHANGELOG_URL, "_blank", "noopener,noreferrer");
  }
}

export function UpdateNotifications(): null {
  const { status, install } = useUpdater();
  const anyAgentRunning = useAnyAgentRunning();

  // 0 = not suppressed. Otherwise the epoch-ms until which the toast is hidden.
  const [suppressedUntil, setSuppressedUntil] = useState(0);
  const [restartWhenIdle, setRestartWhenIdle] = useState(false);

  const ready = status.kind === "ready";
  const version = "version" in status ? status.version : "";

  // ── Manual "Check for Updates" (macOS app menu) ──
  useEffect(() => {
    if (!isElectron()) return;
    let unlisten: (() => void) | null = null;
    void nativeListen("menu-check-for-updates", () => {
      void (async () => {
        try {
          const meta = await nativeInvoke<{ version: string } | null>(
            "updater_check",
          );
          if (!meta) {
            toast.success("You're up to date!", {
              description: "You're running the latest version of Zeros.",
            });
          } else {
            // An update IS available. The persistent toast normally surfaces
            // it via `status` below — but if the user previously dismissed it
            // (4h suppression) or armed "Restart when idle", it's hidden and a
            // manual check would show NOTHING. An explicit menu click means
            // "show me the state now": lift both so the toast re-appears.
            setSuppressedUntil(0);
            setRestartWhenIdle(false);
          }
        } catch {
          // updater_check rejects when the CHECK itself failed (offline, feed
          // unreachable) — never silently, and never a false "up to date".
          toast.error("Couldn't check for updates — try again in a bit.");
        }
      })();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // ── Action handlers (stable identities) ──
  const handleRestart = useCallback(() => {
    dismissUpdateToast();
    void install();
  }, [install]);

  const handleRestartWhenIdle = useCallback(() => {
    setRestartWhenIdle(true);
    dismissUpdateToast();
    toast.info("Zeros will restart to update once your agents finish.");
  }, []);

  const handleDismiss = useCallback(() => {
    setSuppressedUntil(Date.now() + RESHOW_INTERVAL_MS);
  }, []);

  // ── Show / update / hide the persistent toast ──
  useEffect(() => {
    const suppressed = Date.now() < suppressedUntil;
    if (!ready || suppressed || restartWhenIdle) {
      dismissUpdateToast();
      return;
    }
    showUpdateToast({
      title: "New update available",
      description: version
        ? `Version ${version} is ready.`
        : "A new version is ready.",
      onSeeChanges: openChangelog,
      onRestart: handleRestart,
      // Only offer the deferred restart while an agent is mid-turn.
      onRestartWhenIdle: anyAgentRunning ? handleRestartWhenIdle : undefined,
      onDismiss: handleDismiss,
    });
  }, [
    ready,
    version,
    anyAgentRunning,
    suppressedUntil,
    restartWhenIdle,
    handleRestart,
    handleRestartWhenIdle,
    handleDismiss,
  ]);

  // ── Re-surface once the suppression window elapses ──
  useEffect(() => {
    const remaining = suppressedUntil - Date.now();
    if (remaining <= 0) return;
    const id = window.setTimeout(() => setSuppressedUntil(0), remaining);
    return () => window.clearTimeout(id);
  }, [suppressedUntil]);

  // ── Deferred "Restart when idle": fire once agents stay idle past the grace ──
  useEffect(() => {
    if (!restartWhenIdle || anyAgentRunning || !ready) return;
    const id = window.setTimeout(() => {
      void install();
    }, IDLE_GRACE_MS);
    return () => window.clearTimeout(id);
  }, [restartWhenIdle, anyAgentRunning, ready, install]);

  return null;
}
