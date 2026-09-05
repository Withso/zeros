// ──────────────────────────────────────────────────────────
// IPC commands: CSS file I/O
// ──────────────────────────────────────────────────────────
//
// Three helpers the Themes page uses:
//   pick_css_file  — native file picker (.css filter)
//   read_css_file  — read a .css file on demand
//   write_css_file — atomic write when user saves tokens
//
// Path safety: read/write are refused for anything outside the
// currently-open project root. The picker itself respects macOS
// sandbox / user-grant semantics so it's not path-gated.
// ──────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, dialog } from "electron";
import { currentRoot } from "../../sidecar";
import type { CommandHandler } from "../router";
import { electronAtomicTemporaryPath } from "./atomic-file-write";

interface CssFilePayload {
  path: string;
  name: string;
  content: string;
}

function pathInsideRoot(target: string, root: string): boolean {
  try {
    const t = fs.realpathSync.native(path.resolve(target));
    const r = fs.realpathSync.native(path.resolve(root));
    // Require an exact match or a path-separator boundary — a bare prefix match
    // admitted `/Users/dev/example-secrets/x.css` for root `/Users/dev/example`.
    return t === r || t.startsWith(r + path.sep);
  } catch {
    return false;
  }
}

export const pickCssFile: CommandHandler = async () => {
  const parent =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

  const result = await dialog.showOpenDialog(parent ?? undefined!, {
    properties: ["openFile"],
    filters: [{ name: "CSS files", extensions: ["css"] }],
    title: "Pick CSS file",
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const p = result.filePaths[0];
  let content: string;
  try {
    content = fs.readFileSync(p, "utf-8");
  } catch (err) {
    throw new Error(
      `read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const payload: CssFilePayload = {
    path: p,
    name: path.basename(p) || "theme.css",
    content,
  };
  return payload;
};

export const readCssFile: CommandHandler = (args) => {
  const target = String(args.path ?? "");
  if (!target) throw new Error("read_css_file: missing path");
  const root = currentRoot();
  if (!root) throw new Error("no project root");
  if (!pathInsideRoot(target, root)) {
    throw new Error(`refusing to read outside project root: ${target}`);
  }
  try {
    return fs.readFileSync(target, "utf-8");
  } catch (err) {
    throw new Error(
      `read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

export const writeCssFile: CommandHandler = (args) => {
  const target = String(args.path ?? "");
  const content = String(args.content ?? "");
  if (!target) throw new Error("write_css_file: missing path");
  const root = currentRoot();
  if (!root) throw new Error("no project root");
  if (!pathInsideRoot(target, root)) {
    throw new Error(`refusing to write outside project root: ${target}`);
  }

  // Design recovery owns the `.zeros-tmp` suffix. This command runs in the
  // Electron process, outside the engine's mutation lane, so use a distinct
  // unique namespace that recovery can never mistake for an orphaned Design
  // transaction while preserving same-directory atomic rename semantics.
  const tmp = electronAtomicTemporaryPath(target);
  try {
    fs.writeFileSync(tmp, content);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Preserve the original write failure.
    }
    throw new Error(
      `write tmp: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Preserve the original rename failure.
    }
    throw new Error(
      `rename: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};
