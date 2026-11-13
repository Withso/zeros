import { dialog, shell, type IpcMainInvokeEvent } from "electron";
import { mkdir } from "node:fs/promises";
import { defaultSyncFolder, syncChannelFolder } from "./default-folder";
import { zerosWorkspacesRoot } from "../../src/engine/db/paths";
import { SyncWantedFollower } from "./wanted";
import type { WorkspaceSyncStatus } from "../../shared/workspace-sync";
import type { LocalCommandDevice } from "@zeros/protocol/local-commands";
import { getAppSetting, setAppSetting } from "../ipc/commands/app";
import { getSessionUserForMain, onBeforeMainSignOut, onMainAuthSessionChanged } from "../ipc/commands/auth-session";
import { openInTerminal } from "../ipc/commands/shell";
import { emitEvent, getMainWindow } from "../ipc/events";
import { setCommand } from "../ipc/router";
import type { DeviceControl } from "../local-commands/control";
import { deviceIdFor } from "../local-commands/device-identity";
import { SyncEngine, SyncRootError } from "./engine";
import { SyncManager } from "./manager";
import { CloudContextArchiver } from "./archive";
import { CloudGitMirror } from "./cloud-git";
import { maintainSharedGitStores } from "./shared-git";
import WebSocket from "ws";
import { DeviceControlError } from "../local-commands/control";
import { DirectSyncConnection, SyncConnectError, syncGrantRefusal, type DirectDeps, type SyncSocket } from "./connection";
import { WORKSPACE_SYNC_STATUS_EVENT } from "../../shared/workspace-sync";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Order 3 in main: folders stay on this Mac, writes happen only here, and the
 * renderer sees statuses, never paths. */
export function installWorkspaceSync(local: { enabled: boolean; control: DeviceControl; device(): LocalCommandDevice | undefined; onSyncHint(listener: () => void): () => void }): { dispose(): Promise<void> } {
  const store = { get: getAppSetting, set: setAppSetting };
  let ownerGeneration = 0;
  const ownerKey = () => {
    const account = getSessionUserForMain(), device = local.device();
    return account && device ? JSON.stringify([ownerGeneration, account.accountId, device.deviceId, device.registrationId, device.instanceId]) : null;
  };
  /** The grant route (D+H) maps refusals to what the popup says. */
  const grantFor = async (workspaceId: string): ReturnType<DirectDeps["grant"]> => {
    const device = local.device();
    if (!device) throw new SyncConnectError("not_connected");
    try { return await local.control.syncGrant(device, workspaceId); }
    catch (error) { throw error instanceof DeviceControlError ? syncGrantRefusal(error) : new SyncConnectError("unavailable"); }
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
    unavailable: () => { void follower.hint(); },
    publish: statuses => emitEvent(WORKSPACE_SYNC_STATUS_EVENT, withFolders(statuses)),
    open: (folder, identity, deps = {}) => {
      const key = ownerKey(), device = local.device();
      const isCurrent = () => key !== null && key === ownerKey() && deps.isCurrent?.() !== false;
      return SyncEngine.open(folder, identity, { ...deps, gitFactory: (root, meta) => new CloudGitMirror(root, meta, {
        channel: syncChannelFolder(zerosWorkspacesRoot()), workspaceId: identity.workspaceId, isCurrent, signal: deps.signal,
        scope: () => device ? local.control.workspaceGitScope(device, identity.workspaceId, deps.signal) : Promise.reject(new Error("Device is not registered.")),
        token: () => device ? local.control.githubReadToken(device, identity.workspaceId, deps.signal) : Promise.reject(new Error("Device is not registered.")),
        log: line => console.info(`[workspace-sync] ${line}`),
      }) });
    },
  });
  // 12.z: the renderer may see This Mac's own folder (it is the person's Mac); the server never does.
  const withFolders = (statuses: WorkspaceSyncStatus[]): WorkspaceSyncStatus[] =>
    statuses.map(status => { const folder = manager.folderFor(status.workspaceId); return folder ? { ...status, folder } : status; });
  const archives = new CloudContextArchiver({
    ownerKey,
    read: workspaceId => {
      const device = local.device();
      if (!device) return Promise.reject(new Error("Device is not registered."));
      return local.control.archiveWorkspaceState(device, workspaceId);
    },
    manager, channel: syncChannelFolder(zerosWorkspacesRoot()),
  });
  // 12.z: main follows what the person wants synced on this Mac, whatever the renderer shows.
  const follower = new SyncWantedFollower({
    list: cursor => { const device = local.device(); if (!device) return Promise.reject(new Error("not registered")); return local.control.syncConnections(device, cursor); },
    running: () => manager.statuses().map(status => status.workspaceId),
    folderFor: workspaceId => manager.folderFor(workspaceId),
    enable: (workspaceId, folder) => manager.enable(workspaceId, folder),
    disable: workspaceId => manager.disable(workspaceId),
    archive: (workspaceId, isCurrent) => archives.inspect(workspaceId, isCurrent),
    identityKey: ownerKey,
    mkdir: folder => mkdir(folder, { recursive: true, mode: 0o755 }).then(() => {}),
    channel: syncChannelFolder(zerosWorkspacesRoot()), now: Date.now, log: line => console.info(`[workspace-sync] ${line}`),
  });
  const stopHints = local.onSyncHint(() => { void follower.hint(); });
  let changing = Promise.resolve(), resetRequested = false;
  const sync = () => {
    changing = changing.then(async () => {
      if (resetRequested) { resetRequested = false; await manager.stop(); }
      if (local.enabled && getSessionUserForMain()) { await manager.start(); follower.start(); }
      else { follower.stop(); await manager.stop(); }
    }).catch(() => {});
  };
  const stopSessionWatch = onMainAuthSessionChanged(() => { ownerGeneration++; resetRequested = true; follower.stop(); sync(); });
  const stopSignOut = onBeforeMainSignOut(() => { ownerGeneration++; resetRequested = true; follower.stop(); return manager.stop(); });
  sync();
  const maintenanceStop = new AbortController();
  let maintenance: Promise<void> | undefined;
  const maintain = () => {
    if (!local.enabled || maintenance || maintenanceStop.signal.aborted) return;
    maintenance = maintainSharedGitStores(syncChannelFolder(zerosWorkspacesRoot()), { signal: maintenanceStop.signal, log: line => console.info(`[workspace-sync] ${line}`) })
      .catch(() => {}).finally(() => { maintenance = undefined; });
  };
  const maintenanceTimer = setInterval(maintain, 3600_000); maintenanceTimer.unref?.(); maintain();

  const requireMainFrame = (event: IpcMainInvokeEvent) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error("Sync requires the app window.");
  };
  const workspace = (value: unknown) => { if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid workspace."); return value; };
  setCommand("workspace_sync_statuses", (_args, event) => { requireMainFrame(event); return withFolders(manager.statuses()); });
  const label = (value: unknown, name: string) => { if (typeof value !== "string" || value.length > 200) throw new Error(`Invalid ${name}.`); return value; };
  /** 12.z: the switch. No picker: ~/zeros/cloud-sync/<repository>/<workspace>, created if missing (the empty-or-own rule still applies). */
  setCommand("workspace_sync_enable", async (args, event) => {
    requireMainFrame(event);
    const workspaceId = workspace(args.workspaceId);
    if (!local.enabled) return { ok: false, reason: "unavailable" };
    const folder = manager.folderFor(workspaceId) ?? defaultSyncFolder(syncChannelFolder(zerosWorkspacesRoot()), label(args.repository, "repository"), label(args.workspace, "workspace"));
    follower.noteLocalChange(workspaceId);
    try { await mkdir(folder, { recursive: true, mode: 0o755 }); await manager.enable(workspaceId, folder); return { ok: true }; }
    catch (error) { return { ok: false, reason: error instanceof SyncRootError ? error.code : "failed" }; }
  });
  setCommand("workspace_sync_reveal", async (args, event) => {
    requireMainFrame(event);
    const folder = manager.folderFor(workspace(args.workspaceId));
    if (!folder) throw new Error("This workspace is not synced on this Mac.");
    const failure = await shell.openPath(folder);
    if (failure) throw new Error("The sync folder could not be opened.");
    return true;
  });
  /** 12.z: another of this person's Macs; that Mac starts or stops with its own default folder. */
  setCommand("workspace_sync_set_wanted", async (args, event) => {
    requireMainFrame(event);
    const workspaceId = workspace(args.workspaceId), deviceId = workspace(args.deviceId);
    if (typeof args.wanted !== "boolean") throw new Error("Invalid wanted.");
    const device = local.device();
    if (!device) return { ok: false, reason: "not_connected" };
    await local.control.setSyncWanted(device, workspaceId, deviceId, args.wanted);
    return { ok: true };
  });
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
    follower.noteLocalChange(workspaceId);
    try { await manager.enable(workspaceId, folder); return { ok: true }; }
    catch (error) { return { ok: false, reason: error instanceof SyncRootError ? error.code : "failed" }; }
  });
  setCommand("workspace_sync_stop", async (args, event) => {
    requireMainFrame(event);
    const workspaceId = workspace(args.workspaceId);
    follower.noteLocalChange(workspaceId);
    await manager.disable(workspaceId);
    return true;
  });
  /** A Local terminal (Terminal.app, this Mac's shell) in the sync root; registers nothing. */
  setCommand("workspace_sync_open_terminal", async (args, event) => {
    requireMainFrame(event);
    const folder = manager.folderFor(workspace(args.workspaceId));
    if (!folder) throw new Error("This workspace is not synced on this Mac.");
    await openInTerminal({ path: folder }, event);
    return true;
  });
  return { dispose: async () => {
    stopSessionWatch(); stopSignOut(); stopHints(); follower.stop();
    clearInterval(maintenanceTimer); maintenanceStop.abort();
    await Promise.all([manager.stop(), maintenance]);
  } };
}
