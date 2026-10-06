import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  getActiveBridge,
  onActiveBridgeChange,
} from "../platform/bridge/active-bridge";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import {
  cloudWorkspaceKey,
  parseCloudWorkspaceKey,
} from "../platform/bridge/cloud-workspace-key";
import {
  describeConnectionRejection,
  type ConnectionRejection,
  type RuntimeClient,
} from "../platform/bridge/ws-client";
import { toast } from "../shared/ui/primitives/elements";
import {
  cloudWorkspaceDocument,
  subscribeCloudWorkspaces,
} from "./cloud-workspace-catalog";
import {
  describeWorkspaceAvailability,
  WORKBENCH_RECONNECT_ERROR_MS,
  WORKBENCH_RECONNECT_GRACE_MS,
  type WorkspaceAvailability,
  type WorkbenchStatus,
  workbenchFailureDiagnostic,
} from "../shell/workbench/tab-status-model";

interface AvailabilityDecision {
  availability: WorkspaceAvailability;
  status: WorkbenchStatus | null;
}
interface AvailabilityEntry {
  value: WorkspaceAvailability;
  decision: AvailabilityDecision;
  timer?: ReturnType<typeof setTimeout>;
  listeners: Set<() => void>;
  stop: () => void;
  notice?: {
    id: string;
    headline: string;
    description: string;
    shown: boolean;
  };
}
const entries = new Map<string, AvailabilityEntry>();
const MAX_OBSERVED_WORKSPACES = 64;

function updateDecision(entry: AvailabilityEntry): boolean {
  const status = describeWorkspaceAvailability(entry.value, Date.now());
  const previous = entry.decision.status;
  const sameStatus =
    status === previous ||
    (!!status && !!previous &&
      status.tone === previous.tone &&
      status.message === previous.message &&
      status.action === previous.action &&
      status.diagnostic === previous.diagnostic &&
      status.connectionPhase === previous.connectionPhase);
  if (entry.decision.availability === entry.value && sameStatus) return false;
  entry.decision = {
    availability: entry.value,
    status: sameStatus ? previous : status,
  };
  return true;
}

/** One clock/decision per Local engine or cloud VM, shared by every tab. A
 * transient gap has no banner or empty state. Only visible subscribers own
 * the 10s/45s timers; passive observers retain timestamps without timers/I/O. */
function refreshAvailability(entry: AvailabilityEntry): void {
  clearTimeout(entry.timer);
  entry.timer = undefined;
  const changed = updateDecision(entry);
  const input = entry.value;
  if (
    entry.listeners.size && input.connection !== "connected" &&
    !input.rejected && !input.rejection && !input.setupFailed &&
    (!input.state || ["ready", "busy"].includes(input.state))
  ) {
    const elapsed = Date.now() - input.since;
    const threshold =
      elapsed < WORKBENCH_RECONNECT_GRACE_MS
        ? WORKBENCH_RECONNECT_GRACE_MS
        : WORKBENCH_RECONNECT_ERROR_MS;
    if (elapsed < threshold)
      entry.timer = setTimeout(
        () => refreshAvailability(entry), threshold - elapsed,
      );
  }
  if (changed) for (const listener of entry.listeners) listener();
}

// Only active, document-visible frames register. All local folders share the
// Local engine; cloud folders (including nested paths) share their VM identity.
const visibleFrames = new Map<string, number>();
const visibilityListeners = new Set<() => void>();
function visibilityKey(folder: string): string {
  const target = parseCloudWorkspaceKey(folder);
  return target ? cloudWorkspaceKey(target) : "local";
}
function frameVisible(folder: string): boolean {
  return (visibleFrames.get(visibilityKey(folder)) ?? 0) > 0;
}
function reconcileCloudNotice(folder: string, entry: AvailabilityEntry): void {
  const notice = entry.notice;
  if (!notice) return;
  const shown = !frameVisible(folder);
  if (notice.shown === shown) return;
  notice.shown = shown;
  const id = notice.id;
  if (shown)
    toast.error(notice.headline, { id, description: notice.description });
  else toast.dismiss(id);
}
function visibilityChanged(): void {
  for (const [folder, entry] of entries) reconcileCloudNotice(folder, entry);
  for (const listener of visibilityListeners) listener();
}
export function registerWorkbenchFrameVisibility(folder: string): () => void {
  const key = visibilityKey(folder);
  visibleFrames.set(key, (visibleFrames.get(key) ?? 0) + 1);
  visibilityChanged();
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const count = (visibleFrames.get(key) ?? 1) - 1;
    if (count > 0) visibleFrames.set(key, count);
    else visibleFrames.delete(key);
    visibilityChanged();
  };
}

/** Presentation only: preserve the terminal-rejection toast when no Local
 * frame can explain it. Transport rejection/recovery remains owned by client. */
export function wireWorkbenchConnectionRejection(
  client: Pick<RuntimeClient, "onConnectionRejected" | "onStatusChange">,
): () => void {
  const id = "bridge-connection-rejected";
  let rejection: ConnectionRejection | undefined;
  const reconcile = () => {
    if (!rejection || frameVisible("")) {
      toast.dismiss(id);
      return;
    }
    const copy = describeConnectionRejection(rejection);
    toast.error(copy.headline, {
      id,
      description: workbenchFailureDiagnostic(copy.description),
      duration: Infinity,
    });
  };
  visibilityListeners.add(reconcile);
  const offRejected = client.onConnectionRejected((value) => {
    rejection = value;
    reconcile();
  });
  const offStatus = client.onStatusChange((status) => {
    if (status === "connected") {
      rejection = undefined;
      reconcile();
    }
  });
  return () => {
    offRejected();
    offStatus();
    visibilityListeners.delete(reconcile);
    toast.dismiss(id);
  };
}

function clearConnectionNotice(entry: AvailabilityEntry): void {
  if (entry.notice) toast.dismiss(entry.notice.id);
  entry.notice = undefined;
}

function entryFor(folder: string): AvailabilityEntry {
  // Availability belongs to the engine/VM, while data sources remain keyed by
  // the exact folder/target. A nested visible frame must receive its VM's error.
  const owner = visibilityKey(folder);
  const retained = entries.get(owner);
  if (retained) return retained;
  const target = parseCloudWorkspaceKey(folder);
  const value: WorkspaceAvailability = {
    cloud: !!target, connection: "disconnected", since: Date.now(),
  };
  const entry: AvailabilityEntry = {
    value,
    decision: { availability: value, status: null },
    listeners: new Set(),
    stop: () => {},
  };
  entries.set(owner, entry);
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
    refreshAvailability(entry);
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
      stopError: doc?.error,
      canWake: doc?.capabilities.canWrite,
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
          ? bridge.statusForWorkspace(target ? owner : folder)
          : (bridge?.status ?? "disconnected");
      const wasConnected = entry.value.connection === "connected";
      publish({
        connection,
        previouslyConnected:
          entry.value.previouslyConnected || connection === "connected",
        ...(wasConnected && connection !== "connected"
          ? { since: Date.now() }
          : {}),
        ...(connection === "connected"
          ? { rejected: false, rejection: undefined }
          : {}),
      });
      if (connection === "connected") clearConnectionNotice(entry);
    };
    changed();
    offStatus =
      bridge instanceof WorkspaceRuntimeClient && target
        ? bridge.onWorkspaceStatusChange(owner, changed)
        : (bridge?.onStatusChange(changed) ?? (() => {}));
    // WorkspaceRuntimeClient routes cloud peers separately; its inherited
    // rejection subscription represents only the Local engine. Cloud admission
    // failures arrive through the existing workspace lifecycle below.
    offRejected =
      !target && bridge
        ? (bridge.onConnectionRejected?.((rejection) =>
            publish({ rejected: true, rejection }),
          ) ?? (() => {}))
        : () => {};
  };
  attach();
  catalogChanged();
  const offBridge = onActiveBridgeChange(attach);
  const offCatalog = target
    ? subscribeCloudWorkspaces(catalogChanged)
    : () => {};
  entry.stop = () => {
    clearTimeout(entry.timer);
    offStatus();
    offRejected();
    offBridge();
    offCatalog();
    clearConnectionNotice(entry);
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
  kind: "connect" | "open" = "connect",
): void {
  const entry = entryFor(folder);
  entry.value = { ...entry.value, rejected: true };
  refreshAvailability(entry);
  if (entry.notice?.id !== `cloud-connect:${folder}`)
    clearConnectionNotice(entry);
  entry.notice = {
    id: `cloud-connect:${folder}`,
    headline:
      kind === "connect"
        ? "Couldn't connect to this cloud workspace"
        : "Couldn't open this cloud workspace",
    description:
      error instanceof Error
        ? workbenchFailureDiagnostic(error)
        : kind === "connect"
          ? "Try opening the workspace again."
          : "Open it again to retry.",
    shown: false,
  };
  reconcileCloudNotice(folder, entry);
}

export function clearWorkbenchConnectionFailure(folder: string): void {
  const entry = entries.get(visibilityKey(folder));
  if (!entry) return;
  clearConnectionNotice(entry);
  if (!entry.value.rejected || entry.value.rejection) return;
  entry.value = { ...entry.value, rejected: false };
  refreshAvailability(entry);
}

export function workbenchAvailabilitySnapshot(
  folder: string,
): WorkspaceAvailability {
  return entryFor(folder).value;
}

export function workbenchAvailabilityStatusSnapshot(
  folder: string,
): AvailabilityDecision {
  const entry = entryFor(folder);
  // Activation presents elapsed time synchronously, even after a hidden gap.
  // Reading alone never creates timers or wakes a workspace.
  // With visible subscribers, the shared clock owns publication. A hidden
  // render must not consume a threshold change before that clock notifies them.
  if (!entry.listeners.size) updateDecision(entry);
  return entry.decision;
}

export function subscribeWorkbenchAvailability(
  folder: string,
  listener: () => void,
): () => void {
  const entry = entryFor(folder);
  entry.listeners.add(listener);
  refreshAvailability(entry);
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  };
}

/** Retry admission without wake. The explicit workspace Start action remains
 * owned by its existing lifecycle controls. Passive tab reads never start VMs. */
export async function reconnectWorkbenchWorkspace(
  folder: string,
): Promise<void> {
  const bridge = getActiveBridge();
  if (!bridge) throw new Error("No workspace connection");
  const target = parseCloudWorkspaceKey(folder);
  if (target && bridge instanceof WorkspaceRuntimeClient) {
    await bridge.warmWorkspace(target);
    clearWorkbenchConnectionFailure(folder);
  } else await bridge.forceReconnect();
}

export function useWorkbenchAvailability(folder: string, active: boolean) {
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    if (!active) return;
    const changed = () => {
      setVisible(document.visibilityState !== "hidden");
    };
    changed();
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, [active]);
  const enabled =
    active && visible &&
    (typeof document === "undefined" || document.visibilityState !== "hidden");
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? subscribeWorkbenchAvailability(folder, listener) : () => {},
    [enabled, folder],
  );
  const read = useCallback(
    () => workbenchAvailabilityStatusSnapshot(folder), [folder],
  );
  const decision = useSyncExternalStore(subscribe, read, read);
  return { ...decision, visible: enabled };
}

export function resetWorkbenchAvailabilityForTests(): void {
  for (const entry of entries.values()) entry.stop();
  entries.clear();
  visibleFrames.clear();
  visibilityListeners.clear();
}
