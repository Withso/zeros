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

/** Called under a pinned directory lease; all document reads are observational. */
export async function createDesignContextReference(
  root: string,
  workspaceId: string,
  frame: string,
  nodeId?: string,
): Promise<DesignContextReference> {
  const entry = designDirectoryEntry(root, designDirectoryNameFor(root));
  if (!entry)
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "Initialize this Design directory before referencing it.",
    });
  const identity = await readDesignFrameSelectionIdentity(root, frame);
  if (nodeId && !identity.nodeIds.includes(nodeId))
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "That Design node no longer exists. Select it again.",
    });
  return {
    version: 1,
    workspaceId,
    directoryId: entry.id,
    frame: identity.file,
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
  return {
    status: "ready",
    reference,
    title: frame.title,
    source: frame.source,
    width: frame.width,
    height: frame.height,
  };
}
