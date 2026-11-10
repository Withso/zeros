import { app, BrowserWindow, Notification, type IpcMainInvokeEvent } from "electron";
import { cloudWorkspaceDesktopCapabilityEnabled } from "../../src/engine/cloud-workspace-capability";
import { controlPlaneFetch } from "../control-plane-fetch";
import { getAppSetting, setAppSetting } from "../ipc/commands/app";
import { getSessionUserForMain, getValidAccessTokenForMain, onBeforeMainSignOut, onMainAuthSessionChanged } from "../ipc/commands/auth-session";
import { emitEvent, getMainWindow } from "../ipc/events";
import { setCommand } from "../ipc/router";
import { IS_LOCAL_DEVELOPMENT } from "../runtime-mode";
import { controlPlaneBaseUrl } from "../workos-desktop-account";
import { DeviceControl, parseEventStream } from "./control";
import { computerName, deviceIdFor } from "./device-identity";
import { LocalCommandJournal } from "./journal";
import { runLocalCommand } from "./runner";
import { LocalCommandService, type LocalCommandApprovalView, type LocalCommandDecision } from "./service";

import { LOCAL_COMMAND_APPROVALS_EVENT, LOCAL_COMMAND_OPEN_EVENT } from "../../shared/local-commands";
const ALWAYS_ALLOW_KEY = "localCommandsAlwaysAllow";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Main owns every decision and execution; the renderer only shows approvals
 * and relays the person's choice for a request main raised. */
export function installLocalCommands(): { dispose(): Promise<void> } {
  const enabled = !IS_LOCAL_DEVELOPMENT && cloudWorkspaceDesktopCapabilityEnabled();
  const control = new DeviceControl({ fetch: controlPlaneFetch, baseUrl: controlPlaneBaseUrl, token: getValidAccessTokenForMain });
  const notifications = new Map<string, Notification>();
  const showApproval = (requestId: string) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
    emitEvent(LOCAL_COMMAND_OPEN_EVENT, { requestId });
  };
  const notify = (approval: LocalCommandApprovalView) => {
    if (!Notification.isSupported()) return;
    // Notification Center can show on a lock screen: no command text, only where it comes from.
    const notification = new Notification({ title: `Run a command on ${approval.macName}?`,
      body: `An agent in ${approval.workspaceTitle ?? approval.workspaceName} asks to run a command. Open Zeros to decide.` });
    notification.on("click", () => showApproval(approval.requestId));
    notifications.set(approval.requestId, notification);
    notification.show();
  };
  const service = new LocalCommandService({
    control,
    events: async function* (device, signal) { yield* parseEventStream(await control.events(device, signal)); },
    journal: accountId => LocalCommandJournal.open(app.getPath("userData"), accountId),
    run: (input, signal) => runLocalCommand(input, { signal }),
    identity: { deviceId: accountId => deviceIdFor({ get: getAppSetting, set: setAppSetting }, accountId), name: () => computerName() },
    settings: { alwaysAllow: () => getAppSetting(ALWAYS_ALLOW_KEY) === "true", setAlwaysAllow: value => setAppSetting(ALWAYS_ALLOW_KEY, String(value)) },
    session: async () => { const user = getSessionUserForMain(); return user ? { accountId: user.accountId, sessionId: user.sessionId } : null; },
    publish: approvals => {
      for (const [requestId, notification] of notifications) if (!approvals.some(approval => approval.requestId === requestId)) { notification.close(); notifications.delete(requestId); }
      emitEvent(LOCAL_COMMAND_APPROVALS_EVENT, approvals);
    },
    notify: approval => { if (!BrowserWindow.getFocusedWindow()) notify(approval); },
  });

  let current: string | null = null, changing = Promise.resolve();
  const sync = () => {
    changing = changing.then(async () => {
      const user = enabled ? getSessionUserForMain() : null, next = user ? `${user.accountId}:${user.sessionId}` : null;
      if (next === current) return;
      await service.stop();
      current = next;
      if (next) await service.start();
    }).catch(() => {});
  };
  const stopSessionWatch = onMainAuthSessionChanged(sync);
  const stopSignOut = onBeforeMainSignOut(() => service.beforeSignOut());
  sync();

  const requireMainFrame = (event: IpcMainInvokeEvent) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error("Local commands require the app window.");
  };
  const requestId = (value: unknown) => { if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid local command request."); return value; };
  setCommand("local_commands_approvals", (_args, event) => { requireMainFrame(event); return service.approvals(); });
  setCommand("local_commands_decide", async (args, event) => {
    requireMainFrame(event);
    const decision = args.decision;
    if (decision !== "deny" && decision !== "yes" && decision !== "always") throw new Error("Invalid local command decision.");
    await service.decide(requestId(args.requestId), decision as LocalCommandDecision);
    return true;
  });
  /** The renderer asks when the request's workspace is not open on screen. */
  setCommand("local_commands_notify", (args, event) => {
    requireMainFrame(event);
    const approval = service.approvals().find(item => item.requestId === requestId(args.requestId));
    if (approval && !notifications.has(approval.requestId)) notify(approval);
    return true;
  });
  setCommand("local_commands_always_get", (_args, event) => { requireMainFrame(event); return getAppSetting(ALWAYS_ALLOW_KEY) === "true"; });
  setCommand("local_commands_always_set", (args, event) => {
    requireMainFrame(event);
    if (typeof args.enabled !== "boolean") throw new Error("Invalid local command setting.");
    setAppSetting(ALWAYS_ALLOW_KEY, String(args.enabled));
    return args.enabled;
  });
  setCommand("local_commands_device", (_args, event) => {
    requireMainFrame(event);
    const device = service.currentDevice();
    return device ? { deviceId: device.deviceId, headers: service.deviceHeaders() } : null;
  });
  setCommand("local_commands_connect", async (args, event) => {
    requireMainFrame(event);
    const device = service.currentDevice();
    if (!device || typeof args.workspaceId !== "string" || !UUID.test(args.workspaceId)) throw new Error("This Mac is not ready for local commands.");
    return control.connect(device, args.workspaceId);
  });
  setCommand("local_commands_disconnect", async (args, event) => {
    requireMainFrame(event);
    const device = service.currentDevice();
    if (!device || typeof args.workspaceId !== "string" || !UUID.test(args.workspaceId) || typeof args.deviceId !== "string" || !UUID.test(args.deviceId))
      throw new Error("This Mac is not ready for local commands.");
    return control.disconnect(device, args.workspaceId, args.deviceId);
  });
  return { dispose: async () => { stopSessionWatch(); stopSignOut(); for (const notification of notifications.values()) notification.close(); await service.stop(); } };
}
