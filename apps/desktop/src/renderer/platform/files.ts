// ──────────────────────────────────────────────────────────
// Native binding — workspace file read (Files tab)
// ──────────────────────────────────────────────────────────
//
// Renderer-side façade over the `read_file` IPC command. Known repository roots
// use the engine bridge and never turn transport absence into a missing file;
// native worktree reads still return `null` for an unavailable host reader.
// ──────────────────────────────────────────────────────────

import { isNativeRuntime, nativeInvoke } from "./runtime";
import { getActiveBridge } from "./bridge/active-bridge";
import {
  bridgeFileRead,
  bridgeFileWrite,
} from "./bridge/workspace-bridge";
import { resolveBridgeWorkspaceIdForCwd } from "./bridge/workspace-id-resolver";
import { isKnownProjectRoot } from "../state/projects-store";

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
  /** Engine-tagged Design territory. Design files have exactly one write path
   *  (the design surface), so the viewer renders them read-only instead of
   *  offering an Edit action `file.write` would refuse. Absent on transports
   *  that don't tag it — the editor then behaves as before and the engine
   *  still refuses the save, so the failure direction stays safe. */
  designPath?: boolean;
}

export interface ReadImageThumbnailResult {
  kind: "image" | "too-large" | "error";
  /** Echo of the requested repo-relative path. */
  path: string;
  /** Source byte size; managed-worktree data URLs are bounded previews. */
  bytes: number;
  width?: number;
  height?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  orientation?: number;
  /** True when this is already the original bounded source, not a preview. */
  fullResolution?: boolean;
  dataUrl?: string;
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

function fileReadAsThumbnail(
  result: ReadFileResult | null,
): ReadImageThumbnailResult | null {
  if (!result) return null;
  if (result.kind === "image") {
    return {
      kind: "image",
      path: result.path,
      bytes: result.bytes,
      dataUrl: result.dataUrl,
      fullResolution: true,
    };
  }
  if (result.kind === "too-large") {
    return {
      kind: "too-large",
      path: result.path,
      bytes: result.bytes,
      error: result.error ?? "image is too large to preview",
    };
  }
  return {
    kind: "error",
    path: result.path,
    bytes: result.bytes,
    error: result.error ?? "file could not be rendered as an image",
  };
}

/** Read a bounded native thumbnail for a managed worktree image. The synthetic
 *  Local main checkout has no workspace row and is intentionally outside the
 *  Electron allowlist, so it preserves readWorkspaceFile's trusted engine
 *  route (and that route's existing full-file byte cap). */
export async function readWorkspaceImageThumbnail(
  cwd: string,
  relPath: string,
  maxDimension: 64 | 128 | 256 | 512 | 1024 | 1536 = 256,
): Promise<ReadImageThumbnailResult | null> {
  if (!cwd || !relPath || !isNativeRuntime()) return null;
  if (isKnownProjectRoot(cwd)) {
    return fileReadAsThumbnail(await readWorkspaceFile(cwd, relPath));
  }
  let nativeResult: ReadImageThumbnailResult | null = null;
  let nativeError: unknown;
  try {
    nativeResult = await nativeInvoke<ReadImageThumbnailResult>(
      "read_image_thumbnail",
      {
        cwd,
        path: relPath,
        maxDimension,
      },
    );
    // A deterministic safety refusal must not be bypassed by asking the engine
    // for the complete source image. Successful native previews are already
    // resolution-matched and remain the common local-worktree fast path.
    if (nativeResult.kind === "image" || nativeResult.kind === "too-large") {
      return nativeResult;
    }
  } catch (error) {
    nativeError = error;
  }

  // Bridge-owned and rowless paths can be perfectly valid even when the local
  // Electron process cannot resolve them. The graph list/write path already
  // uses this workspace identity; use the same authority as a compatibility
  // fallback for an unavailable/stale native command or a structured native
  // decode/path error. Attachment images are capped by file.read's 5 MiB
  // boundary, and the canvas decodes them through its bounded global queue.
  try {
    const { bridge, workspaceId } = await resolveBridgeFileTarget(
      cwd,
      "read the context image",
    );
    const bridged = fileReadAsThumbnail(
      await bridgeFileRead(bridge, workspaceId, relPath),
    );
    return bridged?.kind === "image" || bridged?.kind === "too-large"
      ? bridged
      : (nativeResult ?? bridged);
  } catch {
    if (nativeError) throw nativeError;
    return nativeResult;
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
