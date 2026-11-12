import { normalizeDesignPagesSnapshot, type DesignPageSummary } from "@zeros/protocol/design-pages";
import type { DesignApiMutationReplyWire } from "../../../platform/git";
import { designFrameViews } from "./design-frame-view";
import { selectDesignFrame } from "./design-selection";
import {
  captureDesignPageOwner,
  designWorkspaceView,
  isCurrentDesignPageOwner,
  useDesignWorkspaceUiStore,
  type DesignPageOwner,
} from "./design-workspace-ui";

/** History is directory-wide; presentation follows its frame only while the
 * submitting page still owns the interaction. No additional read is needed. */
export async function restoreDesignPageHistorySelection(
  workspaceId: string,
  owner: DesignPageOwner,
  result: DesignApiMutationReplyWire,
  direction: "undo" | "redo",
  onItem?: (itemId: string | null, page: DesignPageSummary) => void,
) {
  if (owner.workspaceId !== workspaceId || !isCurrentDesignPageOwner(owner))
    return;
  const snapshot = result.snapshot
    ? normalizeDesignPagesSnapshot(result.snapshot)
    : undefined;
  if (
    snapshot?.directoryId !== undefined &&
    snapshot.directoryId !== owner.directoryId
  )
    return;
  // A scoped reply prepares only the restored frames; the page's other
  // frames are still described, and selection accepts either.
  const frames = designFrameViews(snapshot);
  const affected = result.historyFrame ?? result.historySelection;
  const page = snapshot?.pages.find((page) => page.id === result.historyPageId) ?? (affected
    ? snapshot?.pages.find(
        (page) =>
          page.frameFiles.includes(affected) ||
          (page.folder
            ? affected.startsWith(page.folder + "/")
            : !affected.includes("/")),
      )
    : undefined);
  if (page)
    useDesignWorkspaceUiStore
      .getState()
      .setActivePage(workspaceId, page.id, owner.directoryId);
  if (result.historySelection === undefined) {
    const frame = frames.find((frame) => frame.file === affected);
    if (
      page &&
      page.id !== owner.pageId &&
      frame &&
      designWorkspaceView(workspaceId).selectedFrame !== frame.file
    ) {
      await selectDesignFrame(workspaceId, frame, {
        selected: true,
        reveal: true,
        owner: captureDesignPageOwner(workspaceId),
      });
    }
    return;
  }
  const selected = result.historySelection
    ? (frames.find((frame) => frame.file === result.historySelection) ?? null)
    : null;
  const restoredFrame = direction === "undo" && selected !== null;
  const selectionOwner = captureDesignPageOwner(workspaceId);
  await selectDesignFrame(workspaceId, selected, {
    selected: restoredFrame,
    reveal: restoredFrame,
    owner: selectionOwner,
  });
  if (result.historyItemId !== undefined && page && isCurrentDesignPageOwner(selectionOwner))
    onItem?.(result.historyItemId !== null && page.items?.some(item => item.id === result.historyItemId)
      ? result.historyItemId : null, page);
}
