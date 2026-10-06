import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  getActiveBridge,
  onActiveBridgeChange,
} from "../platform/bridge/active-bridge";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import {
  cloudWorkspaceDocument,
  subscribeCloudWorkspaces,
} from "./cloud-workspace-catalog";
import {
  describeWorkspaceAvailability,
  WORKBENCH_RECONNECT_ERROR_MS,
  WORKBENCH_RECONNECT_GRACE_MS,
  type WorkspaceAvailability,
} from "../shell/workbench/tab-status-model";

interface AvailabilityEntry {
  value: WorkspaceAvailability;
  listeners: Set<() => void>;
  stop: () => void;
}
const entries = new Map<string, AvailabilityEntry>();
const MAX_OBSERVED_WORKSPACES = 64;

function entryFor(folder: string): AvailabilityEntry {
  const retained = entries.get(folder);
  if (retained) return retained;
  const target = parseCloudWorkspaceKey(folder);
  const entry: AvailabilityEntry = {
    value: { cloud: !!target, connection: "disconnected", since: Date.now() },
    listeners: new Set(),
    stop: () => {},
  };
  entries.set(folder, entry);
  let offStatus = () => {};
  let offRejected = () => {};
  const publish = (patch: Partial<WorkspaceAvailability>) => {
    if (
      Object.entries(patch).every(
        ([key, value]) =>
          entry.value[key as keyof WorkspaceAvailability] === value,
      )
    )
      return;
    entry.value = { ...entry.value, ...patch };
    for (const listener of entry.listeners) listener();
  };
  const catalogChanged = () => {
    const doc = target ? cloudWorkspaceDocument(target) : undefined;
    const becameReady =
      doc?.status === "ready" &&
      entry.value.state !== "ready" &&
      entry.value.state !== "busy";
    publish({
      state: doc?.status,
      setupFailed: !!doc?.setupFailure,
      ...(becameReady && entry.value.connection !== "connected"
        ? { since: Date.now() }
        : {}),
    });
  };
  const attach = () => {
    offStatus();
    offRejected();
    const bridge = getActiveBridge();
    const changed = () => {
      const connection =
        bridge instanceof WorkspaceRuntimeClient
          ? bridge.statusForWorkspace(folder)
          : (bridge?.status ?? "disconnected");
      const wasConnected = entry.value.connection === "connected";
      publish({
        connection,
        previouslyConnected:
          entry.value.previouslyConnected || connection === "connected",
        ...(wasConnected && connection !== "connected"
          ? { since: Date.now() }
          : {}),
        ...(connection === "connected" ? { rejected: false } : {}),
      });
    };
    changed();
    offStatus =
      bridge instanceof WorkspaceRuntimeClient && target
        ? bridge.onWorkspaceStatusChange(folder, changed)
        : (bridge?.onStatusChange(changed) ?? (() => {}));
    // WorkspaceRuntimeClient routes cloud peers separately; its inherited
    // rejection subscription represents only the Local engine. Cloud admission
    // failures arrive through the existing workspace lifecycle below.
    offRejected =
      !target && bridge
        ? (bridge.onConnectionRejected?.(() => publish({ rejected: true })) ??
          (() => {}))
        : () => {};
  };
  attach();
  catalogChanged();
  const offBridge = onActiveBridgeChange(attach);
  const offCatalog = target
    ? subscribeCloudWorkspaces(catalogChanged)
    : () => {};
  entry.stop = () => {
    offStatus();
    offRejected();
    offBridge();
    offCatalog();
  };
  // Passive subscriptions keep timestamps across hidden-tab activation. They
  // have no timers or I/O, and this observer set has a hard bound.
  for (const [key, old] of entries) {
    if (entries.size <= MAX_OBSERVED_WORKSPACES) break;
    if (old === entry || old.listeners.size) continue;
    old.stop();
    entries.delete(key);
  }
  return entry;
}

export function recordWorkbenchConnectionFailure(
  folder: string,
  error: unknown,
): void {
  const entry = entryFor(folder);
  const raw = error instanceof Error ? error.message : String(error);
  if (entry.value.connection === "connected") return;
  if (
    /rejected|forbidden|unauthori[sz]ed|revoked|access.*(denied|not.*confirmed)|timeout|timed out/i.test(
      raw,
    )
  ) {
    entry.value = { ...entry.value, rejected: true };
    for (const listener of entry.listeners) listener();
  }
}

export function workbenchAvailabilitySnapshot(
  folder: string,
): WorkspaceAvailability {
  return entryFor(folder).value;
}

/** Retry admission without wake. The explicit workspace Start action remains
 * owned by its existing lifecycle controls. Passive tab reads never start VMs. */
export async function reconnectWorkbenchWorkspace(
  folder: string,
): Promise<void> {
  const bridge = getActiveBridge();
  if (!bridge) throw new Error("No workspace connection");
  const target = parseCloudWorkspaceKey(folder);
  if (target && bridge instanceof WorkspaceRuntimeClient)
    await bridge.warmWorkspace(target);
  else await bridge.forceReconnect();
}

export function useWorkbenchAvailability(folder: string, active: boolean) {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!active) return () => {};
      const entry = entryFor(folder);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    [active, folder],
  );
  const read = useCallback(
    () => workbenchAvailabilitySnapshot(folder),
    [folder],
  );
  const availability = useSyncExternalStore(subscribe, read, read);
  const [now, setNow] = useState(Date.now);
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    if (!active) return;
    const changed = () => {
      setVisible(document.visibilityState !== "hidden");
      setNow(Date.now());
    };
    changed();
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, [active]);
  useEffect(() => {
    if (
      !active ||
      !visible ||
      availability.connection === "connected" ||
      availability.rejected ||
      (availability.state && !["ready", "busy"].includes(availability.state))
    )
      return;
    const elapsed = Date.now() - availability.since;
    const threshold =
      availability.previouslyConnected && elapsed < WORKBENCH_RECONNECT_GRACE_MS
        ? WORKBENCH_RECONNECT_GRACE_MS
        : WORKBENCH_RECONNECT_ERROR_MS;
    if (elapsed >= threshold) return;
    const timer = setTimeout(() => setNow(Date.now()), threshold - elapsed);
    return () => clearTimeout(timer);
  }, [active, visible, availability, now]);
  // Activation reads the wall clock immediately; hidden tabs do not run grace
  // or escalation timers and do not wait another twenty seconds on reveal.
  return {
    availability,
    status: describeWorkspaceAvailability(
      availability,
      Math.max(now, Date.now()),
    ),
    visible: active && visible,
  };
}

export function resetWorkbenchAvailabilityForTests(): void {
  for (const entry of entries.values()) entry.stop();
  entries.clear();
}
