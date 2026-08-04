// ──────────────────────────────────────────────────────────
// composer-editor-context — bridge from the hook to NodeView pills
// ──────────────────────────────────────────────────────────
//
// TipTap React NodeViews render as portals inside <EditorContent>'s React
// tree, so they inherit context from EditorContent's ancestors. The editor
// hook wraps EditorContent in this provider so each attachment pill can
// resolve its bytes (kept out of the ProseMirror doc, in a side store keyed
// by attachmentId) and open the shared full-screen image preview.
// ──────────────────────────────────────────────────────────

import { createContext, useContext } from "react";
import type { ComposerAttachment } from "../composer-attachments";

export interface ComposerEditorContextValue {
  /** Resolve an inline attachment pill's bytes by its node id. */
  getAttachment: (id: string) => ComposerAttachment | undefined;
  /** Open the full-screen lightbox for an image pill (data: URL). */
  onPreviewImage?: (dataUri: string) => void;
  /** Workspace root for disk-backed images reconstructed from transcripts. */
  cwd?: string | null;
}

const ComposerEditorContext = createContext<ComposerEditorContextValue>({
  getAttachment: () => undefined,
});

export const ComposerEditorProvider = ComposerEditorContext.Provider;

export function useComposerEditorContext(): ComposerEditorContextValue {
  return useContext(ComposerEditorContext);
}
