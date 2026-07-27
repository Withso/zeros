// ──────────────────────────────────────────────────────────
// Right-click context menu — standard text edit only
// ──────────────────────────────────────────────────────────
//
// Default Electron BrowserWindows have NO context menu — right-click
// is silently ignored. We add a minimal one with:
//   - Cut / Copy / Paste / Select All (only over an editable area)
//   - Copy (when there's a non-editable text selection)
//
// There is deliberately NO "Inspect Element" entry — right-clicking a
// plain (non-editable, unselected) area shows no menu at all. DevTools is
// reachable only via the View-menu accelerator (Cmd+Opt+I / toggleDevTools),
// which is itself force-closed in packaged builds (see main.ts) so an open
// console can't leak the in-memory session token or decrypt stored
// secrets at the machine.
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

    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}
