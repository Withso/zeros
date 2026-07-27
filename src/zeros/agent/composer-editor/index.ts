// ──────────────────────────────────────────────────────────
// composer-editor — TipTap inline-pill composer (public surface)
// ──────────────────────────────────────────────────────────

export {
  useComposerEditor,
  type ComposerEditorApi,
  type UseComposerEditorOpts,
  type ComposerInitialContent,
} from "./use-composer-editor";
export {
  serializeComposer,
  toMessageSegments,
  textToDoc,
  type ComposerSerialized,
} from "./serialize";
export type { ComposerSegment } from "./segments";
export { messageToEditorContent } from "./reconstruct";
export { FileTypeIcon } from "./file-type-icon";
export { MentionPillView, AttachmentPillView } from "./pill-views";
export { filesToAttachments } from "./attachment-io";
