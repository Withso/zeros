import { webContents, type MenuItemConstructorOptions, type WebContents } from "electron";
import { emitEvent, getMainWindow } from "./ipc/events";

export function editHistoryItem(direction: "undo" | "redo", owner?: WebContents): MenuItemConstructorOptions {
  return {
    // Native role items bypass click and Blink may have no history for a custom
    // editor. Both menus must ask the focused renderer surface first.
    label: direction === "undo" ? "Undo" : "Redo",
    accelerator: direction === "undo" ? "CmdOrCtrl+Z"
      : process.platform === "win32" ? "Ctrl+Y" : "CmdOrCtrl+Shift+Z",
    click: () => {
      const focused = webContents.getFocusedWebContents();
      if (!focused || focused.isDestroyed() || (owner && focused !== owner)) return;
      if (focused !== getMainWindow()?.webContents) {
        focused[direction]();
        return;
      }
      emitEvent("menu-edit-history", { direction });
    },
  };
}
