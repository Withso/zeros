import { dialog, type IpcMainInvokeEvent } from "electron";
import type { LocalCommandDevice } from "@zeros/protocol/local-commands";
import { getAppSetting, setAppSetting } from "../ipc/commands/app";
import { getSessionUserForMain, onBeforeMainSignOut, onMainAuthSessionChanged } from "../ipc/commands/auth-session";
import { openInTerminal } from "../ipc/commands/shell";
import { emitEvent, getMainWindow } from "../ipc/events";
import { setCommand } from "../ipc/router";
import type { DeviceControl } from "../local-commands/control";
import { deviceIdFor } from "../local-commands/device-identity";
import { SyncRootError } from "./engine";
import { SyncManager } from "./manager";
import WebSocket from "ws";
import { DeviceControlError } from "../local-commands/control";
import { DirectSyncConnection, SyncConnectError, type DirectDeps, type SyncSocket } from "./connection";
import { WORKSPACE_SYNC_STATUS_EVENT } from "../../shared/workspace-sync";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Order 3 in main: folders stay on this Mac, writes happen only here, and the
 * renderer sees statuses, never paths. */
export function installWorkspaceSync(local: { enabled: boolean; control: DeviceControl; device(): LocalCommandDevice | undefined }): { dispose(): Promise<void> } {
  const store = { get: getAppSetting, set: setAppSetting };
  /** The grant route (D+H) maps refusals to what the popup says. */
  const grantFor = async (workspaceId: string): ReturnType<DirectDeps["grant"]> => {
    const device = local.device();
    if (!device) throw new SyncConnectError("not_connected");
    try { return await local.control.syncGrant(device, workspaceId); }
    catch (error) {
      if (!(error instanceof DeviceControlError)) throw new SyncConnectError("unavailable");
      if (error.status === 401) throw new SyncConnectError("signed_out");
      if (error.code === "worker_update_required") throw new SyncConnectError("update_required");
      if (error.code === "cloud_workspace_not_running") throw new SyncConnectError("paused");
      if (error.code === "mac_not_connected" || error.status === 403) throw new SyncConnectError("not_connected");
      throw new SyncConnectError("unavailable");
    }
  };
  // The same dial as the control plane's dialWorker: port-auth cookie and grant headers, no redirects.
  const dial: DirectDeps["dial"] = (url, protocol, headers) => {
    const ws = new WebSocket(url, protocol, { headers, maxPayload: 16 * 1024 * 1024 + 4096, perMessageDeflate: false, followRedirects: false, handshakeTimeout: 15_000 });
    return ws as unknown as SyncSocket;
  };
  const manager = new SyncManager({
    settings: { get: key => getAppSetting(key), set: (key, value) => setAppSetting(key, value) },
    identity: () => { const user = getSessionUserForMain(); return user ? { accountId: user.accountId, deviceId: deviceIdFor(store, user.accountId) } : null; },
    connect: (workspaceId, handlers) => DirectSyncConnection.connect({ grant: () => grantFor(workspaceId), dial }, handlers),
    setSyncing: async (workspaceId, syncing) => { const device = local.device(); if (device) await local.control.setSyncing(device, workspaceId, syncing); },
    publish: statuses => emitEvent(WORKSPACE_SYNC_STATUS_EVENT, statuses),
  });
  let changing = Promise.resolve();
  const sync = () => { changing = changing.then(() => local.enabled && getSessionUserForMain() ? manager.start() : manager.stop()).catch(() => {}); };
  const stopSessionWatch = onMainAuthSessionChanged(sync);
  const stopSignOut = onBeforeMainSignOut(() => manager.stop());
  sync();

  const requireMainFrame = (event: IpcMainInvokeEvent) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error("Sync requires the app window.");
  };
  const workspace = (value: unknown) => { if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid workspace."); return value; };
  setCommand("workspace_sync_statuses", (_args, event) => { requireMainFrame(event); return manager.statuses(); });
  /** The native open panel chooses the folder; the renderer never names a path. */
  setCommand("workspace_sync_choose", async (args, event) => {
    requireMainFrame(event);
    const workspaceId = workspace(args.workspaceId);
    if (!local.enabled) return { ok: false, reason: "unavailable" };
    const window = getMainWindow();
    const options = { title: "Sync to a local directory", buttonLabel: "Sync Here", message: "Choose an empty folder, or this workspace's earlier sync folder.",
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const folder = picked.filePaths[0];
    if (picked.canceled || !folder) return { ok: false, reason: "cancelled" };
    try { await manager.enable(workspaceId, folder); return { ok: true }; }
    catch (error) { return { ok: false, reason: error instanceof SyncRootError ? error.code : "failed" }; }
  });
  setCommand("workspace_sync_stop", async (args, event) => { requireMainFrame(event); await manager.disable(workspace(args.workspaceId)); return true; });
  /** A Local terminal (Terminal.app, this Mac's shell) in the sync root; registers nothing. */
  setCommand("workspace_sync_open_terminal", async (args, event) => {
    requireMainFrame(event);
    const folder = manager.folderFor(workspace(args.workspaceId));
    if (!folder) throw new Error("This workspace is not synced on this Mac.");
    await openInTerminal({ path: folder }, event);
    return true;
  });
  return { dispose: async () => { stopSessionWatch(); stopSignOut(); await manager.stop(); } };
}
