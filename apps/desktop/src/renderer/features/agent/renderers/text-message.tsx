// ──────────────────────────────────────────────────────────
// TextMessage — user / agent / system bubbles (AI Elements)
// ──────────────────────────────────────────────────────────
//
// Agent replies render as sanitized markdown
// (marked + DOMPurify, see ../markdown.ts). The
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
// Bubble chrome uses
// .zeros-agent-msg* CSS classes to AI Elements <Message> +
// <MessageContent>. The role mapping is:
//   - Zeros `agent`  → AI Elements `assistant`
//   - Zeros `user`   → `user`
//   - Zeros `system` → `system`
// Attachment chips + resume/summary boundary dividers keep
// their existing markup so app-shell.css selectors continue
// to bind.
// ──────────────────────────────────────────────────────────

import { memo, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { AlarmClock, ChevronDown, ChevronUp, CornerDownRight } from "lucide-react";
import type { Renderer, RendererContext } from "./types";
import type {
  AgentTextMessage,
  AgentTextMessageAttachment,
  MessageContentSegment,
} from "../use-agent-session";
import { createStreamingMarkdownRenderer, renderMarkdownSegments, fileRefPath } from "../markdown";
import { iconForFile } from "../agent-attachments";
// Direct path (not the barrel) so the message renderer doesn't pull in the
// whole TipTap editor — just the static pill views.
import {
  MentionPillView,
  AttachmentPillView,
} from "../composer-editor/pill-views";
import {
  Message,
  MessageContent,
} from "@/renderer/shared/ui/primitives/elements";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { trimTrailingSegments } from "./trim-trailing-segments";
import { groupMessageSegments, type GroupedMessageSegment } from "../composer-editor/attachment-group";
import { openFileGroup } from "@/renderer/shell/workbench/file-group-navigation";
import { openFilePill, warmFilePill } from "@/renderer/shell/workbench/file-pill-navigation";
import { useAttachmentPillFile } from "../attachment-pill-file";
import { Button } from "@/renderer/shared/ui/primitives";
import { FileTypeIcon } from "../composer-editor/file-type-icon";
import { COMPOSER_PILL_SPACING, PILL_HOVER, PILL_SHELL } from "../composer-editor/pill-views";
import { cn } from "@/renderer/shared/ui/cn";
import { MarkdownCodeBlock } from "./markdown-code-block";
import { useAttachmentImageSource } from "../attachment-image-source";
import { RevealHeldContext, useTextReveal } from "./use-text-reveal";
import { fallbackDisplayText } from "../model-fallback";
import { wakeupDisplayText } from "../wakeup-notice";
import { LocalLinkHtml, LocalLinkText } from "../local-links/text";
import { LocalNoteRow } from "../local-links/note-row";
import { parseReply, previewText } from "../chat-selection";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { MessageHoverActions } from "../message-hover-actions";

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
  if (anchor) return fileRefPath(anchor.getAttribute("href") ?? "", true);
  return null;
}

/** Open a file in workbench when the user activates a file reference in the
 *  agent's markdown, and route the ACTIVE workspace's PR link to the workbench
 *  PR tab; otherwise let the event proceed (text selection, other external
 *  links, in-page anchors). */
function handleMarkdownActivate(e: SyntheticEvent, ctx: RendererContext): void {
  const path = filePathFromMarkdownTarget(e.target);
  if (path && ctx.openFile) {
    e.preventDefault();
    ctx.openFile(path);
    return;
  }
  // A link to THIS workspace's PR ("PR created: https://github.com/…/pull/13")
  // focuses the Review tab instead of leaving the app.
  const anchor = e.target instanceof HTMLElement ? e.target.closest("a") : null;
  const href = anchor?.getAttribute("href") ?? "";
  if (href && (ctx.openPreviewUrl?.(href) || ctx.openPrUrl?.(href))) {
    e.preventDefault();
  }
}

export const TextMessage: Renderer<AgentTextMessage> = memo(
  function TextMessage({ message, ctx }) {
    // Hooks must be declared above any conditional return — otherwise a
    // message flipping between resumeBoundary and a normal text message
    // changes the hook count and React throws "Rendered more hooks than
    // during the previous render", blanking the chat surface.
    const role = mapRole(message.role);
    const useMarkdown = message.role === "agent" && !message.modelFallback && !message.wakeupNotice;
    const text = message.modelFallback ? fallbackDisplayText(message.modelFallback) : message.text;
    const proseRef = useRef<HTMLDivElement>(null);
    const reportHeld = useContext(RevealHeldContext);
    // The live tail message renders everything received and is revealed unit
    // by unit (render first, then reveal); an in-between one appears whole.
    const live = useMarkdown && ctx.isStreaming && ctx.lastMessageId === message.id;
    const liveLocal = !!ctx.liveTextSource && live && ctx.attachmentImagesActive !== false;
    const parse = useMemo(() => liveLocal ? createStreamingMarkdownRenderer() : renderMarkdownSegments, [liveLocal]);
    const segments = useMemo(
      () => (useMarkdown ? parse(text) : null),
      [useMarkdown, text, parse],
    );
    useTextReveal(proseRef, { source: text, live, turnLive: ctx.isStreaming,
      endedNaturally: !ctx.isStreaming && ctx.turnEndedNaturally === true,
      active: ctx.attachmentImagesActive !== false, createdAt: message.createdAt, phase: message.phase,
      onHeld: reportHeld ? (held: boolean | null) => reportHeld(message.id, held) : undefined });

    // Drop trailing whitespace from the sent user bubble so a message ending in
    // stray newlines/spaces doesn't render as a tall, mostly-empty bubble (the
    // composer keeps `whitespace-pre-wrap`, which would otherwise preserve them).
    // Only the END is trimmed — interior + leading whitespace is kept verbatim.
    const displaySegments = useMemo(
      () =>
        message.segments ? groupMessageSegments(trimTrailingSegments(message.segments)) : undefined,
      [message.segments],
    );
    // A reply to selected transcript text: a Markdown quote, a blank line, then
    // the reply, with no pills in between.
    const reply = useMemo(() => {
      if (message.role !== "user") return null;
      if (!displaySegments || displaySegments.length === 0) return parseReply(text);
      const only = displaySegments.length === 1 ? displaySegments[0] : null;
      return only?.type === "text" ? parseReply(only.text) : null;
    }, [message.role, displaySegments, text]);

    // Session-continuity notices (resumeBoundary) never render — session
    // rebuilds are invisible by design, with no resume or continuation UI.
    // groupMessagesIntoTurns drops them before they reach
    // this renderer; this guard covers any other dispatch path.
    if (message.resumeBoundary || message.retracted) return null;
    if (message.localNote) return <LocalNoteRow note={message.localNote} />;
    if (message.wakeupNotice) return (
      <div data-wakeup-notice role={ctx.isStreaming ? "status" : undefined} className="text-fg3 flex items-start gap-2 py-1 text-reading leading-5">
        <AlarmClock aria-hidden="true" className="text-fg2 mt-0.5 size-4 shrink-0" />
        <span>{wakeupDisplayText(message.wakeupNotice)}</span>
      </div>
    );

    return (
      <AgentMessageHover message={message} ctx={ctx} wrap={useMarkdown} enabled={!ctx.isStreaming && !!text.trim()}>
        <Message from={role}>
          {/* The assistant joins the user in variant="flat" — agent
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
            {reply && !message.attachments?.length ? (
              <ReplyMessageText quote={reply.quote} reply={reply.reply} active={ctx.attachmentImagesActive !== false} />
            ) : message.role === "user" &&
            displaySegments &&
            displaySegments.length > 0 ? (
              // 2026-06-08 — inline render: text + mention/attachment pills
              // exactly where they were composed (no separate chip row).
              // wrap-anywhere (not break-words): `anywhere` also counts its
              // break opportunities in min-content sizing, so a pasted log or
              // JSON blob never makes the message's min-content wider than the
              // lane, and the text wraps at the bubble's edge.
              <div className="text-reading wrap-anywhere whitespace-pre-wrap">
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
                  // to workbench (see handleMarkdownActivate).
                  <div
                    ref={proseRef}
                    className="zeros-agent-md"
                    onPointerOver={(event) => {
                      const path = filePathFromMarkdownTarget(event.target);
                      if (path && ctx.attachmentImagesActive !== false) ctx.warmFile?.(path);
                    }}
                    onFocus={(event) => {
                      const path = filePathFromMarkdownTarget(event.target);
                      if (path && ctx.attachmentImagesActive !== false) ctx.warmFile?.(path);
                    }}
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
                        <LocalLinkHtml
                          key={i}
                          className="zeros-md-prose"
                          html={seg.html}
                        />
                      ),
                    )}
                  </div>
                ) : (
                  // Plain text (user / system). The reading size and
                  // `whitespace-pre-wrap` match the composer exactly; a system
                  // notice keeps its 13px on 20px lines. User bubbles trim
                  // trailing whitespace so stray end-of-message newlines/spaces
                  // don't balloon the bubble; interior/leading spacing is kept.
                  // wrap-anywhere: see the segments branch above.
                  reply ? <ReplyMessageText quote={reply.quote} reply={reply.reply} active={ctx.attachmentImagesActive !== false} /> : (
                    <div className={cn(message.role === "system" ? "leading-5" : "text-reading", "wrap-anywhere whitespace-pre-wrap")}>
                      <LocalLinkText text={message.role === "user"
                        ? text.trimEnd()
                        : text} />
                    </div>
                  )
                )}
              </>
            )}
          </MessageContent>
        </Message>
        {/* No "Summary" divider: summaryBoundary still cuts the replay preamble
          (replay.ts), but compaction points get no visible boundary UI in the
          timeline. */}
      </AgentMessageHover>
    );
  },
);

/** Whether a one-line truncating element cuts its text at its current width.
 *  Observed only while `watch` (collapsed and shown); a narrow split pane
 *  clips short text too. */
function useClipped<T extends HTMLElement>(watch: boolean) {
  const [element, ref] = useState<T | null>(null);
  const [value, setValue] = useState(false);
  useLayoutEffect(() => {
    if (!element || !watch) return;
    const measure = () => setValue(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, watch]);
  return { ref, value };
}

/** A sent reply: the quoted text on one muted line, then ↳ and the reply.
 *  A quote that doesn't fit expands in place, so none of it is lost. */
function ReplyMessageText({ quote, reply, active }: { quote: string; reply: string; active: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const line = previewText(quote);
  // Retained hidden chats measure nothing; the last answer stands until shown.
  const clipped = useClipped<HTMLSpanElement>(!expanded && active);
  const folds = line !== quote || clipped.value || expanded;
  return (
    <div data-reply-message="" className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-start gap-1">
        <blockquote
          data-reply-quote=""
          data-expanded={expanded || undefined}
          className={cn("text-fg3 min-w-0 flex-1 text-sm", expanded ? "whitespace-pre-wrap wrap-anywhere" : "flex")}
        >
          {expanded ? `“${quote}”` : (
            <>
              <span aria-hidden="true">“</span>
              <span ref={clipped.ref} className="min-w-0 truncate">{line}</span>
              <span aria-hidden="true">”</span>
            </>
          )}
        </blockquote>
        {folds && (
          <IconButton
            size="inline"
            label={expanded ? "Show less of the quote" : "Show the whole quote"}
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? <ChevronUp /> : <ChevronDown />}
          </IconButton>
        )}
      </div>
      <div className="flex min-w-0 items-start gap-1.5">
        <CornerDownRight aria-hidden="true" className="text-fg3 mt-1 size-3.5 shrink-0" />
        <div className="text-reading min-w-0 wrap-anywhere whitespace-pre-wrap">
          <LocalLinkText text={reply} />
        </div>
      </div>
    </div>
  );
}

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
const MSG_CHIP_BASE = cn(PILL_SHELL, COMPOSER_PILL_SPACING, "no-underline");
const MSG_CHIP_THUMB = "size-4 shrink-0 rounded-sm object-cover";
const MSG_CHIP_ICON =
  "inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-fg2";
const MSG_CHIP_LABEL = "overflow-hidden text-ellipsis whitespace-nowrap";

/** One inline piece of a sent user message — plain text, a mention pill, or
 *  an attachment pill — rendered with the same components the composer uses. */
function MessageSegmentView({
  seg,
  onPreviewImage,
  attachmentCwd,
  attachmentImagesActive,
}: {
  seg: GroupedMessageSegment;
  onPreviewImage?: (src: string) => void;
  attachmentCwd?: string | null;
  attachmentImagesActive?: boolean;
}) {
  if (seg.type === "text") return <LocalLinkText text={seg.text} />;
  if (seg.type === "attachment-group") {
    const available = !!attachmentCwd && attachmentImagesActive !== false && seg.files.every(file => !!file.diskPath);
    return <Tooltip label={`${seg.name} · ${seg.files.length} files`}><Button variant="ghost" data-attachment-pill="" data-attachment-group=""
      className={cn(PILL_SHELL, PILL_HOVER, COMPOSER_PILL_SPACING)} disabled={!available} aria-label={`Open ${seg.name}, ${seg.files.length} files`}
      onClick={event => { event.stopPropagation(); if (available) openFileGroup(attachmentCwd, {
        id: seg.id, name: seg.name, files: seg.files.map(file => ({ name: file.name, path: file.diskPath!, attachmentId: file.attachmentId })),
      }); }}>
      <FileTypeIcon name={seg.files[0].name} kind="file" size={13} />
      <span className="max-w-[16rem] truncate">{seg.name}</span>
      <span className="text-muted-fg text-2xxs">+{seg.files.length - 1}</span>
    </Button></Tooltip>;
  }
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
  const saved = useAttachmentPillFile({ cwd, diskPath: seg.diskPath, attachmentId: seg.attachmentId, enabled: active !== false });
  const source = useAttachmentImageSource({
    cwd,
    diskPath: seg.diskPath,
    attachmentId: seg.attachmentId,
    legacyUri: seg.thumbnailUri,
    enabled: active !== false && seg.kind === "image",
  });
  if (saved.path && cwd) return <Tooltip label={seg.name}><Button variant="ghost" data-attachment-pill=""
    disabled={active === false || saved.resolving} aria-label={`Open ${seg.name}`} className={cn(PILL_SHELL, PILL_HOVER, COMPOSER_PILL_SPACING)}
    onPointerEnter={() => warmFilePill(cwd, saved.path!)} onFocus={() => warmFilePill(cwd, saved.path!)}
    onClick={event => { event.stopPropagation(); openFilePill(cwd, saved.path!); }}>
    {seg.kind === "image" && source ? <img src={source} alt="" loading="lazy" decoding="async" className="size-4 shrink-0 rounded-sm object-cover" />
      : <FileTypeIcon name={seg.name} kind="file" size={13} />}<span className="max-w-[16rem] truncate">{seg.name}</span>
  </Button></Tooltip>;
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
    enabled: attachmentImagesActive !== false && a.kind === "image",
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
          className={cn(MSG_CHIP_BASE, PILL_HOVER, "cursor-pointer")}
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

/** Agent output and in-between messages get the floating popup: received
 *  time, copy and, in an interactive transcript, Side chat from here. */
function AgentMessageHover({ message, ctx, wrap, enabled, children }: {
  message: AgentTextMessage;
  ctx: RendererContext;
  wrap: boolean;
  enabled: boolean;
  children: ReactNode;
}) {
  if (!wrap) return <>{children}</>;
  const from = { messageId: message.messageId ?? message.id, promptId: ctx.turnPromptId ?? null, role: "agent" as const, text: message.text };
  return (
    // A settled message reserves the popup's band above its text, so the popup
    // never covers the row or prompt above. Live rows keep the loader's slot.
    <div data-agent-message="" className={cn("group/agentmsg", enabled && "pt-6")}>
      <div className="relative">
      {children}
      {enabled && <MessageHoverActions
        text={message.text}
        createdAt={message.createdAt}
        timeLabel="Received"
        onSideChat={ctx.openSideChat ? () => ctx.openSideChat?.(from) : undefined}
        onSideChatIntent={ctx.warmSideChat ? () => ctx.warmSideChat?.(from) : undefined}
        revealClassName="group-focus-within/agentmsg:pointer-events-auto group-focus-within/agentmsg:opacity-100 group-hover/agentmsg:pointer-events-auto group-hover/agentmsg:opacity-100"
      />}
      </div>
    </div>
  );
}
