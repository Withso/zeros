// ──────────────────────────────────────────────────────────
// pill-views.tsx — presentational inline pills (shared chrome)
// ──────────────────────────────────────────────────────────
//
// Static pill components used by BOTH the editor NodeViews (which wrap them
// in a NodeViewWrapper span) and the sent-message bubble (which renders them
// from persisted MessageContentSegments). Keeping the chrome here means the
// composed pill and the sent pill are pixel-identical.
// ──────────────────────────────────────────────────────────

import { cn } from "../../ui/cn";
import { FileTypeIcon } from "./file-type-icon";
import { Tooltip } from "@/zeros/ui/primitives";

// Unified pill recipe (2026-07-05, per user): 20px tall, 4px radius, bg --bg1,
// border --border3 — the SAME chrome as the tool-row FileTag and the
// turn-footer file pills, so composer pills, sent-bubble pills, and transcript
// pills all read as one family.
// FLAG: the 3px subtraction is the paired 1.5px inline-alignment margins used
// by every caller. The label caps at 16/18rem, but in a narrower pane the pill
// must cap its complete margin box at the composer/bubble width; the truncating
// label then absorbs the squeeze while attachment remove buttons remain usable.
export const PILL_SHELL =
  "inline-flex h-5 max-w-[calc(100%-3px)] items-center gap-1 rounded-sm border border-border3 bg-bg1 align-middle text-xs leading-none text-fg1 select-none";

export function MentionPillView({
  label,
  path,
  kind,
}: {
  label: string;
  path: string;
  kind: "file" | "folder" | "selection";
}) {
  return (
    <Tooltip label={path || label}>
      <span data-mention-pill="" className={cn(PILL_SHELL, "mx-[1.5px] px-2")}>
        <FileTypeIcon name={path || label} kind={kind} size={13} />
        <span className="max-w-[18rem] truncate">{label}</span>
      </span>
    </Tooltip>
  );
}

export function AttachmentPillView({
  name,
  kind,
  thumbnailUri,
  onPreview,
}: {
  name: string;
  kind: "image" | "text";
  thumbnailUri?: string;
  /** Image pills open the lightbox on click; omitted = inert. */
  onPreview?: (dataUri: string) => void;
}) {
  const isImage = kind === "image" && !!thumbnailUri;
  const inner = (
    <>
      {isImage ? (
        <img
          src={thumbnailUri}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-[16px] w-[16px] shrink-0 rounded-sm object-cover"
        />
      ) : (
        <FileTypeIcon name={name} kind="file" size={13} />
      )}
      <span className="max-w-[16rem] truncate">{name}</span>
    </>
  );
  if (isImage && onPreview) {
    return (
      <Tooltip label={name}>
        <button
          type="button"
          data-attachment-pill=""
          className={cn(PILL_SHELL, "mx-[1.5px] cursor-pointer px-1.5")}
          onClick={(e) => {
            // Don't trigger the bubble's click-to-edit.
            e.stopPropagation();
            if (thumbnailUri) onPreview(thumbnailUri);
          }}
        >
          {inner}
        </button>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={name}>
      <span
        data-attachment-pill=""
        className={cn(PILL_SHELL, "mx-[1.5px] px-1.5")}
      >
        {inner}
      </span>
    </Tooltip>
  );
}
