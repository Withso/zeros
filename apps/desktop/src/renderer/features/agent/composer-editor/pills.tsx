// ──────────────────────────────────────────────────────────
// pills.tsx — inline atomic pill NodeViews (mention + attachment)
// ──────────────────────────────────────────────────────────
//
// Rendered by ReactNodeViewRenderer for the two custom inline atom nodes.
// Both wrap NodeViewWrapper as="span" with contentEditable={false} so the
// pill is one indivisible, Backspace-deletable unit inside the text flow.
//
// Chrome = the unified pill recipe (PILL_SHELL): 20px
// tall, 4px radius, bg-bg1, border-border3 — identical to the tool-row
// FileTag and turn-footer file pills. Mentions use the Files-tab file-type
// glyph; attachments use the same file/image glyphs. Hover replaces the glyph
// with × in its existing slot (atoms also delete on Backspace).
// ──────────────────────────────────────────────────────────

import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import {
  useCallback,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { X } from "lucide-react";

import { cn } from "../../../shared/ui/cn";
import { FileTypeIcon } from "./file-type-icon";
import { useComposerEditorContext } from "./composer-editor-context";
// Shared pill chrome; editable pills use their leading icon slot for removal.
import { PILL_SHELL } from "./pill-views";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Tooltip,
} from "@/renderer/shared/ui/primitives";
import {
  AttachmentTextPreview,
  attachmentTextPreviewKey,
  warmAttachmentTextPreview,
} from "./attachment-text-preview";
import { useAttachmentImageSource } from "../attachment-image-source";
import {
  getFileAttachmentProgress,
  subscribeFileAttachmentProgress,
} from "../file-attachment-transfer";

function PillRemoveButton({
  label,
  disabled,
  onRemove,
  children,
}: {
  label: string;
  disabled: boolean;
  onRemove: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip label="Remove">
      <button
        type="button"
        // Removing a pill must preserve the editor's current selection.
        onMouseDown={(event) => event.preventDefault()}
        disabled={disabled}
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="composer-pill-remove text-fg2 hover:bg-bg1-hover hover:text-fg1 focus-visible:ring-highlighted-bright grid size-4 shrink-0 place-items-center rounded-sm border-0 bg-transparent p-0 focus-visible:ring-1 focus-visible:outline-none"
      >
        <span
          data-composer-pill-icon=""
          className="col-start-1 row-start-1 inline-flex"
        >
          {children}
        </span>
        <X size={11} className="col-start-1 row-start-1" />
      </button>
    </Tooltip>
  );
}

// ── MentionPill — @-file / folder / selection ──────────────

export function MentionPill(props: NodeViewProps) {
  const ctx = useComposerEditorContext();
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
          "composer-pill mx-[1.5px] gap-2 px-1.5",
          props.selected && "ring-highlighted-bright/40 ring-2",
        )}
        contentEditable={false}
      >
        <PillRemoveButton
          label={attrs.label}
          disabled={!ctx.editable}
          onRemove={() => {
            if (props.editor.isEditable) props.deleteNode();
          }}
        >
          <FileTypeIcon
            name={attrs.path || attrs.label}
            kind={attrs.kind}
            size={13}
          />
        </PillRemoveButton>
        <span className="max-w-[18rem] truncate">{attrs.label}</span>
      </NodeViewWrapper>
    </Tooltip>
  );
}

// ── AttachmentPill — inline image / text-file attachment ───

export function AttachmentPill(props: NodeViewProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const attrs = props.node.attrs as {
    attachmentId: string;
    name: string;
    mimeType: string;
    kind: "image" | "text" | "file";
  };
  const ctx = useComposerEditorContext();
  const att = ctx.getAttachment(attrs.attachmentId);
  const isImage = attrs.kind === "image";
  const progressId = att?.contextAttachmentId ?? attrs.attachmentId;
  const progress = useSyncExternalStore(
    useCallback(
      (listener) =>
        ctx.cwd && ctx.attachmentImagesActive
          ? subscribeFileAttachmentProgress(ctx.cwd, progressId, listener)
          : () => {},
      [ctx.cwd, ctx.attachmentImagesActive, progressId],
    ),
    useCallback(
      () =>
        ctx.cwd ? getFileAttachmentProgress(ctx.cwd, progressId) : undefined,
      [ctx.cwd, progressId],
    ),
    () => undefined,
  );
  const diskImageSource = useAttachmentImageSource({
    cwd: ctx.cwd,
    diskPath: att?.diskPath ?? progress?.diskPath,
    attachmentId: att?.contextAttachmentId,
    enabled: ctx.attachmentImagesActive && isImage,
  });
  const dataUri =
    att && isImage && att.data
      ? `data:${att.mimeType};base64,${att.data}`
      : diskImageSource;
  const invalid =
    (att ? !att.validation.ok : false) || progress?.phase === "error";
  const tooltip =
    progress?.phase === "error"
      ? `${attrs.name} — ${progress.error}`
      : att && !att.validation.ok
        ? `${attrs.name} — ${att.validation.reason}`
        : attrs.name;
  // A synthesized attachment (a chat transcript) carries enough metadata to
  // show the selected file on hover instead of its own filename. Read the
  // staged Blob or its saved record, never the source chat's newer transcript.
  //
  // An INVALID attachment keeps its tooltip regardless of the preview.
  // `tooltip` is the only live surface in the app for validation.reason, and
  // an invalid attachment is excluded at send — so swapping it for a panel
  // would make the largest attachment the app can stage the one case that is
  // dropped with no explanation anywhere.
  const preview =
    att?.preview && att.kind === "text" && !invalid ? att.preview : null;
  const warmPreview = () => {
    if (preview && att && ctx.attachmentImagesActive) {
      void warmAttachmentTextPreview(ctx.cwd, att).catch(() => {});
    }
  };

  const shell = (
    <NodeViewWrapper
      as="span"
      data-attachment-pill=""
      aria-busy={progress?.phase === "saving" || undefined}
      onPointerEnter={warmPreview}
      onFocus={warmPreview}
      className={cn(
        PILL_SHELL,
        "composer-pill mx-[1.5px] gap-2 px-1.5",
        props.selected && "ring-highlighted-bright/40 ring-2",
        invalid &&
          "border-yellow-primary/40 text-fg2 opacity-85 [&_[data-composer-pill-icon]]:grayscale",
      )}
      contentEditable={false}
    >
      <PillRemoveButton
        label={attrs.name}
        disabled={!ctx.editable}
        onRemove={() => {
          if (props.editor.isEditable) props.deleteNode();
        }}
      >
        <FileTypeIcon
          name={attrs.name}
          kind={isImage ? "image" : "file"}
          size={13}
        />
      </PillRemoveButton>
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
        <span className="max-w-[16rem] truncate">{attrs.name}</span>
        {progress?.phase === "saving" && (
          <span className="text-fg2">Saving {progress.percent}%</span>
        )}
      </button>
    </NodeViewWrapper>
  );

  // A transcript chip earns the panel; everything else keeps the plain
  // filename tooltip. This is the one case where hover has something strictly
  // better to say than the name already on screen.
  if (preview && att) {
    return (
      <HoverCard
        open={ctx.attachmentImagesActive && previewOpen}
        onOpenChange={setPreviewOpen}
        openDelay={400}
        closeDelay={120}
      >
        <HoverCardTrigger asChild>{shell}</HoverCardTrigger>
        <HoverCardContent
          side="top"
          align="start"
          collisionPadding={12}
          className="w-[24rem] overflow-hidden p-0"
        >
          <AttachmentTextPreview
            key={attachmentTextPreviewKey(ctx.cwd, att)}
            cwd={ctx.cwd}
            attachment={att}
            preview={preview}
            active={ctx.attachmentImagesActive && previewOpen}
          />
        </HoverCardContent>
      </HoverCard>
    );
  }

  return <Tooltip label={tooltip}>{shell}</Tooltip>;
}
