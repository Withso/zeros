import { useCallback, useEffect, useState } from "react";
import type { LocalCommandMac } from "@zeros/protocol/local-commands";
import { connectThisMac, disconnectMac, listWorkspaceMacs, localCommandDevice } from "../../platform/local-commands";
import { isElectron } from "../../platform/runtime";
import type { ConnectedMac } from "./connected-macs";

export function toConnectedMac(mac: LocalCommandMac, thisDeviceId: string | null): ConnectedMac {
  return { deviceId: mac.deviceId, name: mac.name, thisMac: mac.deviceId === thisDeviceId, reachable: mac.reachable,
    state: mac.active && mac.connected ? "active" : mac.connected ? "connected" : "available", ...(mac.expiresAt ? { expiresAt: Date.parse(mac.expiresAt) } : {}) };
}

/** Read only while the popup is open (no polling, no VM wake), keyed by
 * workspace so another workspace's late reply never shows. Mac app only. */
export function useWorkspaceMacs(workspaceId: string | null, active: boolean) {
  const [state, setState] = useState<{ key: string; macs: ConnectedMac[] } | null>(null);
  const [busy, setBusy] = useState<string | undefined>();
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
  return {
    macs: state && state.key === workspaceId ? state.macs : null, busyDeviceId: busy,
    connect: (deviceId: string) => act(deviceId, () => connectThisMac(workspaceId!)),
    disconnect: (deviceId: string) => act(deviceId, () => disconnectMac(workspaceId!, deviceId)),
  };
}
