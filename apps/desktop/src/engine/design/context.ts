import type {
  DesignContextReference,
  DesignContextInspection,
} from "@zeros/protocol/design-context";
import { designDirectoryEntry } from "./metadata";
import { designDirectoryNameFor } from "./directory-registry";
import {
  listDesignFrames,
  readDesignFrame,
  readDesignFrameSelectionIdentity,
} from "./document";
import { GitError } from "../git/errors";
import { readCanvas } from "./document-storage";
import { legacyFrameId } from "./canvas-file";

/** Called under a pinned directory lease; all document reads are observational. */
export async function createDesignContextReference(
  root: string,
  workspaceId: string,
  frame: string,
  nodeId?: string,
  expectedDirectoryId?: string,
): Promise<DesignContextReference> {
  const entry = designDirectoryEntry(root, designDirectoryNameFor(root));
  if (!entry)
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "Initialize this Design directory before referencing it.",
    });
  if (expectedDirectoryId && entry.id !== expectedDirectoryId)
    throw new GitError({ code: "VALIDATION_FAILED", message: "The selected Design directory changed. Select the frame again." });
  const canvas = await readCanvas(root);
  if (!(await listDesignFrames(root, { writeBack: false })).some((item) => item.file === frame))
    throw new GitError({ code: "VALIDATION_FAILED", message: "The selected Design frame no longer exists." });
  const identity = await readDesignFrameSelectionIdentity(root, frame);
  if (nodeId && !identity.nodeIds.includes(nodeId))
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "That Design node no longer exists. Select it again.",
    });
  const frameId = canvas.frame_info[frame]?.id ?? legacyFrameId(frame);
  const latestCanvas = await readCanvas(root);
  if (designDirectoryEntry(root, designDirectoryNameFor(root))?.id !== entry.id ||
      frameId !== (latestCanvas.frame_info[frame]?.id ?? legacyFrameId(frame)))
    throw new GitError({ code: "VALIDATION_FAILED", message: "The selected frame changed while reading its context. Select it again." });
  return {
    version: 1,
    workspaceId,
    directoryId: entry.id,
    frame: identity.file,
    frameId,
    ...(nodeId ? { nodeId } : {}),
    revision: identity.sourceVersion,
  };
}

export async function inspectDesignContext(
  root: string,
  reference: DesignContextReference,
): Promise<DesignContextInspection> {
  const entry = designDirectoryEntry(root, designDirectoryNameFor(root));
  if (entry?.id !== reference.directoryId)
    return { status: "wrong-directory", reference };
  const canvas = await readCanvas(root);
  if (reference.frameId && reference.frameId !== (canvas.frame_info[reference.frame]?.id ?? legacyFrameId(reference.frame)))
    return { status: "missing", reference };
  if (
    !(await listDesignFrames(root, { writeBack: false })).some(
      (frame) => frame.file === reference.frame,
    )
  )
    return { status: "missing", reference };
  const identity = await readDesignFrameSelectionIdentity(
    root,
    reference.frame,
  );
  if (reference.nodeId && !identity.nodeIds.includes(reference.nodeId))
    return { status: "missing", reference };
  if (identity.sourceVersion !== reference.revision)
    return {
      status: "stale",
      reference,
      currentRevision: identity.sourceVersion,
    };
  const frame = await readDesignFrame(root, reference.frame, 0, {
    writeBack: false,
  });
  // An external writer may race the two reads. Never label those bytes current.
  if (frame.sourceVersion !== reference.revision)
    return { status: "stale", reference, currentRevision: frame.sourceVersion };
  if (designDirectoryEntry(root, designDirectoryNameFor(root))?.id !== reference.directoryId)
    return { status: "wrong-directory", reference };
  const latestCanvas = await readCanvas(root);
  if (reference.frameId && reference.frameId !== (latestCanvas.frame_info[reference.frame]?.id ?? legacyFrameId(reference.frame)))
    return { status: "missing", reference };
  return {
    status: "ready",
    reference,
    title: frame.title,
    directory: entry.path,
    source: frame.source,
    width: frame.width,
    height: frame.height,
  };
}
