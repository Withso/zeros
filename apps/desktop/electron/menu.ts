// ──────────────────────────────────────────────────────────
// Native application menu
// ──────────────────────────────────────────────────────────
//
// Electron application menu. Five submenus:
// Zeros (app menu), File, Edit, View, Window.
//
// File > Open Folder / Cmd+Shift+O emits the `menu-open-project` event and lets
// the renderer drive the SAME `openProject()` flow as the sidebar "+" and the
// welcome screen (AddProjectProvider). That flow registers the picked folder
// as a project (upsert + default chat), so the menu path lands a real sidebar
// row instead of only respawning the engine and stranding the loading shimmer.
// (Previously the menu called the `open_project_folder` command directly, which
// emitted project-opening — painting the shimmer — but never upserted.)
// ──────────────────────────────────────────────────────────

import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { devToolsAccelerator, toggleDevTools } from "./devtools";
import { emitEvent, getMainWindow } from "./ipc/events";
import { IS_DEV } from "./runtime-mode";
import {
  getUpdaterStatus,
  installStagedUpdate,
  subscribeUpdaterStatus,
  type UpdaterStatusSnapshot,
} from "./updater";

/** What the app menu's update item should show for a given updater state.
 *  Exported for tests. The item is a live status surface, not a static command:
 *
 *    idle / error  → "Check for Updates"      (runs the manual check)
 *    checking      → "Checking for Updates…"  (disabled — check already running)
 *    available     → "Downloading…"           (autoDownload starts immediately on
 *    downloading   → "Downloading…"            update-available, so both kinds
 *                                              are one user-visible phase)
 *    ready         → "Restart to Update"      (applies the staged build now)
 *
 *  Same wiring on every channel — alpha, beta and stable all share this menu;
 *  dev builds never publish a non-idle status, so they keep the plain item. */
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

export function installAppMenu(): void {
  // Idempotence guard: a second call would stack another status subscription
  // and rebuild the menu twice per transition.
  if (menuInstalled) return;
  menuInstalled = true;

  let updateItem = updateMenuItemView(getUpdaterStatus());

  // Electron menu-item labels are fixed at construction, so a state change
  // rebuilds the whole menu. That's cheap (~40 items) and only happens on
  // phase transitions — updateMenuItemView collapses download-progress spam
  // into one stable "Downloading…" label, so the equality check below drops
  // per-chunk events entirely.
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
    // ── File submenu ─────────────────────────────────────
    //
    // Assembled imperatively so we can splice a dev-only
    // "Reload Window" entry in without duplicating the surrounding
    // items. See the comment beside the IS_DEV append below for
    // why the carve-out exists.
    const fileSubmenu: MenuItemConstructorOptions[] = [
      {
        label: "Open Folder…",
        // Cmd+Shift+O, NOT Cmd+O: plain ⌘O belongs to the topbar's "open
        // worktree in default app" shortcut (renderer/shell/conversation/
        // conversation-header.tsx). macOS menu
        // accelerators run BEFORE webContents sees the keystroke, so keeping
        // ⌘O here would swallow it and the renderer shortcut could never fire.
        accelerator: "CmdOrCtrl+Shift+O",
        // Hand off to the renderer's openProject() flow so this entry point
        // shares one code path with the sidebar "+" / welcome screen (and so
        // the picked folder actually registers as a project). The renderer
        // invokes the open_project_folder command itself from there.
        click: () => {
          emitEvent("menu-open-project", {});
        },
      },
    ];

    if (IS_DEV) {
      // Dev-only Reload Window — the production app intentionally
      // has no reload affordance (see the comment block on the View
      // submenu below). But in `pnpm electron:dev` the preload
      // bridge can fail to inject after a tsup-watch mid-write, a
      // branch switch, or a preload syntax error, leaving the
      // renderer stuck in "browser dev mode" with no working
      // terminal / git / browser tab. The toast-based recovery
      // (`apps/desktop/src/renderer/shell/top-bar.tsx` → status === "preload-missing")
      // already offers a Reload button for this case, but a menu
      // item is more discoverable when something else has gone
      // sideways (e.g. the toast subsystem itself failed to mount).
      //
      // Accelerator: Cmd+Shift+R, NOT Cmd+R. Plain Cmd+R is too
      // easy to fat-finger and the renderer reload still tears down
      // live PTYs / xterms / agent sockets — exactly why it was
      // pulled in 2026-05-28. Cmd+R is also still suppressed at the
      // BrowserWindow level (apps/desktop/electron/main.ts before-input-event).
      // macOS menu accelerators run BEFORE webContents sees the
      // keystroke, so Cmd+Shift+R hits this menu item directly
      // without being trapped by that blocker.
      //
      // `reloadIgnoringCache()` (not plain reload()) so a stale JS
      // bundle in Chromium's HTTP cache can't keep the broken state
      // pinned — every reload starts fresh against the dev server.
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
      // ── Zeros app menu (macOS only — first item always becomes the
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
              // Hand off to the renderer (UpdateNotifications), which runs the
              // manual updater_check and surfaces the result — the "New update
              // available" toast, or a "You're up to date!" toast when nothing's
              // newer. Kept in the renderer so the check shares one UX path with
              // the background poll.
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

      // ── File ──────────────────────────────────────────────
      //
      // Assembled above so the dev-only Reload Window entry can be
      // spliced in without duplicating the surrounding items.
      {
        label: "File",
        submenu: fileSubmenu,
      },

      // ── Edit ──────────────────────────────────────────────
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },

      // ── View ──────────────────────────────────────────────
      //
      // Standard Electron role accelerators — these work in both dev
      // and packaged builds.
      //
      // DevTools works on EVERY channel (dev, Alpha, Beta, Production).
      // It used to be dev-only in practice: packaged builds force-closed
      // DevTools the frame after it opened, which read as a flicker and
      // left shipped builds undebuggable. See apps/desktop/electron/devtools.ts for
      // why that block is gone and what replaced it.
      //
      // NOT `role: "toggleDevTools"` — the role toggles the FOCUSED
      // window and gives no control over dock mode. Both matter here:
      // DevTools must open detached (a docked panel breaks the
      // three-column minimum-width layout), and when the detached
      // DevTools window itself has focus the role would open
      // DevTools-on-DevTools instead of closing the panel.
      //
      // 2026-05-28: `reload` and `forceReload` are intentionally
      // OMITTED from the View menu. A renderer reload tears down
      // PTY listeners / xterm / agent IPC sockets — every Cmd+R
      // produced a flurry of `[process exited with code 1]` + zsh
      // save-session noise and burned anything the user had typed.
      // Production users never need an in-place page reload (auto-
      // updates restart the whole app, which is the canonical fresh-
      // state flow); plain Cmd+R / F5 / Cmd+Shift+R are also blocked
      // at the BrowserWindow level via `before-input-event` in
      // apps/desktop/electron/main.ts to defeat Chromium's built-in defaults.
      //
      // Dev exception: see the File-menu assembly above for a
      // dev-only "Reload Window" item (Cmd+Shift+R) that recovers
      // from preload-bridge injection failures in `pnpm electron:dev`.
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

      // ── Window ────────────────────────────────────────────
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "zoom" }],
      },
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }
}
