// ──────────────────────────────────────────────────────────
// TextMessage — user / agent / system bubbles (AI Elements)
// ──────────────────────────────────────────────────────────
//
// Stage 5.5: agent replies render as sanitised markdown
// (marked + DOMPurify, see ../markdown.ts). T3 Chat pattern —
// the per-message useMemo + the MessageView memo together
// guarantee finalized messages parse exactly once and only
// the actively-streaming message re-parses on each chunk.
// Cost stays flat regardless of transcript length.
//
// User and system messages stay plain-text. Users rarely
// type markdown, and rendering their input as HTML would
// surprise them.
//
// thought messages route through EventRowRenderer — they don't reach
// this renderer in the default registry.
//
// Phase 7 (Roadmap 01) — bubble chrome migrated from
// .zeros-agent-msg* CSS classes to AI Elements <Message> +
// <MessageContent>. The role mapping is:
//   - Zeros `agent`  → AI Elements `assistant`
//   - Zeros `user`   → `user`
//   - Zeros `system` → `system`
// Attachment chips + resume/summary boundary dividers keep
// their existing markup so app-shell.css selectors continue
// to bind.
// ──────────────────────────────────────────────────────────

import { memo, useMemo, type SyntheticEvent } from "react";
import type { Renderer, RendererContext } from "./types";
import type {
  AgentTextMessage,
  AgentTextMessageAttachment,
  MessageContentSegment,
} from "../use-agent-session";
import { renderMarkdownSegments, fileRefPath } from "../markdown";
import { iconForFile } from "../agent-attachments";
// Direct path (not the barrel) so the message renderer doesn't pull in the
// whole TipTap editor — just the static pill views.
import {
  MentionPillView,
  AttachmentPillView,
} from "../composer-editor/pill-views";
import { Message, MessageContent } from "@/zeros/ui/primitives/elements";
import { Tooltip } from "@/zeros/ui/primitives";
import { trimTrailingSegments } from "./trim-trailing-segments";
import { MarkdownCodeBlock } from "./markdown-code-block";
import { useAttachmentImageSource } from "../attachment-image-source";

type ChatRole = "user" | "assistant" | "system";

function mapRole(role: AgentTextMessage["role"]): ChatRole {
  if (role === "agent") return "assistant";
  if (role === "user") return "user";
  return "system";
}

/** Resolve a file path from a click/keydown inside the output markdown: a
 *  linkified inline-code chip (`data-file-path`) or an anchor whose href is a
 *  workspace-relative file path. Returns null for anything else (external
 *  links, plain prose) so the default behaviour is left untouched. */
function filePathFromMarkdownTarget(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) return null;
  const chip = target.closest<HTMLElement>("[data-file-path]");
  if (chip) {
    const p = chip.getAttribute("data-file-path");
    return p && p.length > 0 ? p : null;
  }
  const anchor = target.closest("a");
  if (anchor) return fileRefPath(anchor.getAttribute("href") ?? "");
  return null;
}

/** Open a file in row 1 when the user activates a file reference in the
 *  agent's markdown, and route the ACTIVE workspace's PR link to the row-1
 *  PR tab; otherwise let the event proceed (text selection, other external
 *  links, in-page anchors). */
function handleMarkdownActivate(
  e: SyntheticEvent,
  ctx: RendererContext,
): void {
  const path = filePathFromMarkdownTarget(e.target);
  if (path && ctx.openFile) {
    e.preventDefault();
    ctx.openFile(path);
    return;
  }
  // A link to THIS workspace's PR ("PR created: https://github.com/…/pull/13")
  // focuses the Review tab instead of leaving the app.
  const anchor =
    e.target instanceof HTMLElement ? e.target.closest("a") : null;
  const href = anchor?.getAttribute("href") ?? "";
  if (href && ctx.openPrUrl?.(href)) {
    e.preventDefault();
  }
}

export const TextMessage: Renderer<AgentTextMessage> = memo(function TextMessage({
  message,
  ctx,
}) {
  // Hooks must be declared above any conditional return — otherwise a
  // message flipping between resumeBoundary and a normal text message
  // changes the hook count and React throws "Rendered more hooks than
  // during the previous render", blanking the chat surface.
  const role = mapRole(message.role);
  const useMarkdown = message.role === "agent";
  const segments = useMemo(
    () => (useMarkdown ? renderMarkdownSegments(message.text) : null),
    [useMarkdown, message.text],
  );

  // Drop trailing whitespace from the sent user bubble so a message ending in
  // stray newlines/spaces doesn't render as a tall, mostly-empty bubble (the
  // composer keeps `whitespace-pre-wrap`, which would otherwise preserve them).
  // Only the END is trimmed — interior + leading whitespace is kept verbatim.
  const displaySegments = useMemo(
    () => (message.segments ? trimTrailingSegments(message.segments) : undefined),
    [message.segments],
  );

  // Session-continuity notices (resumeBoundary) never render — session
  // rebuilds are invisible by design (2026-07-06 user spec: no resume/
  // continuation UI). groupMessagesIntoTurns drops them before they reach
  // this renderer; this guard covers any other dispatch path.
  if (message.resumeBoundary) return null;

  return (
    <>
      <Message from={role}>
        {/* 01e Phase 3: assistant joins user in variant="flat" — agent
            output is free-flow body copy, no card chrome. System keeps
            "default" for its muted-bubble divider treatment. The user
            bubble's chrome lives on TurnPromptHeader; the assistant's
            text now reads as direct page content rather than a
            chat bubble. */}
        <MessageContent
          variant={role === "system" ? "default" : "flat"}
          // Auto-sent bubbles (PR island / Create PR) read as --brown-fg on
          // the brown bubble TurnPromptHeader paints (cn/twMerge lets this
          // override the flat variant's text-fg1).
          className={
            message.role === "user" && message.autoAction
              ? "text-brown-fg"
              : undefined
          }
        >
          {message.role === "user" &&
          displaySegments &&
          displaySegments.length > 0 ? (
            // 2026-06-08 — inline render: text + mention/attachment pills
            // exactly where they were composed (no separate chip row).
            // wrap-anywhere (not break-words): overflow-wrap:break-word only
            // breaks at LAYOUT time and is ignored for intrinsic (min-content)
            // sizing, so a pasted log/JSON blob kept a huge min-content that
            // forced TurnPromptHeader's w-fit bubble wider than a narrow pane
            // (right-anchored → clipped off the LEFT edge). `anywhere` counts
            // those break opportunities in min-content, so the bubble can
            // shrink to the lane and the text wraps at its edge instead.
            <div className="wrap-anywhere whitespace-pre-wrap leading-snug">
              {displaySegments.map((seg, i) => (
                <MessageSegmentView
                  key={i}
                  seg={seg}
                  onPreviewImage={ctx.previewImage}
                  attachmentCwd={ctx.attachmentCwd}
                  attachmentImagesActive={ctx.attachmentImagesActive}
                />
              ))}
            </div>
          ) : (
            <>
              {message.role === "user" &&
                message.attachments &&
                message.attachments.length > 0 && (
                  // Pre-editor messages (no segments): attachment chips above
                  // the bubble, same pill shape as the composer's old strip.
                  <div
                    className="mb-1.5 flex flex-nowrap gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0"
                    role="list"
                  >
                    {message.attachments.map((a, i) => (
                      <UserBubbleAttachment
                        key={i}
                        a={a}
                        onPreviewImage={ctx.previewImage}
                        attachmentCwd={ctx.attachmentCwd}
                        attachmentImagesActive={ctx.attachmentImagesActive}
                      />
                    ))}
                  </div>
                )}
              {useMarkdown && segments != null ? (
                // Agent output: prose runs render as sanitised HTML; top-level
                // code fences mount as <MarkdownCodeBlock> (shiki + copy). The
                // container delegates clicks/Enter on file-path chips + links
                // to row 1 (see handleMarkdownActivate).
                <div
                  className="zeros-agent-md"
                  onClick={(e) => handleMarkdownActivate(e, ctx)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    handleMarkdownActivate(e, ctx);
                  }}
                >
                  {segments.map((seg, i) =>
                    seg.type === "code" ? (
                      <MarkdownCodeBlock
                        key={i}
                        code={seg.code}
                        lang={seg.lang}
                      />
                    ) : (
                      <div
                        key={i}
                        className="zeros-md-prose"
                        dangerouslySetInnerHTML={{ __html: seg.html }}
                      />
                    ),
                  )}
                </div>
              ) : (
                // Plain text (user / system). `leading-snug` + `whitespace-
                // pre-wrap` match the composer exactly. User bubbles trim
                // trailing whitespace so stray end-of-message newlines/spaces
                // don't balloon the bubble; interior/leading spacing is kept.
                // wrap-anywhere: see the segments branch above — break-words
                // doesn't shrink min-content, so unbroken pastes overflowed
                // the w-fit user bubble past a narrow pane's left edge.
                <div className="wrap-anywhere whitespace-pre-wrap leading-snug">
                  {message.role === "user"
                    ? message.text.trimEnd()
                    : message.text}
                </div>
              )}
            </>
          )}
        </MessageContent>
      </Message>
      {/* No "Summary" divider: summaryBoundary still cuts the replay
          preamble (replay.ts) but compaction points get no visible
          marker (2026-07-06 user spec — no boundary UI in the timeline). */}
    </>
  );
});

/** Single chip on a user bubble showing an attached file. Same
 *  pill shape as the composer's chips so the UI reads as one
 *  system across staging (composer chip strip) and history
 *  (user-bubble chip strip). Image chips show a small thumbnail
 *  + filename and open the saved file in a new tab on click;
 *  file chips show the matching format icon (FileText /
 *  FileJson / Code2 / etc.) + filename. */
/** Shared pill geometry for the message-bubble chips. Same look as the
 *  composer's attachment chips so staging and history match. Image
 *  variant gets `cursor-pointer`; file variant is inert. */
const MSG_CHIP_BASE =
  "inline-flex max-w-[220px] items-center gap-1.5 rounded-sm border border-border1 bg-bg2-hover py-[3px] pl-1 pr-2 text-xs text-fg2 no-underline transition-colors duration-150 ease-out hover:border-highlighted-bright";
const MSG_CHIP_THUMB =
  "h-[18px] w-[18px] shrink-0 rounded-sm object-cover";
const MSG_CHIP_ICON =
  "inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-sm text-fg2";
const MSG_CHIP_LABEL =
  "overflow-hidden text-ellipsis whitespace-nowrap";

/** One inline piece of a sent user message — plain text, a mention pill, or
 *  an attachment pill — rendered with the same components the composer uses. */
function MessageSegmentView({
  seg,
  onPreviewImage,
  attachmentCwd,
  attachmentImagesActive,
}: {
  seg: MessageContentSegment;
  onPreviewImage?: (src: string) => void;
  attachmentCwd?: string | null;
  attachmentImagesActive?: boolean;
}) {
  if (seg.type === "text") return <>{seg.text}</>;
  if (seg.type === "mention") {
    return (
      <MentionPillView label={seg.label} path={seg.path} kind={seg.kind} />
    );
  }
  return (
    <MessageAttachmentPill
      seg={seg}
      cwd={attachmentCwd}
      active={attachmentImagesActive}
      onPreview={onPreviewImage}
    />
  );
}

function MessageAttachmentPill({
  seg,
  cwd,
  active,
  onPreview,
}: {
  seg: Extract<MessageContentSegment, { type: "attachment" }>;
  cwd?: string | null;
  active?: boolean;
  onPreview?: (src: string) => void;
}) {
  const source = useAttachmentImageSource({
    cwd,
    diskPath: seg.diskPath,
    attachmentId: seg.attachmentId,
    legacyUri: seg.thumbnailUri,
    enabled: active,
  });
  return (
    <AttachmentPillView
      name={seg.name}
      kind={seg.kind}
      thumbnailUri={source ?? undefined}
      onPreview={onPreview}
    />
  );
}

function UserBubbleAttachment({
  a,
  onPreviewImage,
  attachmentCwd,
  attachmentImagesActive,
}: {
  a: AgentTextMessageAttachment;
  onPreviewImage?: (src: string) => void;
  attachmentCwd?: string | null;
  attachmentImagesActive?: boolean;
}) {
  const source = useAttachmentImageSource({
    cwd: attachmentCwd,
    diskPath: a.diskPath,
    attachmentId: a.attachmentId,
    legacyUri: a.thumbnailUri,
    enabled: attachmentImagesActive,
  });
  const isImage = a.kind === "image" && Boolean(source);
  if (isImage && source) {
    return (
      <Tooltip label={a.name}>
        <button
          type="button"
          // stopPropagation so clicking an image opens the preview
          // WITHOUT triggering the surrounding TurnPromptHeader's
          // click-to-edit. User can still click text in the bubble to
          // enter edit mode; just images are exempted as a preview
          // affordance.
          onClick={(e) => {
            e.stopPropagation();
            if (onPreviewImage) {
              onPreviewImage(source);
            }
          }}
          className={`${MSG_CHIP_BASE} cursor-pointer`}
        >
          <img
            src={source}
            alt=""
            loading="lazy"
            decoding="async"
            className={MSG_CHIP_THUMB}
          />
          <span className={MSG_CHIP_LABEL}>{a.name}</span>
        </button>
      </Tooltip>
    );
  }
  const Icon = iconForFile(a.name, a.mimeType);
  return (
    <Tooltip label={a.name}>
      <span className={`${MSG_CHIP_BASE} cursor-default`}>
        <span className={MSG_CHIP_ICON} aria-hidden="true">
          <Icon size={11} />
        </span>
        <span className={MSG_CHIP_LABEL}>{a.name}</span>
      </span>
    </Tooltip>
  );
}
