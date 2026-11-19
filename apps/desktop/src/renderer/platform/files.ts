import { isNativeRuntime, nativeInvoke } from "./runtime";
import { fileMediaRangeSchema, type FileMediaDescriptor, type FileMediaRange, type FileMediaRangeResult } from "@zeros/protocol/file-media";
import { WorkspaceRuntimeClient } from "./bridge/workspace-runtime-client";
import { runtimeExecutionKey } from "./bridge/ws-client";
import { getActiveBridge } from "./bridge/active-bridge";
import {
  bridgeFileRead,
  bridgeFileWrite,
  workspaceOp,
} from "./bridge/workspace-bridge";
import { resolveBridgeWorkspaceIdForCwd } from "./bridge/workspace-id-resolver";
import { isKnownProjectRoot } from "../state/projects-store";
import { isCloudWorkspace } from "./bridge/cloud-workspace-key";

export type ReadFileKind = "text" | "image" | "video" | "binary" | "too-large" | "error";

export interface ReadFileResult {
  kind: ReadFileKind;
  path: string;
  bytes: number;
  content?: string;
  /** Present for image/video previews (bounded base64 data URL). */
  dataUrl?: string;
  /** Pending selected file only; never transported or persisted. */
  blob?: Blob;
  /** Source metadata for native range playback; the cache holds no media bytes. */
  media?: FileMediaDescriptor;
  error?: string;
  /** Prefer a read-only view for tagged Design files; older transports may omit the tag, but the backend still refuses the save. */
  designPath?: boolean;
}

export interface ReadImageThumbnailResult {
  kind: "image" | "too-large" | "error";
  path: string;
  /** Source bytes, not the size of the bounded preview. */
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
  path: string;
  /** Bytes written (0 on error). */
  bytes: number;
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
    // The engine can validate a registered primary checkout without a workspace row.
  }
  return { bridge, workspaceId };
}

/** Reject missing transport so callers retain their exact confirmed snapshot. */
export async function readWorkspaceFile(
  cwd: string,
  relPath: string,
  options?: { includeVideo?: boolean; streamMedia?: boolean },
): Promise<ReadFileResult | null> {
  if (!cwd || !relPath) return null;
  const fromBridge = async (action: string) => {
    const { bridge, workspaceId } = await resolveBridgeFileTarget(cwd, action);
    return options?.streamMedia
      ? bridgeFileRead(bridge, workspaceId, relPath, options.includeVideo, true)
      : options?.includeVideo
      ? bridgeFileRead(bridge, workspaceId, relPath, true)
      : bridgeFileRead(bridge, workspaceId, relPath);
  };
  // Registered primary checkouts use the engine's trusted-root path, not Electron's worktree allowlist.
  if (isCloudWorkspace(cwd) || isKnownProjectRoot(cwd)) {
    return fromBridge("read the repository file");
  }
  if (!isNativeRuntime()) {
    return fromBridge("read the workspace file");
  }
  try {
    return await nativeInvoke<ReadFileResult>("read_file", {
      cwd,
      path: relPath,
      ...(options?.includeVideo ? { includeVideo: true } : {}),
      ...(options?.streamMedia ? { streamMedia: true } : {}),
    });
  } catch {
    return fromBridge("read the workspace file");
  }
}

/** Fence a media stream by its captured owner and runtime through every range read. */
export function createWorkspaceMediaReader(cwd: string): (input: FileMediaRange) => Promise<FileMediaRangeResult> {
  const bridge = getActiveBridge();
  const executionKey = () => bridge instanceof WorkspaceRuntimeClient
    ? bridge.workspaceExecutionKey(cwd) : bridge ? runtimeExecutionKey(bridge.executionIdentity) : "native";
  const captured = executionKey();
  const assertCurrent = () => {
    if (getActiveBridge() !== bridge || executionKey() !== captured) throw new Error("The preview workspace changed. Reopen this file.");
  };
  let workspace: Promise<string> | undefined;
  return async input => {
    const range = fileMediaRangeSchema.parse(input);
    assertCurrent();
    let result: FileMediaRangeResult;
    if (isNativeRuntime() && !isCloudWorkspace(cwd) && !isKnownProjectRoot(cwd)) {
      result = await nativeInvoke<FileMediaRangeResult>("read_file_range", { cwd, ...range });
    } else {
      if (!bridge) throw new Error("The workspace reader is unavailable");
      workspace ??= resolveBridgeWorkspaceIdForCwd(bridge, cwd).then(value => value ?? cwd);
      const workspaceId = await workspace;
      assertCurrent();
      result = await workspaceOp(bridge, "file.readRange", { workspaceId, ...range }, 25_000) as FileMediaRangeResult;
    }
    assertCurrent();
    return result;
  };
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

/** Cloud and the rowless Local project root use the engine read's full-file cap; neither is in the native thumbnail allowlist. */
export async function readWorkspaceImageThumbnail(
  cwd: string,
  relPath: string,
  maxDimension: 64 | 128 | 256 | 512 | 1024 | 1536 = 256,
): Promise<ReadImageThumbnailResult | null> {
  if (!cwd || !relPath) return null;
  if (isCloudWorkspace(cwd) || isKnownProjectRoot(cwd)) {
    return fileReadAsThumbnail(await readWorkspaceFile(cwd, relPath));
  }
  if (!isNativeRuntime()) return null;
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
    // Do not bypass a native size refusal by asking the engine for the whole image.
    if (nativeResult.kind === "image" || nativeResult.kind === "too-large") {
      return nativeResult;
    }
  } catch (error) {
    nativeError = error;
  }

  // If native cannot read a valid bridge-owned path, fall back to the graph's workspace authority and bounded file read.
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

/** Reject missing transport; a reached backend can return a structured refusal. */
export async function writeWorkspaceFile(
  cwd: string,
  relPath: string,
  content: string,
  options?: {
    /** The backend replaces the file only if it still holds this exact text; a changed file returns an error result. */
    expectedContent?: string;
  },
): Promise<WriteFileResult | null> {
  if (!cwd || !relPath) return null;
  const expectedContent = options?.expectedContent;
  if (isCloudWorkspace(cwd) || isKnownProjectRoot(cwd)) {
    const { bridge, workspaceId } = await resolveBridgeFileTarget(
      cwd,
      "write the repository file",
    );
    return bridgeFileWrite(bridge, workspaceId, relPath, content, expectedContent);
  }
  if (!isNativeRuntime()) {
    const { bridge, workspaceId } = await resolveBridgeFileTarget(
      cwd,
      "write the workspace file",
    );
    return bridgeFileWrite(bridge, workspaceId, relPath, content, expectedContent);
  }
  try {
    return await nativeInvoke<WriteFileResult>("write_file", {
      cwd,
      path: relPath,
      content,
      ...(expectedContent !== undefined ? { expectedContent } : {}),
    });
  } catch {
    const { bridge, workspaceId } = await resolveBridgeFileTarget(
      cwd,
      "write the workspace file",
    );
    return bridgeFileWrite(bridge, workspaceId, relPath, content, expectedContent);
  }
}
