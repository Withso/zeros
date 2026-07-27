// ──────────────────────────────────────────────────────────
// Auto-updater — in-place download + install
// ──────────────────────────────────────────────────────────
//
// The main process checks GitHub Releases on launch/focus/resume and every five
// minutes, even while the macOS window is closed. It downloads automatically
// and publishes `ready` only after the platform installer has staged the file.
// The update applies automatically on the next natural quit, so it never
// interrupts a running agent. Clicking the ready toast calls `install()` →
// `updater_install`, which quits + replaces in place + relaunches (or, if the
// download is still running, installs the moment it finishes).
//
// This is the Developer-ID-signed flow (electron-updater quitAndInstall); see
// electron/updater.ts. Under `pnpm dev` (no packaged main) everything no-ops.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { isElectron, nativeInvoke, nativeListen } from "./runtime";

interface RevisionedStatus {
  /** Monotonic main-process revision for subscribe-then-snapshot races. */
  revision: number;
}

export type UpdaterStatus = RevisionedStatus &
  (
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "available"; version: string; notes?: string }
  // Emitted by electron/updater.ts as the background download runs and stages:
  //   available → downloading (with progress) → ready → (quit → relaunch).
    | {
        kind: "downloading";
        version: string;
        downloaded: number;
        total?: number;
      }
    | { kind: "ready"; version: string }
    | { kind: "error"; message: string }
  );

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}

/** Validate the IPC/event payload at the renderer boundary. */
export function parseUpdaterStatus(payload: unknown): UpdaterStatus | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  const revision = raw.revision;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    return null;
  }
  switch (raw.kind) {
    case "idle":
    case "checking":
      return { kind: raw.kind, revision };
    case "available":
      if (typeof raw.version !== "string") return null;
      return {
        kind: "available",
        revision,
        version: raw.version,
        ...(typeof raw.notes === "string" ? { notes: raw.notes } : {}),
      };
    case "downloading":
      if (
        typeof raw.version !== "string" ||
        typeof raw.downloaded !== "number" ||
        !Number.isFinite(raw.downloaded)
      ) {
        return null;
      }
      return {
        kind: "downloading",
        revision,
        version: raw.version,
        downloaded: raw.downloaded,
        ...(typeof raw.total === "number" && Number.isFinite(raw.total)
          ? { total: raw.total }
          : {}),
      };
    case "ready":
      return typeof raw.version === "string"
        ? { kind: "ready", revision, version: raw.version }
        : null;
    case "error":
      return typeof raw.message === "string"
        ? { kind: "error", revision, message: raw.message }
        : null;
    default:
      return null;
  }
}

export function useUpdater(): {
  status: UpdaterStatus;
  checkNow: () => Promise<void>;
  install: () => Promise<void>;
} {
  const [status, setStatus] = useState<UpdaterStatus>({
    kind: "idle",
    revision: -1,
  });

  const checkNow = useCallback(async () => {
    if (!isElectron()) return;
    try {
      const meta = await nativeInvoke<{
        version: string;
        notes?: string;
      } | null>("updater_check");
      void meta;
      // If meta is non-null, the main process already fired
      // `updater-status: available` via the event stream; the
      // subscriber below handled it.
    } catch (err) {
      // Background-check failures are common and non-actionable
      // (offline, no releases yet, transient 5xx). Log, stay idle —
      // never surface a red "Retry" pill for something the user
      // didn't initiate.
      console.warn("[updater] background check failed:", errMsg(err));
    }
  }, []);

  const install = useCallback(async () => {
    if (!isElectron()) return;
    try {
      // updater_install either quits + installs immediately (if the background
      // download already finished) or defensively arms install-on-ready for an
      // older caller. Main's event stream remains the status source of truth.
      await nativeInvoke<void>("updater_install");
    } catch (err) {
      // Keep the last confirmed ready snapshot visible so the user can retry.
      // Main publishes a newer error revision when quitAndInstall itself fails.
      console.warn("[updater] install failed:", errMsg(err));
    }
  }, []);

  // Subscribe first, then read the monotonic snapshot. This closes both races:
  // an event that fired before React mounted and an event that lands while the
  // snapshot IPC is in flight.
  useEffect(() => {
    if (!isElectron()) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    const accept = (payload: unknown) => {
      const next = parseUpdaterStatus(payload);
      if (!next || !alive) return;
      setStatus((previous) =>
        next.revision > previous.revision ? next : previous,
      );
    };
    void nativeListen("updater-status", accept).then((fn) => {
      if (!alive) {
        fn();
        return;
      }
      unlisten = fn;
      void nativeInvoke<unknown>("updater_status").then(accept).catch((err) => {
        console.warn("[updater] status snapshot failed:", errMsg(err));
      });
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return { status, checkNow, install };
}
