// ──────────────────────────────────────────────────────────
// composer-attachments.tsx — shared attachment surface
// ──────────────────────────────────────────────────────────
//
// Phase D2 (2026-05-07) iter 4. Both composer surfaces — the New
// Agent landing (`EmptyComposer`) and the in-chat composer
// (`AgentChat`) — need the same set of attachment behaviors:
//
//   • A unified top chip row holding image + text attachments and
//     summary imports, with horizontal scroll when overflowing.
//   • Drag-and-drop with overlay over the composer card.
//   • Multi-format file handling (.md/.txt/code/.json/.yaml/.csv +
//     images) with per-attachment validation against the picked
//     model's context window and the agent's image capability.
//   • A pre-send warning banner surfacing every attachment that
//     won't ride on the prompt.
//   • Click-to-preview for image chips (full-screen lightbox).
//
// Before this file the same behaviors lived inline in
// EmptyComposer.tsx — AgentChat had a stripped-down, divergent
// version. Two sources of truth drifted as features landed in one
// surface but not the other. This module is the single source.
//
// Public exports:
//   ComposerAttachment — chip data shape
//   <ComposerAttachmentChips/> — the chip strip
//
// The legacy `useComposerAttachments` hook + paste/warning helpers were
// replaced by the TipTap composer's attachment-io.ts; only the chip data
// shapes and the chip-strip component survive here.
// ──────────────────────────────────────────────────────────

import { memo } from "react";
import { X as XIcon } from "lucide-react";

import { Tooltip } from "@/zeros/ui/primitives";
import { iconForFile, type AttachmentValidation } from "./agent-attachments";

// ── Types ─────────────────────────────────────────────────

/** What a synthesized attachment's hover preview says about its source, frozen
 *  at the moment it was staged.
 *
 *  Snapshot values on purpose: the chip is a FILE, and its header must
 *  describe the file, not the chat that has moved on since. That is the same
 *  reason there is no staleness badge — see chat-transcript-pills.tsx. */
export interface ComposerAttachmentPreview {
  agentId: string | null;
  agentName: string | null;
  /** Prompts the source chat's user sent — see ChatSummaryWire. */
  userMessageCount: number;
  lastMessageAt: number;
}

export interface ComposerAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "text";
  /** base64 payload for images. Empty for text attachments. */
  data: string;
  /** Persisted cwd-relative source for a reconstructed transcript image.
   *  Freshly staged images have bytes in `data`; edit-resend images may have
   *  only this reference until the send pipeline resolves them. */
  diskPath?: string;
  /** Decoded body for text attachments (.md, .txt, etc.). */
  text?: string;
  /** Per-attachment validation outcome under the active agent +
   *  picked model. Recomputed when the agent or model changes. */
  validation: AttachmentValidation;
  /** Caller-owned identity for a SYNTHESIZED attachment (a chat transcript,
   *  as `transcript:<chatId>`). Mirrors the node attr of the same name; empty
   *  for anything the user pasted, dropped or picked. */
  sourceKey?: string;
  /** Present only on a synthesized attachment — turns the chip's plain tooltip
   *  into the same hover preview the source pill has. */
  preview?: ComposerAttachmentPreview;
}

// ── ComposerAttachmentChips ───────────────────────────────

interface ChipsProps {
  attachments: ComposerAttachment[];
  onRemoveAttachment: (id: string) => void;
  onPreviewImage: (dataUri: string) => void;
}

/** Shared chip-X button — used for both summary chips and attachment
 *  chips. The visual is a 16×16 circular ghost-icon that brightens on
 *  hover. Pulled out as a helper so the geometry stays in one place. */
function ChipDismissButton({
  onClick,
  title,
  ariaLabel,
}: {
  onClick: () => void;
  title: string;
  ariaLabel: string;
}) {
  return (
    <Tooltip label={title}>
      <button
        type="button"
        className="text-fg2 hover:bg-bg2-hover hover:text-fg1 ml-0.5 inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0"
        onClick={onClick}
        aria-label={ariaLabel}
      >
        <XIcon size={10} />
      </button>
    </Tooltip>
  );
}

export const ComposerAttachmentChips = memo(function ComposerAttachmentChips({
  attachments,
  onRemoveAttachment,
  onPreviewImage,
}: ChipsProps) {
  if (attachments.length === 0) return null;
  return (
    // Unified top chip row inside the composer card. Single horizontal
    // row (no wrap) with hidden scrollbar; chips keep their intrinsic
    // width so they don't shrink under overflow.
    <div
      className="flex flex-nowrap gap-1 overflow-x-auto overflow-y-hidden py-1 pb-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0"
      role="list"
    >
      {attachments.map((a) => {
        const isImage = a.kind === "image";
        const dataUri = isImage ? `data:${a.mimeType};base64,${a.data}` : null;
        const Icon = iconForFile(a.name, a.mimeType);
        const tooltip = a.validation.ok
          ? a.name
          : `${a.name} — ${a.validation.reason}`;
        const invalid = !a.validation.ok;
        return (
          // Attachment chip — same pill geometry as the summary chip so
          // both kinds line up in the unified strip. `invalid` chips
          // get a warning border + grayscale thumb (still visible so
          // the user knows it was attached, just not silently dropped).
          <Tooltip key={a.id} label={tooltip}>
            <div
              className={[
                "bg-bg2-hover hover:border-highlighted-bright inline-flex max-w-[220px] items-center gap-1.5 rounded-sm py-[3px] pr-1 pl-2 text-xs transition-[background-color,border-color] duration-150 ease-out",
                invalid
                  ? "border-yellow-primary/40 text-fg2 border opacity-85 [&_img]:grayscale [&>button_span:first-child]:grayscale"
                  : "border-border1 text-fg2 border",
                isImage ? "cursor-pointer" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              role="listitem"
            >
              <button
                type="button"
                className="m-0 inline-flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 font-[inherit] text-inherit disabled:cursor-default"
                onClick={() => {
                  if (isImage && dataUri) onPreviewImage(dataUri);
                }}
                disabled={!isImage}
                aria-label={isImage ? "Preview image" : a.name}
              >
                {isImage && dataUri ? (
                  <img
                    src={dataUri}
                    alt=""
                    className="h-[18px] w-[18px] shrink-0 rounded-sm object-cover"
                  />
                ) : (
                  <span
                    className="text-fg2 inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-sm"
                    aria-hidden="true"
                  >
                    <Icon size={11} />
                  </span>
                )}
                <span className="overflow-hidden pl-[2px] text-ellipsis whitespace-nowrap">
                  {a.name}
                </span>
              </button>
              <ChipDismissButton
                onClick={() => onRemoveAttachment(a.id)}
                title="Remove attachment"
                ariaLabel="Remove attachment"
              />
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
});
