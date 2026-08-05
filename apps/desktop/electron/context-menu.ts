// ──────────────────────────────────────────────────────────
// Right-click context menu — standard text edit only
// ──────────────────────────────────────────────────────────
//
// Default Electron BrowserWindows have NO context menu — right-click
// is silently ignored. We add a minimal one with:
//   - Cut / Copy / Paste / Select All (only over an editable area)
//   - Copy (when there's a non-editable text selection)
//
//   - Inspect Element, but ONLY while DevTools is already open
//
// Inspect Element is deliberately conditional rather than always-on. A shipped
// app that sprouts a developer menu on every right-click reads as unfinished,
// and right-clicking plain (non-editable, unselected) chrome should still show
// no menu at all. But once you have opened DevTools (⌥⌘I — see
// apps/desktop/electron/devtools.ts), you are inspecting, and having to hunt for a node in
// the Elements tree instead of right-clicking it is the single most annoying
// thing about a custom context menu. Gating on `isDevToolsOpened()` gives the
// browser behaviour exactly when it's wanted and keeps it invisible otherwise.
// ──────────────────────────────────────────────────────────

import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";

export function setupContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    const items: MenuItemConstructorOptions[] = [];

    if (params.isEditable) {
      items.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll", enabled: params.editFlags.canSelectAll },
      );
    } else if (params.selectionText && params.selectionText.length > 0) {
      items.push({ role: "copy" });
    }

    if (win.webContents.isDevToolsOpened()) {
      if (items.length > 0) items.push({ type: "separator" });
      items.push({
        label: "Inspect Element",
        // params.x/y are in CSS pixels relative to the webContents viewport,
        // which is exactly what inspectElement expects.
        click: () => {
          if (win.isDestroyed()) return;
          win.webContents.inspectElement(params.x, params.y);
        },
      });
    }

    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}
