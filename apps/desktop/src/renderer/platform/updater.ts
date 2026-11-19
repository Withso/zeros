// Main publishes ready only after staging; without an explicit restart, the update applies on normal quit.
import { useCallback, useEffect, useState } from "react";
import { isElectron, nativeInvoke, nativeListen } from "./runtime";
import { parseClientUpgradeRequired, type ClientUpgradeRequired } from "../../../shared/client-compatibility";

interface RevisionedStatus {
  /** Monotonic main-process revision for subscribe-then-snapshot races. */
  revision: number;
  required?: ClientUpgradeRequired;
}

export type UpdaterStatus = RevisionedStatus &
  (
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "available"; version: string; notes?: string }
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

function parseUpdaterState(payload: unknown): UpdaterStatus | null {
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

export function parseUpdaterStatus(payload: unknown): UpdaterStatus | null {
  const status = parseUpdaterState(payload);
  if (!status) return null;
  const required = parseClientUpgradeRequired((payload as Record<string, unknown>).required);
  return required ? { ...status, required } : status;
}

export function useUpdater(): {
  status: UpdaterStatus;
  checkNow: () => Promise<void>;
  install: (options?: { requireReady: boolean }) => Promise<void>;
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
      // The revisioned event/snapshot stream owns status, not the check reply.
    } catch (err) {
      // A failed background check does not replace the last confirmed status.
      console.warn("[updater] background check failed:", errMsg(err));
    }
  }, []);

  const install = useCallback(async (options?: { requireReady: boolean }) => {
    if (!isElectron()) return;
    try {
      // Older callers can arm install-on-ready; requireReady refuses an unstaged restart.
      await nativeInvoke<void>("updater_install", options);
    } catch (err) {
      // Preserve the ready snapshot for retry unless main publishes a newer status.
      console.warn("[updater] install failed:", errMsg(err));
    }
  }, []);

  // Subscribe before reading status, then use the revision to reject an older snapshot racing a live event.
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
