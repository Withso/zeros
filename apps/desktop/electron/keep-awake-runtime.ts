import { powerMonitor, powerSaveBlocker, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { KEEP_AWAKE_ACTIVITY_REQUEST, type KeepAwakePreferences } from "../shared/keep-awake";
import { getAppSetting, setAppSetting } from "./ipc/commands/app";
import { emitEvent, getMainWindow } from "./ipc/events";
import { setCommand } from "./ipc/router";
import { KeepAwakeController } from "./keep-awake";
import { readMacPowerSource } from "./mac-power-source";

const PREFERENCE_KEY = "keepAwakeWhileAgentsRunning";

/** Install after app readiness. Only the trusted main frame can publish the
 * aggregate; no prompt text, paths, credentials or process IDs cross IPC. */
export function installKeepAwake() {
  const supported = process.platform === "darwin";
  let enabled = getAppSetting(PREFERENCE_KEY) === "true";
  let window: BrowserWindow | null = null;
  let detachWindow = () => {};
  let disposed = false;
  const controller = new KeepAwakeController({
    supported,
    enabled,
    readPower: readMacPowerSource,
    start: () => powerSaveBlocker.start("prevent-app-suspension"),
    stop: id => { powerSaveBlocker.stop(id); },
    requestActivity: () => {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
        emitEvent(KEEP_AWAKE_ACTIVITY_REQUEST, null);
    },
  });
  const preferences = (): KeepAwakePreferences => ({ enabled, supported });
  const requireMainFrame = (event: IpcMainInvokeEvent) => {
    if (disposed || !window || window !== getMainWindow() || window.isDestroyed() ||
        event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error("Keep awake requires the app window.");
  };
  setCommand("keep_awake_get", (_args, event) => {
    requireMainFrame(event);
    return preferences();
  });
  setCommand("keep_awake_set", (args, event) => {
    requireMainFrame(event);
    if (typeof args.enabled !== "boolean") throw new Error("Invalid keep awake preference.");
    if (args.enabled && !supported) throw new Error("Keep awake is available on macOS.");
    setAppSetting(PREFERENCE_KEY, String(args.enabled));
    enabled = args.enabled;
    controller.setEnabled(enabled);
    return preferences();
  });
  setCommand("keep_awake_activity", (args, event) => {
    requireMainFrame(event);
    if (typeof args.active !== "boolean") throw new Error("Invalid keep awake activity.");
    controller.reportActivity(args.active);
  });

  const powerChanged = () => controller.powerChanged();
  const suspend = () => controller.clearActivity();
  const resume = () => controller.requestActivity();
  if (supported) {
    powerMonitor.on("on-battery", powerChanged);
    powerMonitor.on("on-ac", powerChanged);
    powerMonitor.on("suspend", suspend);
    powerMonitor.on("resume", resume);
  }

  return {
    attachWindow(next: BrowserWindow): void {
      detachWindow();
      controller.clearActivity();
      window = next;
      const contents = next.webContents;
      const clear = () => controller.clearActivity();
      const navigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) clear();
      };
      const closed = () => {
        clear();
        detachWindow();
        window = null;
      };
      next.on("closed", closed);
      contents.on("did-start-navigation", navigation);
      contents.on("render-process-gone", clear);
      contents.on("unresponsive", clear);
      contents.on("responsive", resume);
      detachWindow = () => {
        next.off("closed", closed);
        contents.off("did-start-navigation", navigation);
        contents.off("render-process-gone", clear);
        contents.off("unresponsive", clear);
        contents.off("responsive", resume);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      controller.dispose();
      detachWindow();
      window = null;
      if (supported) {
        powerMonitor.off("on-battery", powerChanged);
        powerMonitor.off("on-ac", powerChanged);
        powerMonitor.off("suspend", suspend);
        powerMonitor.off("resume", resume);
      }
    },
  };
}
