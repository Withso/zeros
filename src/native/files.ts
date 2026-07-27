// ──────────────────────────────────────────────────────────
// Native binding — workspace file read (Files tab)
// ──────────────────────────────────────────────────────────
//
// Renderer-side façade over the `read_file` IPC command. Known repository roots
// use the engine bridge and never turn transport absence into a missing file;
// native worktree reads still return `null` for an unavailable host reader.
// ──────────────────────────────────────────────────────────

import { isNativeRuntime, nativeInvoke } from "./runtime";
import { getActiveBridge } from "../zeros/bridge/active-bridge";
import {
  bridgeFileRead,
  bridgeFileWrite,
} from "../zeros/bridge/workspace-bridge";
import { resolveBridgeWorkspaceIdForCwd } from "../zeros/bridge/workspace-id-resolver";
import { isKnownProjectRoot } from "../zeros/store/projects-store";

export type ReadFileKind = "text" | "image" | "binary" | "too-large" | "error";

export interface ReadFileResult {
  kind: ReadFileKind;
  /** Echo of the requested repo-relative path. */
  path: string;
  bytes: number;
  /** Present when kind === "text". */
  content?: string;
  /** Present when kind === "image" (base64 data URL). */
  dataUrl?: string;
  /** Present when kind === "error" — a human-readable reason. */
  error?: string;
}

export type WriteFileKind = "success" | "too-large" | "error";

export interface WriteFileResult {
  kind: WriteFileKind;
  /** Echo of the requested repo-relative path. */
  path: string;
  /** Bytes written (0 on error). */
  bytes: number;
  /** Present when kind === "error" — a human-readable reason. */
  error?: string;
}

function requireBridge(action: string) {
  const bridge = getActiveBridge();
  if (!bridge) {
    throw new Error(
      `Can't ${action}: not connected to the Zeros engine yet — try again in a moment.`,
    );
  }
  return bridge;
}

async function resolveBridgeFileTarget(
  cwd: string,
  action: string,
): Promise<{ bridge: ReturnType<typeof requireBridge>; workspaceId: string }> {
  const bridge = requireBridge(action);
  let workspaceId = cwd;
  try {
    workspaceId = (await resolveBridgeWorkspaceIdForCwd(bridge, cwd)) ?? cwd;
  } catch {
    // A registered primary checkout has no workspace row. The engine accepts
    // its trusted raw root; a managed worktree normally resolves above.
  }
  return { bridge, workspaceId };
}

/** Read one file under `cwd`. Native IPC is the desktop-worktree fast path;
 * the engine is the web, primary-checkout, late-preload, and IPC-failure path.
 * Transport absence rejects so callers retain their exact confirmed snapshot. */
export async function readWorkspaceFile(
  cwd: string,
  relPath: string,
): Promise<ReadFileResult | null> {
  if (!cwd || !relPath) return null;
  // Desktop: Local main (a registered project root) has no
  // workspace row and isn't under electron-main's trusted IPC roots, so the
  // electron read_file would refuse it. Read it over the engine bridge instead —
  // the engine resolves the repo root via isKnownRepoRoot. Worktrees stay on the
  // faster electron IPC path below.
  if (isKnownProjectRoot(cwd)) {
    const { bridge, workspaceId } = await resolveBridgeFileTarget(
      cwd,
      "read the repository file",
    );
    return bridgeFileRead(bridge, workspaceId, relPath);
  }
  if (!isNativeRuntime()) {
    const { bridge, workspaceId } = await resolveBridgeFileTarget(
      cwd,
      "read the workspace file",
    );
    return bridgeFileRead(bridge, workspaceId, relPath);
  }
  try {
    return await nativeInvoke<ReadFileResult>("read_file", {
      cwd,
      path: relPath,
    });
  } catch {
    const { bridge, workspaceId } = await resolveBridgeFileTarget(
      cwd,
      "read the workspace file",
    );
    return bridgeFileRead(bridge, workspaceId, relPath);
  }
}

/** Write `content` to one file under `cwd`. `relPath` is the repo-relative POSIX
 *  path. Mirrors readWorkspaceFile's transport fan-out (web bridge / known-repo
 * bridge / electron IPC). Transport absence rejects rather than pretending a
 * save did nothing; a reached backend returns a result whose `.kind` carries
 * success/too-large/error. */
export async function writeWorkspaceFile(
  cwd: string,
  relPath: string,
  content: string,
): Promise<WriteFileResult | null> {
  if (!cwd || !relPath) return null;
  // Desktop: Local main (a registered project root) has no workspace row
  // and isn't under electron-main's trusted IPC roots, so write it over the
  // engine bridge. Worktrees stay on the faster electron IPC path below.
  if (isKnownProjectRoot(cwd)) {
    const { bridge, workspaceId } = await resolveBridgeFileTarget(
      cwd,
      "write the repository file",
    );
    return bridgeFileWrite(bridge, workspaceId, relPath, content);
  }
  if (!isNativeRuntime()) {
    const { bridge, workspaceId } = await resolveBridgeFileTarget(
      cwd,
      "write the workspace file",
    );
    return bridgeFileWrite(bridge, workspaceId, relPath, content);
  }
  try {
    return await nativeInvoke<WriteFileResult>("write_file", {
      cwd,
      path: relPath,
      content,
    });
  } catch {
    const { bridge, workspaceId } = await resolveBridgeFileTarget(
      cwd,
      "write the workspace file",
    );
    return bridgeFileWrite(bridge, workspaceId, relPath, content);
  }
}
