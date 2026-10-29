
import { BrowserWindow, Menu, webContents, type MenuItemConstructorOptions } from "electron";
import { devToolsAccelerator, toggleDevTools } from "./devtools";
import { emitEvent, getMainWindow } from "./ipc/events";
import { IS_DEV } from "./runtime-mode";
import {
  getUpdaterStatus,
  installStagedUpdate,
  subscribeUpdaterStatus,
  type UpdaterStatusSnapshot,
} from "./updater";

/** Available and downloading share a phase because autoDownload starts immediately. */
export function updateMenuItemView(status: UpdaterStatusSnapshot): {
  label: string;
  enabled: boolean;
  action: "check" | "install" | "none";
} {
  switch (status.kind) {
    case "checking":
      return { label: "Checking for Updates…", enabled: false, action: "none" };
    case "available":
    case "downloading":
      return { label: "Downloading…", enabled: false, action: "none" };
    case "ready":
      return { label: "Restart to Update", enabled: true, action: "install" };
    default:
      return { label: "Check for Updates", enabled: true, action: "check" };
  }
}

let menuInstalled = false;

function editHistoryItem(direction: "undo" | "redo"): MenuItemConstructorOptions {
  return {
    // Electron's native roles ignore click handlers. Route app history through
    // its focused surface, and keep DevTools/other contents' native stack.
    label: direction === "undo" ? "Undo" : "Redo",
    accelerator: direction === "undo" ? "CmdOrCtrl+Z"
      : process.platform === "win32" ? "Ctrl+Y" : "CmdOrCtrl+Shift+Z",
    click: () => {
      const focused = webContents.getFocusedWebContents();
      if (!focused || focused.isDestroyed()) return;
      if (focused !== getMainWindow()?.webContents) {
        focused[direction]();
        return;
      }
      emitEvent("menu-edit-history", { direction });
    },
  };
}

export function installAppMenu(): void {
  // Idempotence guard: a second call would stack another status subscription
  // and rebuild the menu twice per transition.
  if (menuInstalled) return;
  menuInstalled = true;

  let updateItem = updateMenuItemView(getUpdaterStatus());

  // Rebuild only when the visible menu state changes, not for every download chunk.
  subscribeUpdaterStatus((status) => {
    const next = updateMenuItemView(status);
    if (
      next.label === updateItem.label &&
      next.enabled === updateItem.enabled &&
      next.action === updateItem.action
    ) {
      return;
    }
    updateItem = next;
    render();
  });

  render();

  function render(): void {
    const fileSubmenu: MenuItemConstructorOptions[] = [
      {
        label: "Open Folder…",
        // macOS menu accelerators run before webContents: leave plain Cmd+O for
        // the renderer's open-in-default-app shortcut.
        accelerator: "CmdOrCtrl+Shift+O",
        // The renderer's shared flow registers the folder as a project, not just an engine root.
        click: () => {
          emitEvent("menu-open-project", {});
        },
      },
    ];

    if (IS_DEV) {
      // Dev can lose preload during source rebuilds; offer recovery even if its
      // toast cannot mount. Cmd+Shift+R reaches the menu before Chromium's blocker,
      // while reloadIgnoringCache avoids preserving a stale bundle.
      fileSubmenu.push(
        { type: "separator" },
        {
          label: "Reload Window",
          accelerator: "CmdOrCtrl+Shift+R",
          click: (_menuItem, browserWindow) => {
            // The menu click handler types `browserWindow` as the base
            // BaseWindow (no webContents); narrow to BrowserWindow (which the app
            // only ever creates) before touching webContents.
            const win =
              browserWindow instanceof BrowserWindow
                ? browserWindow
                : BrowserWindow.getFocusedWindow();
            win?.webContents.reloadIgnoringCache();
          },
        },
      );
    }

    fileSubmenu.push(
      { type: "separator" },
      { role: "close", label: "Close Window" },
    );

    const template: MenuItemConstructorOptions[] = [
      //    app menu on Darwin). ──
      {
        label: "Zeros",
        submenu: [
          { role: "about", label: "About Zeros" },
          {
            label: updateItem.label,
            enabled: updateItem.enabled,
            click: () => {
              if (updateItem.action === "install") {
                // Ready state: apply the staged build now (quit → replace →
                // relaunch). Same path as the ready toast's Restart button.
                installStagedUpdate();
                return;
              }
              // Share the renderer's manual/background update feedback path.
              emitEvent("menu-check-for-updates", {});
            },
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide", label: "Hide Zeros" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: "Quit Zeros" },
        ],
      },

      {
        label: "File",
        submenu: fileSubmenu,
      },

      {
        label: "Edit",
        submenu: [
          editHistoryItem("undo"),
          editHistoryItem("redo"),
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },

      // Target the main window and detach DevTools: the built-in role targets the
      // focused window (possibly DevTools itself), and docking squeezes the layout.
      // Packaged menus omit reload because it tears down renderer subscriptions;
      // main also suppresses Chromium's default shortcuts. Dev recovery is above.
      {
        label: "View",
        submenu: [
          {
            label: "Toggle Developer Tools",
            accelerator: devToolsAccelerator(process.platform),
            // Always the app window, never `browserWindow` / getFocusedWindow():
            // the detached DevTools window holds focus while you're typing in the
            // console, and ⌥⌘I from there must close the panel, not inspect it.
            click: () => {
              toggleDevTools(getMainWindow());
            },
          },
          { type: "separator" },
          { role: "resetZoom" }, // Cmd+0
          { role: "zoomIn" }, // Cmd+=
          { role: "zoomOut" }, // Cmd+-
          { type: "separator" },
          { role: "togglefullscreen" }, // Ctrl+Cmd+F
        ],
      },

      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "zoom" }],
      },
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }
}
