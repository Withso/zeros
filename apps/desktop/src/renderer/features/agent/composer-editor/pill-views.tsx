// ──────────────────────────────────────────────────────────
// pill-views.tsx — presentational inline pills (shared chrome)
// ──────────────────────────────────────────────────────────
//
// Static pill components used by BOTH the editor NodeViews (which wrap them
// in a NodeViewWrapper span) and the sent-message bubble (which renders them
// from persisted MessageContentSegments). Keeping the chrome here means the
// composed pill and the sent pill are pixel-identical.
// ──────────────────────────────────────────────────────────

import { cn } from "../../../shared/ui/cn";
import { FileTypeIcon } from "./file-type-icon";
import { Tooltip } from "@/renderer/shared/ui/primitives";

// Unified pill recipe: the neutral inline Pill (20px, 4px corners, bg2 +
// border2, 12/16, 4px gap, 6px padding) — the SAME chrome as the tool-row
// FileTag and the turn-footer file pills, so composer pills, sent-bubble
// pills, and transcript pills all read as one family.
// FLAG: the 3px subtraction is the paired 1.5px inline-alignment margins used
// by every caller. The label caps at 16/18rem, but in a narrower pane the pill
// must cap its complete margin box at the composer/bubble width; the truncating
// label then absorbs the squeeze while attachment remove buttons remain usable.
export const PILL_METRICS =
  "inline-flex h-5 max-w-[calc(100%-3px)] mx-[1.5px] items-center rounded-sm align-middle text-3xxs leading-4 select-none";
export const PILL_SHELL = `${PILL_METRICS} gap-1 border border-border2 bg-bg2 text-fg1`;
export const COMPOSER_PILL_SPACING = "gap-1 px-1.5";
/** An interactive pill's hover, on the whole pill (its inner buttons paint no
 * fill of their own): bg2-highlight on border3, also while its menu is open. */
export const PILL_HOVER =
  "hover:border-border3 hover:bg-bg2-highlight has-[[data-state=open]]:border-border3 has-[[data-state=open]]:bg-bg2-highlight";
/** The caret's node selection: a fill that holds under the pointer. */
export const PILL_SELECTED = "bg-selected-bg hover:bg-selected-bg has-[[data-state=open]]:bg-selected-bg";

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
      <span data-mention-pill="" className={cn(PILL_SHELL, COMPOSER_PILL_SPACING)}>
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
  kind: "image" | "text" | "file";
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
          className={cn(PILL_SHELL, PILL_HOVER, "cursor-pointer px-1.5")}
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
        className={cn(PILL_SHELL, "px-1.5")}
      >
        {inner}
      </span>
    </Tooltip>
  );
}
