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
import { emitEvent } from "./ipc/events";
import { IS_DEV } from "./runtime-mode";

export function installAppMenu(): void {
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
      // worktree in default app" shortcut (column2-topbar.tsx). macOS menu
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
    // (`src/shell/column1.tsx` → status === "preload-missing")
    // already offers a Reload button for this case, but a menu
    // item is more discoverable when something else has gone
    // sideways (e.g. the toast subsystem itself failed to mount).
    //
    // Accelerator: Cmd+Shift+R, NOT Cmd+R. Plain Cmd+R is too
    // easy to fat-finger and the renderer reload still tears down
    // live PTYs / xterms / agent sockets — exactly why it was
    // pulled in 2026-05-28. Cmd+R is also still suppressed at the
    // BrowserWindow level (electron/main.ts before-input-event).
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
          label: "Check for Updates",
          // Hand off to the renderer (UpdateNotifications), which runs the
          // manual updater_check and surfaces the result — the "New update
          // available" toast, or a "You're up to date!" toast when nothing's
          // newer. Kept in the renderer so the check shares one UX path with
          // the background poll.
          click: () => {
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
    // and packaged builds. The DevTools accelerator is effectively
    // dev-only: packaged builds force-close DevTools (see
    // main.ts:363-367), so Inspect Element is a debugging affordance
    // for the dev build.
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
    // electron/main.ts to defeat Chromium's built-in defaults.
    //
    // Dev exception: see the File-menu assembly above for a
    // dev-only "Reload Window" item (Cmd+Shift+R) that recovers
    // from preload-bridge injection failures in `pnpm electron:dev`.
    {
      label: "View",
      submenu: [
        { role: "toggleDevTools" },      // Cmd+Alt+I (Cmd+Opt+I)
        { type: "separator" },
        { role: "resetZoom" },           // Cmd+0
        { role: "zoomIn" },              // Cmd+=
        { role: "zoomOut" },             // Cmd+-
        { type: "separator" },
        { role: "togglefullscreen" },    // Ctrl+Cmd+F
      ],
    },

    // ── Window ────────────────────────────────────────────
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
