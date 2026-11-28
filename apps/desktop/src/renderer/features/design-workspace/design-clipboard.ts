/** Where a copied layer came from, as the canvas clipboard keeps it. */
export interface DesignClipboardOrigin {
  workspaceId: string;
  directoryId: string | undefined;
  directoryRevision: number | undefined;
}

/** Any page of the Design directory a layer was copied in takes its paste;
 * another workspace or directory, or the same one bound again, never sees it. */
export function designClipboardPasteAllowed(
  copied: DesignClipboardOrigin,
  current: DesignClipboardOrigin,
): boolean {
  return copied.workspaceId === current.workspaceId && copied.directoryId === current.directoryId &&
    copied.directoryRevision === current.directoryRevision;
}

/** A paste into the copied layer's own frame changes that frame's version,
 * not the layer: the clipboard follows the frame so the next paste still
 * works. Any other paste, or a copied frame, leaves the clipboard as it was. */
export function designClipboardFollowedFrame<T extends { file: string }>(
  copied: { frame: string; nodeId: string | null },
  destination: string,
  pasted: boolean,
  frames: readonly T[],
): T | null {
  if (!pasted || !copied.nodeId || destination !== copied.frame) return null;
  return frames.find((frame) => frame.file === copied.frame) ?? null;
}
