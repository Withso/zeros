import { hasDesignFrameAttachmentSelection } from "../features/agent/design-frame-selection";
import type { ComposerDraft } from "./store";

export function composerDraftHasPayload(draft: ComposerDraft | null | undefined): boolean {
  return Boolean(draft && (draft.text.trim().length > 0 || draft.attachments.length > 0 || hasDesignFrameAttachmentSelection(draft.designFrame)));
}
