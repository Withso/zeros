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
  useMemo,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Book, Download, Files, Film, MoreHorizontal, X } from "lucide-react";

import { cn } from "../../../shared/ui/cn";
import { FileTypeIcon } from "./file-type-icon";
import { useComposerEditorContext } from "./composer-editor-context";
// Shared pill chrome; editable pills use their leading icon slot for removal.
import { PILL_SHELL, COMPOSER_PILL_SPACING } from "./pill-views";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Tooltip,
  Button,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/renderer/shared/ui/primitives";
import { attachmentNodeIds } from "./attachment-group";
import { openComposerAttachmentGroup } from "../attachment-group-files";
import { isVideoFile } from "./video-key-frames";
import { downloadAttachment } from "../attachment-download";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import {
  AttachmentTextPreview,
  attachmentTextPreviewKey,
  warmAttachmentTextPreview,
} from "./attachment-text-preview";
import { ImageHoverCard, imagePreviewMimeType } from "../image-hover-card";
import { filePillPath, openFilePill, warmFilePill } from "@/renderer/shell/workbench/file-pill-navigation";
import { openSkillPill, warmSkillPill } from "@/renderer/shell/workbench/skill-pill-navigation";
import { validSkillSource } from "../../../platform/skill-source";
import { closeHistory } from "@tiptap/pm/history";
import { attachmentOwner, sameAttachmentOwner } from "../attachment-owner";
import { useAttachmentPillFile } from "../attachment-pill-file";
import { contextAttachmentPath, safeAttachmentFilename } from "@zeros/protocol/attachment-policy";
import { fileMediaType } from "@zeros/protocol/file-media";
import { hasPendingFilePreview, offerPendingFilePreview } from "@/renderer/platform/pending-file-preview";
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
    <Button
      variant="ghost"
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
    </Button>
  );
}

function removePill(props: NodeViewProps): void {
  if (!props.editor.isEditable) return;
  // A quick insert → remove is still two user actions. Do not group removal
  // with the insertion and make Undo erase both instead of restoring the pill.
  props.editor.view.dispatch(closeHistory(props.editor.state.tr));
  props.deleteNode();
}

// ── MentionPill — @-file / folder / selection ──────────────

export function MentionPill(props: NodeViewProps) {
  const ctx = useComposerEditorContext();
  const attrs = props.node.attrs as {
    label: string;
    path: string;
    kind: "file" | "folder" | "selection";
  };
  const canOpen = attrs.kind !== "folder" && ctx.sourceFilesOpen !== false && ctx.attachmentImagesActive && !!filePillPath(ctx.cwd, attrs.path);
  const shell = (
      <NodeViewWrapper
        as="span"
        data-mention-pill=""
        className={cn(
          PILL_SHELL,
          "composer-pill", COMPOSER_PILL_SPACING,
          props.selected && "ring-highlighted-bright/40 ring-2",
        )}
        contentEditable={false}
      >
        <PillRemoveButton
          label={attrs.label}
          disabled={!ctx.editable}
          onRemove={() => {
            removePill(props);
          }}
        >
          <FileTypeIcon
            name={attrs.path || attrs.label}
            kind={attrs.kind}
            size={13}
          />
        </PillRemoveButton>
        <Button type="button" variant="ghost" aria-label={`Open ${attrs.label}`} disabled={!canOpen}
          onMouseDown={(event) => event.preventDefault()}
          onPointerEnter={() => { if (canOpen) warmFilePill(ctx.cwd, attrs.path); }}
          onFocus={() => { if (canOpen) warmFilePill(ctx.cwd, attrs.path); }}
          onClick={() => { if (canOpen) openFilePill(ctx.cwd, attrs.path); }}
          className="m-0 min-w-0 border-0 bg-transparent p-0 text-inherit disabled:opacity-100">
          <span className="max-w-[18rem] truncate">{attrs.label}</span>
        </Button>
      </NodeViewWrapper>
  );
  return attrs.kind !== "folder" && imagePreviewMimeType(attrs.path) ? (
    <ImageHoverCard name={attrs.path} path={attrs.path} cwd={ctx.cwd} enabled={canOpen}>{shell}</ImageHoverCard>
  ) : <Tooltip label={attrs.path || attrs.label}>{shell}</Tooltip>;
}

/** Skills carry an invocation and source identity, never attachment bytes. */
export function SkillPill(props: NodeViewProps) {
  const ctx = useComposerEditorContext();
  const { name, label, path, source, provider } = props.node.attrs;
  // Session commands can arrive before filesystem discovery. Resolve a still
  // unknown source when that exact provider's catalog lands, without editing
  // the document or retargeting an already captured source.
  const discovered = !path && !source && provider === ctx.agentId
    ? ctx.skills?.find(skill => skill.id === name || skill.name === name) : undefined;
  const file = filePillPath(ctx.cwd, typeof path === "string" && path ? path : discovered?.path ?? "");
  const candidate = source ?? (discovered && !file ? { agentId: provider, path: discovered.path, name: discovered.name } : null);
  const library = validSkillSource(candidate) ? candidate : null;
  const canOpen = ctx.sourceFilesOpen !== false && ctx.attachmentImagesActive && !!ctx.cwd && !!(library || file);
  const title = library?.path || file || `/${name}`;
  return <Tooltip label={title}>
    <NodeViewWrapper as="span" data-skill-pill="" contentEditable={false}
      className={cn(PILL_SHELL, "composer-pill", COMPOSER_PILL_SPACING, props.selected && "ring-highlighted-bright/40 ring-2")}>
      <PillRemoveButton label={label} disabled={!ctx.editable} onRemove={() => removePill(props)}>
        <Book className="size-3" />
      </PillRemoveButton>
      <Button type="button" variant="ghost" aria-label={`Open ${label}`} disabled={!canOpen}
        onMouseDown={event => event.preventDefault()}
        onPointerEnter={() => { if (canOpen) { if (library) warmSkillPill(ctx.cwd, library); else if (file) warmFilePill(ctx.cwd, file); } }}
        onFocus={() => { if (canOpen) { if (library) warmSkillPill(ctx.cwd, library); else if (file) warmFilePill(ctx.cwd, file); } }}
        onClick={() => { if (canOpen) { if (library) openSkillPill(ctx.cwd, library); else if (file) openFilePill(ctx.cwd, file); } }}
        className="m-0 min-w-0 border-0 bg-transparent p-0 text-inherit disabled:opacity-100">
        <span className="max-w-[18rem] truncate">{label}</span>
      </Button>
    </NodeViewWrapper>
  </Tooltip>;
}

// ── AttachmentPill — inline image / text-file attachment ───

export function AttachmentPill(props: NodeViewProps) {
  if (attachmentNodeIds(props.node.attrs).length > 1) return <AttachmentGroupPill {...props} />;
  return <SingleAttachmentPill {...props} />;
}

function AttachmentGroupPill(props: NodeViewProps) {
  const ctx = useComposerEditorContext();
  const ids = useMemo(() => attachmentNodeIds(props.node.attrs), [props.node.attrs]);
  const files = ids.map(id => ctx.getAttachment(id));
  const progress = useSyncExternalStore(useCallback(listener => {
    if (!ctx.cwd || !ctx.attachmentImagesActive) return () => {};
    const stops = ids.map(id => subscribeFileAttachmentProgress(ctx.cwd!, ctx.getAttachment(id)?.contextAttachmentId ?? id, listener));
    return () => stops.forEach(stop => stop());
  }, [ctx, ids]), () => ids.map(id =>
    ctx.cwd ? getFileAttachmentProgress(ctx.cwd, ctx.getAttachment(id)?.contextAttachmentId ?? id)?.phase ?? "" : "").join(","), () => "");
  const invalid = files.some(file => !file || !file.validation.ok || file.unavailable) || progress.includes("error");
  const name = String(props.node.attrs.name), id = String(props.node.attrs.groupId);
  const available = files.filter((file): file is NonNullable<typeof file> => !!file);
  const open = () => {
    if (ctx.onOpenAttachment) return; // Create's menu below opens each selected source.
    openComposerAttachmentGroup(ctx.cwd, id, name, available);
  };
  const label = <><span className="max-w-[16rem] truncate">{name}</span><span className="text-muted-fg shrink-0 text-xxs">+{ids.length - 1}</span></>;
  return <Tooltip label={`${name} · ${ids.length} files${invalid ? " · Some files are unavailable" : progress.includes("saving") ? " · Saving attachments" : ""}`}>
    <NodeViewWrapper as="span" contentEditable={false} data-attachment-pill="" data-attachment-group="" aria-busy={progress.includes("saving") || undefined}
      className={cn(PILL_SHELL, "composer-pill", COMPOSER_PILL_SPACING, props.selected && "ring-highlighted-bright/40 ring-2", invalid && "border-yellow-icon/40")}>
      <PillRemoveButton label={name} disabled={!ctx.editable} onRemove={() => removePill(props)}><Files size={13} /></PillRemoveButton>
      {ctx.onOpenAttachment ? <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" aria-label={`Open ${name}, ${ids.length} files`} disabled={!ctx.attachmentImagesActive}
          onMouseDown={event => event.preventDefault()} className="m-0 flex min-w-0 gap-2 border-0 bg-transparent p-0 text-inherit">{label}</Button></DropdownMenuTrigger>
        <DropdownMenuContent>{available.map(file => <DropdownMenuItem key={file.id} onSelect={() => ctx.onOpenAttachment?.(file)}>{file.name}</DropdownMenuItem>)}</DropdownMenuContent>
      </DropdownMenu> : <Button variant="ghost" aria-label={`Open ${name}, ${ids.length} files`} disabled={!ctx.attachmentImagesActive || !ctx.cwd || !available.length}
        onMouseDown={event => event.preventDefault()} onClick={open} className="m-0 flex min-w-0 gap-2 border-0 bg-transparent p-0 text-inherit">{label}</Button>}
    </NodeViewWrapper>
  </Tooltip>;
}

function SingleAttachmentPill(props: NodeViewProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const attrs = props.node.attrs as {
    attachmentId: string;
    name: string;
    mimeType: string;
    kind: "image" | "text" | "file";
  };
  const ctx = useComposerEditorContext();
  const att = ctx.getAttachment(attrs.attachmentId);
  const download = useRef<AbortController | null>(null);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => () => { download.current?.abort(); download.current = null; setDownloading(false); }, [ctx.cwd, ctx.attachmentImagesActive, att]);
  const imageMime = imagePreviewMimeType(attrs.name, att?.mimeType ?? attrs.mimeType);
  const isImage = imageMime !== null;
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
  const ownedAttachment = !att?.owner || (!!ctx.cwd && sameAttachmentOwner(att.owner, attachmentOwner(ctx.cwd)));
  const pendingPath = ctx.cwd && att?.sourceFile && fileMediaType(att.name)
    ? contextAttachmentPath(att.contextAttachmentId ?? att.id, safeAttachmentFilename(att.name)) : undefined;
  const storedPath = progress?.diskPath ?? (ownedAttachment ? att?.diskPath : undefined) ?? pendingPath;
  const restoredFile = useAttachmentPillFile({
    cwd: ctx.cwd,
    diskPath: storedPath,
    attachmentId: att?.contextAttachmentId,
    enabled: ctx.attachmentImagesActive && !ctx.onOpenAttachment && !!att && !att.sourceFile && !att.data && !progress,
  });
  const diskPath = restoredFile.path;
  const canPreviewPending = !!ctx.cwd && !!diskPath && !!att?.sourceFile && !!fileMediaType(att.name) && (pendingPath === diskPath || hasPendingFilePreview(ctx.cwd, diskPath));
  const canOpenSource = ctx.attachmentImagesActive && !!ctx.onOpenAttachment && !!att && !att.unavailable;
  const canOpen = ctx.attachmentImagesActive && !restoredFile.resolving && !att?.unavailable &&
    (progress?.phase !== "saving" || canPreviewPending) && !!diskPath && !!filePillPath(ctx.cwd, diskPath);
  const invalid =
    (att ? !att.validation.ok : false) || progress?.phase === "error";
  const tooltip =
    progress?.phase === "error"
      ? `${attrs.name} — ${progress.error}`
      : att && !att.validation.ok
        ? `${attrs.name} — ${att.validation.reason}`
        : progress?.phase === "saving"
          ? `${attrs.name} — Saving attachment${progress.percent > 0 ? ` (${progress.percent}%)` : ""}`
          : attrs.name;
  // A synthesized attachment (a chat transcript) carries enough metadata to
  // show the selected file on hover instead of its own filename. Read the
  // staged Blob or its saved record, never the source chat's newer transcript.
  //
  // An INVALID text attachment keeps its tooltip regardless of the preview.
  // `tooltip` is the only live surface in the app for validation.reason, and
  // an invalid attachment is excluded at send — so swapping it for a panel
  // would make the largest attachment the app can stage the one case that is
  // dropped with no explanation anywhere.
  const preview =
    att?.preview && att.kind === "text" && !invalid ? att.preview : null;
  const warmPreview = () => {
    if (canOpen && diskPath && !canPreviewPending) warmFilePill(ctx.cwd, diskPath);
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
        "composer-pill", COMPOSER_PILL_SPACING,
        props.selected && "ring-highlighted-bright/40 ring-2",
        invalid &&
          "border-yellow-icon/40 text-fg2 opacity-85 [&_[data-composer-pill-icon]]:grayscale",
      )}
      contentEditable={false}
    >
      <PillRemoveButton
        label={attrs.name}
        disabled={!ctx.editable}
        onRemove={() => {
          removePill(props);
        }}
      >
        <FileTypeIcon
          name={attrs.name}
          kind={isImage ? "image" : "file"}
          size={13}
        />
      </PillRemoveButton>
      <Button
        variant="ghost"
        type="button"
        // mousedown preventDefault so clicking a pill doesn't blur/move the
        // ProseMirror selection; the saved file opens in the workbench.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (canOpenSource && att) ctx.onOpenAttachment?.(att);
          else if (canOpen && diskPath) {
            if (canPreviewPending && ctx.cwd && att?.sourceFile) offerPendingFilePreview(ctx.cwd, diskPath, att.sourceFile);
            openFilePill(ctx.cwd, diskPath);
          }
        }}
        disabled={!canOpenSource && !canOpen}
        aria-label={`Open ${attrs.name}`}
        data-file-path={diskPath}
        className="m-0 inline-flex min-w-0 items-center gap-1 border-0 bg-transparent p-0 font-[inherit] text-inherit disabled:cursor-default disabled:opacity-100"
      >
        {/* Transfer status belongs in the tooltip: adding/removing inline
            text resizes this pill and rewraps every later file in a drop. */}
        <span className="max-w-[16rem] truncate">{attrs.name}</span>
      </Button>
      {att && isVideoFile({ name: att.name, mimeType: att.mimeType }) && <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" aria-label={`Actions for ${att.name}`}
          disabled={!ctx.editable || !ctx.attachmentImagesActive} onMouseDown={event => event.preventDefault()}
          className="text-fg2 size-4 shrink-0 border-0 bg-transparent p-0"><MoreHorizontal size={12} /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem disabled={downloading || !att.validation.ok || att.unavailable} onSelect={() => {
            if (download.current) return;
            const controller = new AbortController(); download.current = controller; setDownloading(true);
            void downloadAttachment(att, ctx.cwd, controller.signal).catch(() => {
              if (!controller.signal.aborted) toast.error("Couldn't download this file.");
            }).finally(() => { if (download.current === controller) { download.current = null; setDownloading(false); } });
          }}><Download className="size-3.5" />{downloading ? "Downloading…" : "Download"}</DropdownMenuItem>
          <DropdownMenuItem disabled={extracting || !ctx.attachVideoFrames} onSelect={() => {
            setExtracting(true);
            void Promise.resolve(ctx.attachVideoFrames?.(attrs.attachmentId)).finally(() => setExtracting(false));
          }}><Film className="size-3.5" />{extracting ? "Extracting frames…" : "Attach as frames"}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>}
    </NodeViewWrapper>
  );

  if (isImage) {
    return <ImageHoverCard name={attrs.name} mimeType={imageMime} cwd={ctx.cwd} path={diskPath}
      sourceFile={att?.sourceFile} legacyUri={att?.data ? `data:${imageMime};base64,${att.data}` : undefined}
      enabled={ctx.attachmentImagesActive} status={tooltip}>{shell}</ImageHoverCard>;
  }

  // Synthesized transcript files retain their frozen text preview.
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
