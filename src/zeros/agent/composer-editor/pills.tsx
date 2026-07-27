// ──────────────────────────────────────────────────────────
// pills.tsx — inline atomic pill NodeViews (mention + attachment)
// ──────────────────────────────────────────────────────────
//
// Rendered by ReactNodeViewRenderer for the two custom inline atom nodes.
// Both wrap NodeViewWrapper as="span" with contentEditable={false} so the
// pill is one indivisible, Backspace-deletable unit inside the text flow.
//
// Chrome = the unified pill recipe (PILL_SHELL, 2026-07-05 per user): 20px
// tall, 4px radius, bg-bg1, border-border3 — identical to the tool-row
// FileTag and turn-footer file pills. Mentions use the Files-tab file-type
// glyph; attachments show an image thumbnail or a file glyph, with a × to
// remove (atoms also delete on Backspace).
// ──────────────────────────────────────────────────────────

import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { X } from "lucide-react";

import { cn } from "../../ui/cn";
import { FileTypeIcon } from "./file-type-icon";
import { useComposerEditorContext } from "./composer-editor-context";
// Shared pill chrome — identical to the static sent-bubble pills. `mention`
// uses symmetric padding (no ×); `attachment` reserves the right edge for ×.
import { PILL_SHELL } from "./pill-views";
import { Tooltip } from "@/zeros/ui/primitives";

// ── MentionPill — @-file / folder / selection ──────────────

export function MentionPill(props: NodeViewProps) {
  const attrs = props.node.attrs as {
    label: string;
    path: string;
    kind: "file" | "folder" | "selection";
  };
  return (
    <Tooltip label={attrs.path || attrs.label}>
      <NodeViewWrapper
        as="span"
        data-mention-pill=""
        className={cn(
          PILL_SHELL,
          "mx-[1.5px] pl-2 pr-1",
          props.selected && "ring-2 ring-highlighted-bright/40",
        )}
        contentEditable={false}
      >
        <FileTypeIcon
          name={attrs.path || attrs.label}
          kind={attrs.kind}
          size={13}
        />
        <span className="max-w-[18rem] truncate">{attrs.label}</span>
        <Tooltip label="Remove">
          <button
            type="button"
            // mousedown preventDefault so removing never blurs/moves the selection.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.deleteNode()}
            aria-label={`Remove ${attrs.label}`}
            className="ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0 text-fg2 hover:bg-bg1-hover hover:text-fg1"
          >
            <X size={11} />
          </button>
        </Tooltip>
      </NodeViewWrapper>
    </Tooltip>
  );
}

// ── AttachmentPill — inline image / text-file attachment ───

export function AttachmentPill(props: NodeViewProps) {
  const attrs = props.node.attrs as {
    attachmentId: string;
    name: string;
    mimeType: string;
    kind: "image" | "text";
  };
  const ctx = useComposerEditorContext();
  const att = ctx.getAttachment(attrs.attachmentId);
  const isImage = attrs.kind === "image";
  const dataUri =
    att && isImage ? `data:${att.mimeType};base64,${att.data}` : null;
  const invalid = att ? !att.validation.ok : false;
  const tooltip = att && !att.validation.ok ? `${attrs.name} — ${att.validation.reason}` : attrs.name;

  return (
    <Tooltip label={tooltip}>
      <NodeViewWrapper
        as="span"
        data-attachment-pill=""
        className={cn(
          PILL_SHELL,
          "mx-[1.5px] pl-1.5 pr-1",
          props.selected && "ring-2 ring-highlighted-bright/40",
          invalid &&
            "border-yellow-primary/40 text-fg2 opacity-85 [&_img]:grayscale",
        )}
        contentEditable={false}
      >
        <button
          type="button"
          // mousedown preventDefault so clicking a pill doesn't blur/move the
          // ProseMirror selection; images open the lightbox.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (isImage && dataUri) ctx.onPreviewImage?.(dataUri);
          }}
          disabled={!isImage}
          aria-label={isImage ? "Preview image" : attrs.name}
          className="m-0 inline-flex min-w-0 items-center gap-1 border-0 bg-transparent p-0 font-[inherit] text-inherit disabled:cursor-default"
        >
          {isImage && dataUri ? (
            <img
              src={dataUri}
              alt=""
              className="h-[16px] w-[16px] shrink-0 rounded-sm object-cover"
            />
          ) : (
            <FileTypeIcon name={attrs.name} kind="file" size={13} />
          )}
          <span className="max-w-[16rem] truncate">{attrs.name}</span>
        </button>
        <Tooltip label="Remove">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.deleteNode()}
            aria-label={`Remove ${attrs.name}`}
            className="ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0 text-fg2 hover:bg-bg1-hover hover:text-fg1"
          >
            <X size={11} />
          </button>
        </Tooltip>
      </NodeViewWrapper>
    </Tooltip>
  );
}
