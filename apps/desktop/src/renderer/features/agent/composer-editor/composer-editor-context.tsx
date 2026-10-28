// ──────────────────────────────────────────────────────────
// composer-editor-context — bridge from the hook to NodeView pills
// ──────────────────────────────────────────────────────────
//
// TipTap React NodeViews render as portals inside <EditorContent>'s React
// tree, so they inherit context from EditorContent's ancestors. The editor
// hook wraps EditorContent in this provider so each attachment pill can
// resolve its bytes (kept out of the ProseMirror doc, in a side store keyed
// by attachmentId) and open its saved workspace file.
// ──────────────────────────────────────────────────────────

import { createContext, useContext } from "react";
import type { ComposerAttachment } from "../composer-attachments";
import type { Skill } from "../../../platform/app";

export interface ComposerEditorContextValue {
  /** Resolve an inline attachment pill's bytes by its node id. */
  getAttachment: (id: string) => ComposerAttachment | undefined;
  /** Workspace root for disk-backed images reconstructed from transcripts. */
  cwd?: string | null;
  /** False while a retained composer is hidden; disk image leases stay cold. */
  attachmentImagesActive: boolean;
  /** Mirrors TipTap's editable state for pill actions outside contenteditable. */
  editable: boolean;
  /** Create has no workspace in which to open repository or skill sources. */
  sourceFilesOpen?: boolean;
  onOpenAttachment?: (attachment: ComposerAttachment) => void;
  attachVideoFrames?: (id: string) => Promise<void> | undefined;
  agentId?: string | null;
  skills?: readonly Skill[];
}

const ComposerEditorContext = createContext<ComposerEditorContextValue>({
  getAttachment: () => undefined,
  attachmentImagesActive: true,
  editable: true,
});

export const ComposerEditorProvider = ComposerEditorContext.Provider;

export function useComposerEditorContext(): ComposerEditorContextValue {
  return useContext(ComposerEditorContext);
}
