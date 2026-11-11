import { useCallback, useEffect, useState } from "react";
import type { LocalCommandMac } from "@zeros/protocol/local-commands";
import { connectThisMac, disconnectMac, listWorkspaceMacs, localCommandDevice } from "../../platform/local-commands";
import { isElectron } from "../../platform/runtime";
import { SYNC_CHOOSE_ERRORS, chooseWorkspaceSyncFolder, openWorkspaceSyncTerminal, startWorkspaceSyncStatus, stopWorkspaceSync, useWorkspaceSyncStatus } from "../../platform/workspace-sync";
import { toast } from "../../shared/ui/primitives/elements";
import type { ConnectedMac, ThisMacSync } from "./connected-macs";

export function toConnectedMac(mac: LocalCommandMac, thisDeviceId: string | null): ConnectedMac {
  return { deviceId: mac.deviceId, name: mac.name, thisMac: mac.deviceId === thisDeviceId, reachable: mac.reachable,
    state: mac.active && mac.connected ? "active" : mac.connected ? "connected" : "available", ...(mac.expiresAt ? { expiresAt: Date.parse(mac.expiresAt) } : {}),
    ...(mac.syncing ? { syncing: true } : {}) };
}

/** Read only while the popup is open (no polling, no VM wake), keyed by
 * workspace so another workspace's late reply never shows. Mac app only. */
export function useWorkspaceMacs(workspaceId: string | null, active: boolean) {
  const [state, setState] = useState<{ key: string; macs: ConnectedMac[] } | null>(null);
  const [busy, setBusy] = useState<string | undefined>();
  const [syncBusy, setSyncBusy] = useState(false);
  const syncStatus = useWorkspaceSyncStatus(workspaceId);
  // This Mac's sync status is live only while the popup is open.
  useEffect(() => active && isElectron() ? startWorkspaceSyncStatus() : undefined, [active]);
  const load = useCallback(async (key: string) => {
    const [macs, device] = await Promise.all([listWorkspaceMacs(key), localCommandDevice()]);
    return macs.map(mac => toConnectedMac(mac, device?.deviceId ?? null));
  }, []);
  useEffect(() => {
    if (!active || !workspaceId || !isElectron()) return;
    let cancelled = false;
    void load(workspaceId).then(macs => { if (!cancelled) setState({ key: workspaceId, macs }); }, () => {});
    return () => { cancelled = true; };
  }, [active, workspaceId, load]);
  const act = (deviceId: string, action: () => Promise<unknown>) => {
    if (!workspaceId) return;
    const key = workspaceId;
    setBusy(deviceId);
    void action().then(() => load(key)).then(macs => setState(current => current?.key === key || !current ? { key, macs } : current), () => {})
      .finally(() => setBusy(undefined));
  };
  const syncAct = (action: () => Promise<unknown>) => {
    if (!workspaceId) return;
    const key = workspaceId;
    setSyncBusy(true);
    void action().then(() => load(key)).then(macs => setState(current => current?.key === key || !current ? { key, macs } : current), () => {})
      .finally(() => setSyncBusy(false));
  };
  const sync: ThisMacSync = {
    status: syncStatus, busy: syncBusy,
    onChoose: () => syncAct(async () => {
      const result = await chooseWorkspaceSyncFolder(workspaceId!);
      if (!result.ok && result.reason !== "cancelled") toast.error(SYNC_CHOOSE_ERRORS[result.reason] ?? SYNC_CHOOSE_ERRORS.failed!);
    }),
    onStop: () => syncAct(() => stopWorkspaceSync(workspaceId!)),
    onOpenTerminal: () => { if (workspaceId) void openWorkspaceSyncTerminal(workspaceId).catch(() => toast.error("Couldn't open a terminal in the sync folder.")); },
  };
  return {
    sync,
    macs: state && state.key === workspaceId ? state.macs : null, busyDeviceId: busy,
    connect: (deviceId: string) => act(deviceId, () => connectThisMac(workspaceId!)),
    disconnect: (deviceId: string) => act(deviceId, () => disconnectMac(workspaceId!, deviceId)),
  };
}
