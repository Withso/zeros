// ──────────────────────────────────────────────────────────
// IPC commands: sidecar + project folder switching
// ──────────────────────────────────────────────────────────
//
// Native handlers for:
//   get_engine_port, get_engine_root,
//   open_project_folder, open_project_folder_path
//
// Each of these is the frontend's contact point with the engine's
// lifecycle. `open_project_folder*` kills the running child and
// respawns rooted at the new folder, then emits `project-changed`
// so the webview reconnects the WebSocket bridge at the new port.
// ──────────────────────────────────────────────────────────

import { BrowserWindow, dialog } from "electron";
import {
  assertIsDirectory,
  currentLocalToken,
  currentPort,
  currentRoot,
  defaultProjectRoot,
  ensureEngineRunning,
  isPlausibleProject,
  isSystemDir,
  spawnEngine,
} from "../../sidecar";
import { emitEvent } from "../events";
import type { CommandHandler } from "../router";

interface ProjectChangedPayload {
  root: string;
  port: number;
}

export const getEnginePort: CommandHandler = async () => {
  // The window now opens in parallel with engine startup. Await the shared
  // single-flight spawn so the renderer never caches/guesses the base port.
  return currentPort() ?? (await ensureEngineRunning());
};

export const getEngineToken: CommandHandler = () => {
  // The per-launch secret the renderer presents on its loopback /ws
  // connection. Reachable only over this IPC bridge (not from a web page).
  return currentLocalToken();
};

export const getEngineRoot: CommandHandler = async () => {
  if (currentRoot()) return currentRoot();
  await ensureEngineRunning();
  return currentRoot();
};

/** Show the native folder picker for "Open project" WITHOUT respawning the
 *  engine. The renderer registers the chosen folder as a project over the
 *  bridge (`project.upsert`); the already-running engine then serves it without
 *  re-rooting (git/workspaces/agents resolve per-repo, not from the engine
 *  root). This is the snappy add-a-repo path — no kill, no boot, no reconnect.
 *  Returns the absolute path on pick, or `null` on cancel. */
export const pickProjectFolder: CommandHandler = async () => {
  const parent =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = await dialog.showOpenDialog(parent ?? undefined!, {
    properties: ["openDirectory"],
    title: "Open Folder",
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
};

/** Show the native folder picker. On pick, respawn the engine rooted
 *  at the selected folder and emit `project-changed`. Cancellation
 *  returns `null` (not an error) so the UI can treat it as a no-op.
 *
 *  Legacy re-root path — the add-a-repo flow now uses `pickProjectFolder`
 *  (no respawn). Kept for any caller that still needs to re-root the engine. */
export const openProjectFolder: CommandHandler = async () => {
  const parent =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

  const result = await dialog.showOpenDialog(parent ?? undefined!, {
    properties: ["openDirectory"],
    title: "Open Folder",
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const root = result.filePaths[0];
  // Early "opening" signal — fired the INSTANT the user picks a folder, before
  // the (multi-second) engine respawn below. The renderer paints a minimal
  // shimmer project row in the sidebar immediately so the open never feels
  // stuck while spawnEngine kills + respawns the child. `project-changed` still
  // fires below once the new engine is actually up and the bridge reconnects.
  emitEvent("project-opening", { root });
  const port = await spawnEngine(root);
  const payload: ProjectChangedPayload = { root, port };
  emitEvent("project-changed", payload);
  return payload;
};

async function respawnAtPath(root: string): Promise<ProjectChangedPayload> {
  assertIsDirectory(root);
  // Re-rooting the engine is a privileged action. Apply the same guards the
  // cold-start path uses (apps/desktop/electron/sidecar.ts defaultProjectRoot) so an attacker
  // who reaches this IPC (renderer XSS) — or the zeros:// deep-link — can't point
  // the engine at `/`, $HOME, or a system dir (EMFILE watch crash + widening the
  // file/PTY surface any paired remote peer can reach).
  if (isSystemDir(root)) {
    throw new Error(`refusing to open a system directory: ${root}`);
  }
  if (!isPlausibleProject(root)) {
    throw new Error(
      `not a project folder (no .git/package.json/.zeros/…): ${root}`,
    );
  }
  // Early "opening" signal — parity with the dialog path (openProjectFolder).
  // Fired after the guards pass but before the multi-second respawn so the
  // sidebar paints its loading shimmer immediately. For an already-registered
  // project (the recent-projects re-open case) the renderer dedupes this against
  // the existing row, so no duplicate shimmer appears.
  emitEvent("project-opening", { root });
  const port = await spawnEngine(root);
  const payload: ProjectChangedPayload = { root, port };
  emitEvent("project-changed", payload);
  return payload;
}

/** Open a known folder by absolute path (no dialog). Used by the
 *  recent-projects list. Throws if the path no longer exists so the
 *  UI can prune stale entries. */
export const openProjectFolderPath: CommandHandler = (args) => {
  const root = typeof args.path === "string" ? args.path : "";
  if (!root) throw new Error("open_project_folder_path: missing path");
  return respawnAtPath(root);
};

/** Re-root the engine at the default sentinel (~/.zeros/default-project) and
 *  reconnect the renderer's bridge. Used when the user removes their LAST
 *  project: the engine should stop serving the now-unregistered repo root — so
 *  a paired web/remote peer doesn't keep seeing it — and fall back to the empty
 *  sentinel until the user opens another folder. Emits `engine-restarted` (not
 *  `project-changed`) so the bridge re-resolves the new port WITHOUT recording
 *  the sentinel as a recent project or churning project-generation state.
 *  Returns the new port. */
export const engineResetToDefault: CommandHandler = async () => {
  const root = defaultProjectRoot();
  const port = await spawnEngine(root);
  emitEvent("engine-restarted", port);
  return port;
};

/** Show the native folder picker WITHOUT respawning the engine. Used
 *  by Quick Start and Open GitHub project dialogs where the
 *  picked folder is just a parent directory for a future repo — the
 *  engine root doesn't change. Returns the absolute path on pick, or
 *  null on cancel. */
export const dialogPickFolder: CommandHandler = async (args) => {
  const parent =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const title =
    typeof args.title === "string" && args.title.length > 0
      ? args.title
      : "Pick a folder";
  const defaultPath =
    typeof args.defaultPath === "string" && args.defaultPath.length > 0
      ? args.defaultPath
      : undefined;
  const result = await dialog.showOpenDialog(parent ?? undefined!, {
    properties: ["openDirectory", "createDirectory"],
    title,
    defaultPath,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
};
