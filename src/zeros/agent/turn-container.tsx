// ──────────────────────────────────────────────────────────
// TurnContainer — per-turn structural wrapper for the chat
// ──────────────────────────────────────────────────────────
//
// Phase 1 §2.5.1: every event between two consecutive user
// prompts forms a "turn." The renderer wraps each turn in a
// container so the active turn's user prompt can be sticky-
// positioned at the top of the scroll viewport for the entire
// duration of that turn — solving the user's "I can't scroll
// back to remember what I asked during a 30-min run" worry.
//
// Once the next turn starts (a new user prompt arrives), the
// previous turn's container is no longer active, sticky drops
// off, and the prompt scrolls naturally with the rest of the
// transcript.
//
// `groupMessagesIntoTurns` is the pure boundary-detection
// helper. A turn starts on every text message with role:"user".
// Everything else (assistant text, thinking, tool calls) is
// part of the most recent turn's `events`. Messages that arrive
// before any user prompt land in a "system turn" with
// `userPrompt: null` (rare; happens during agent warm-up).
//
// ──────────────────────────────────────────────────────────

import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Plus, Pencil, Copy, Check, ChevronDown } from "lucide-react";
import type {
  AgentMessage,
  AgentTextMessage,
  AgentTextMessageAttachment,
  MessageContentSegment,
} from "./use-agent-session";
import { formatCompactAge } from "./format-age";
import { autoActionIcon } from "./auto-action";
import { cn } from "@/zeros/ui/cn";
import { Button } from "../ui";
import { Tooltip } from "@/zeros/ui/primitives";
import type { ComposerAttachment } from "./composer-attachments";
import {
  useComposerEditor,
  messageToEditorContent,
  toMessageSegments,
  type ComposerInitialContent,
} from "./composer-editor";
import type { AvailableCommand } from "../bridge/agent-events";
import {
  PromptInput,
  PromptInputBody,
  PromptInputToolbar,
  PromptInputTools,
  PromptInputSubmit,
} from "@/zeros/ui/primitives/elements";
import {
  useEditComposerDraft,
  useWorkspaceDispatch,
  type EditDraftStash,
} from "../store/store";

export interface Turn {
  /** The user prompt that started this turn. null only for the
   *  rare leading "system turn" — events arriving before the
   *  first user prompt (e.g. the agent's session-init system
   *  message). */
  userPrompt: AgentTextMessage | null;
  /** All non-user-prompt messages that belong to this turn,
   *  in their arrival order. Includes assistant text, thinking,
   *  tool calls, and any other AgentMessage variants. */
  events: AgentMessage[];
}

/** Stable id for a turn — the user-prompt id, or a synthetic one
 *  derived from the first event when there's no prompt. Used as
 *  the React key on the container. */
export function turnKey(turn: Turn): string {
  if (turn.userPrompt) return `turn-${turn.userPrompt.id}`;
  if (turn.events.length > 0) return `turn-evt-${turn.events[0].id}`;
  return "turn-empty";
}

export function groupMessagesIntoTurns(messages: AgentMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const m of messages) {
    if (m.kind === "text" && m.resumeBoundary) {
      // Session-continuity notices are invisible by design (2026-07-06 user
      // spec: no resume/continuation UI, ever). Newer sessions no longer
      // emit them; this skip hides the ones persisted by older builds.
      continue;
    }
    if (m.kind === "text" && m.role === "user") {
      if (current) turns.push(current);
      current = { userPrompt: m, events: [] };
    } else {
      if (!current) {
        // Leading event before any user prompt — rare
        current = { userPrompt: null, events: [] };
      }
      current.events.push(m);
    }
  }
  if (current) turns.push(current);
  return turns;
}

interface TurnContainerProps {
  turn: Turn;
  /** True when this is the most recent turn (and therefore the
   *  one whose user prompt sticky-pins to the viewport top).
   *  Only one turn is active at a time; older turns scroll
   *  naturally with the rest of the transcript. */
  isActive: boolean;
  children: React.ReactNode;
}

/**
 * Wraps a turn's children in a container that establishes the
 * positioning context for the sticky user-prompt header. The
 * actual sticky styling lives on the inner `<TurnPromptHeader>`
 * — the container itself just provides the layout boundary.
 *
 * Memoized so a streaming chunk to the active turn doesn't
 * re-render the inactive turns above it.
 */
export const TurnContainer = memo(function TurnContainer({
  turn,
  isActive,
  children,
}: TurnContainerProps) {
  // The .zeros-agent-turn / -turn-active class names are retained for
  // any external DOM selectors (e.g. future jump-by-turn navigation);
  // visual styling now lives on the inline utilities below. content-
  // visibility lets the browser skip layout/paint for off-viewport
  // finalized turns; the active turn always renders so its sticky
  // prompt + live tool cards stay in the layout tree.
  //
  // `auto` in contain-intrinsic-size (2026-07-21): a skipped turn uses its
  // LAST RENDERED height instead of the fixed 240px estimate. Without it,
  // hiding a chat (visibility-hidden deck layer, workspace switch) collapsed
  // every turn to 240px — the transcript's scrollHeight shrank, the browser
  // clamped scrollTop, and the reading position shifted on every reveal by
  // the accumulated estimate error. With the remembered size, hide/reveal is
  // geometry-preserving for any turn that has been rendered at least once;
  // never-rendered far history keeps the 240px estimate (identical at save
  // and restore time, so offsets stay consistent there too).
  const className = isActive
    ? "zeros-agent-turn zeros-agent-turn-active flex flex-col gap-4 relative [content-visibility:visible] [contain-intrinsic-size:auto_0px_auto_240px]"
    : "zeros-agent-turn flex flex-col gap-4 relative [content-visibility:auto] [contain-intrinsic-size:auto_0px_auto_240px]";
  // Phase 2 chat overhaul (2026-05-07): the per-turn TurnRail (vertical
  // green-dot activity skim in the left gutter) was reported as visual
  // noise — it duplicated the collapsed-turn chip row — and was removed.
  //
  // data-checkpoint-id (2026-07-15): the CheckpointRail's scroll-spy /
  // click-to-jump anchor. It lives on THIS element (not the prompt
  // header inside) because this is the content-visibility boundary —
  // measuring a descendant would force layout of every skipped turn on
  // each scroll frame. The container's top equals the prompt's top (the
  // prompt is the first child), so the rail's math is exact.
  return (
    <div
      className={className}
      data-checkpoint-id={turn.userPrompt?.id}
      // Pane-host reparenting snapshots this content-visibility boundary's
      // live block size before detach. Chromium otherwise forgets the `auto`
      // remembered size and paints one frame of 240px fallback geometry.
      data-scroll-intrinsic-size=""
    >
      {children}
    </div>
  );
});

// (QueuedPromptBubble removed 2026-07-06 — still-pending queued sends now
//  render in the QueuedMessagesCard docked above the composer, not as greyed
//  transcript bubbles. See src/zeros/agent/queued-messages-card.tsx.)

/**
 * Sticky-positioned wrapper for a turn's user prompt.
 *
 * Phase 2 chat overhaul (2026-05-07): all turns are sticky now
 * (Cursor-style stacking) — as the user scrolls up through history
 * each turn's prompt pins to the viewport top until the next turn's
 * prompt arrives and pushes it off. Previously only the active turn
 * pinned, which lost the "what did I ask?" anchor for older turns.
 *
 * Click-to-edit (Phase 2): when `originalText` + `onEdit` are passed,
 * clicking the header swaps the children for an editable textarea
 * pre-filled with the original prompt. Cmd+Enter / Enter submits;
 * Esc cancels. Submission truncates this message + everything after
 * (caller's responsibility) and re-sends the edited text. Files on
 * disk are NOT reverted — that's a Phase A snapshot follow-up
 * (docs/research/08_revert_capability_per_agent.md).
 *
 * §2.5.1 — long prompts (>3 lines) collapse to a clamped preview
 * with a chevron toggle, so a multi-paragraph prompt doesn't eat
 * viewport while pinned. Short prompts (single line, ≤3 lines)
 * skip the chrome entirely — the chevron only appears when content
 * actually overflows the clamp.
 */
/** Agent context the edit-mode composer needs for attachment
 *  validation and image-vs-disk routing. Mirrors the args
 *  `useComposerAttachments` accepts so the edit composer behaves
 *  identically to the main one. */
export interface EditAgentContext {
  agentId: string | null;
  agentName: string | null;
  agentSupportsImage: boolean | undefined;
  modelId: string | null;
  /** Slash-command + @-mention + #-PR picker inputs (so the edit composer
   *  has the SAME pickers as the chat composer via useComposerPickers). */
  availableCommands?: AvailableCommand[];
  cwd?: string | null;
  originUrl?: string | null;
}

export const TurnPromptHeader = memo(function TurnPromptHeader({
  children,
  chatId,
  messageId,
  createdAt,
  editingMessageId,
  onRequestEdit,
  originalText,
  originalAttachments,
  originalSegments,
  onEdit,
  editToolbarPills,
  editAgentContext,
  autoAction,
  surfaceActive = true,
}: {
  children: React.ReactNode;
  /** The chat this turn belongs to. Used together with `messageId`
   *  to key the persistent edit-draft stash in the workspace store
   *  (so a draft survives chat switches). */
  chatId?: string;
  /** The user message id this header represents. Drives single-edit-
   *  at-a-time coordination via `editingMessageId` lifted to the
   *  parent (only the header whose id matches enters edit mode). */
  messageId?: string;
  /** Epoch-ms the user message was created. Rendered as a compact
   *  age ("6s" / "6m" / "6h" / "6d" / "6y") in the hover actions row. */
  createdAt?: number;
  /** Phase D3 (2026-05-08): the parent owns "which turn is being
   *  edited" so opening edit on one turn auto-closes any other.
   *  `null` = no turn in edit mode. */
  editingMessageId?: string | null;
  /** Called with this header's `messageId` to claim edit mode, or
   *  with `null` to release it. */
  onRequestEdit?: (id: string | null) => void;
  /** The plain text of the user message wrapped by this header. When
   *  paired with `onEdit`, clicking the header opens an editable
   *  textarea seeded with this text. Omit both to disable editing. */
  originalText?: string;
  /** Attachments stamped on the original user message. Displayed
   *  read-only above the editable composer (bubble metadata lacks
   *  the bytes needed to re-encode them, so they ride through
   *  `editAndResubmit`'s carriedBubbleAttachments instead). */
  originalAttachments?: AgentTextMessageAttachment[];
  /** Ordered segments of the original message — reconstructs mention pills
   *  when editing (plain-text fallback for pre-editor messages). */
  originalSegments?: MessageContentSegment[];
  /** Submit handler for the click-to-edit flow. Called with the trimmed
   *  edited text, ALL staged attachments (reconstructed originals + new,
   *  inline), and the ordered bubble segments. Omit to disable editing. */
  onEdit?: (
    editedText: string,
    attachments: ComposerAttachment[],
    segments: MessageContentSegment[],
  ) => void;
  /** Pills (model / effort / permissions) rendered in the edit-mode
   *  toolbar so editing a past message has the same affordances as
   *  the main composer. The component appends its own Cancel/Send
   *  controls after these pills. */
  editToolbarPills?: React.ReactNode;
  /** Phase D3 (2026-05-08): edit composer is a full composer now,
   *  so it needs the same agent / model context the main composer
   *  feeds into `useComposerAttachments` for per-attachment
   *  validation. Required when `onEdit` is set. */
  editAgentContext?: EditAgentContext;
  /** Set when Zeros auto-sent this message on the user's behalf (PR-island /
   *  Create-PR buttons). Renders the brown "sent by Zeros" bubble with the
   *  action's icon. Callers also omit `onEdit` for these — the wire text is a
   *  generated brief the short label can't round-trip. */
  autoAction?: string;
  /** Whether this chat is the one currently surfaced in its pane. The
   *  keep-alive chat deck (column2-chat-deck.tsx) keeps hidden chats
   *  MOUNTED (visibility-hidden, not unmounted), so a prompt the user
   *  expanded would stay expanded across a tab switch. Threading this lets
   *  the clamped prompt collapse whenever the chat is hidden, so returning
   *  to it shows the prompt truncated again. Defaults true (treat as
   *  visible) for callers that don't track surfacing. */
  surfaceActive?: boolean;
}) {
  // Phase D3 (2026-05-08, refined): edit-mode draft state lives in
  // the workspace store keyed by `${chatId}:${messageId}` so it
  // survives the chat-view remount when the user switches chats and
  // comes back. Local TurnPromptHeader state would die with AgentChat
  // — and that bug was exactly what users hit ("after a few minutes
  // it was gone" = they switched chats in between).
  const dispatch = useWorkspaceDispatch();
  const editStashKey =
    chatId && messageId !== undefined ? `${chatId}:${messageId}` : null;
  // Subscribe to just THIS turn's edit-draft entry, so a draft change in one
  // turn header doesn't re-render every other header in the transcript.
  const editStash = useEditComposerDraft(editStashKey ?? "") ?? null;
  const persistEditStash = useCallback(
    (stash: EditDraftStash) => {
      if (!chatId || messageId === undefined) return;
      dispatch({ type: "SET_EDIT_DRAFT", chatId, messageId, stash });
    },
    [chatId, messageId, dispatch],
  );
  const clearEditStash = useCallback(() => {
    if (!chatId || messageId === undefined) return;
    dispatch({ type: "CLEAR_EDIT_DRAFT", chatId, messageId });
  }, [chatId, messageId, dispatch]);

  const editable = !!onEdit && typeof originalText === "string";
  // Editing is derived from the lifted parent state — only the
  // header whose messageId matches editingMessageId is in edit mode.
  // Switching to another header auto-closes this one (the parent
  // updates editingMessageId to the new id and this branch unmounts).
  const editing =
    editable && messageId !== undefined && messageId === editingMessageId;

  const beginEdit = useCallback(() => {
    if (!editable || messageId === undefined) return;
    onRequestEdit?.(messageId);
  }, [editable, messageId, onRequestEdit]);

  const exitEdit = useCallback(() => {
    onRequestEdit?.(null);
  }, [onRequestEdit]);

  // ── Editing ──────────────────────────────────────────────
  // Expand to a full-width composer card so the inline editor has room.
  // Echoes the bottom composer's chrome (bg-bg2 + border-border2 +
  // px-3.5 py-3) so editing a past message reads as the same surface
  // family. The inner TurnPromptEditor neutralises its own InputGroup
  // chrome so this wrapper's chrome shows through.
  if (editing && onEdit) {
    return (
      <div className="zeros-agent-turn-prompt is-editing border-border2 bg-bg2 w-full rounded-lg border px-3.5 py-3">
        {/* Mounted-only-while-editing keeps `useComposerAttachments`'
            document-level drag listeners scoped to the active edit
            (otherwise every TurnPromptHeader on the page would attach
            its own pair). */}
        <TurnPromptEditor
          originalText={originalText ?? ""}
          originalAttachments={originalAttachments}
          originalSegments={originalSegments}
          stash={editStash}
          onPersistDraft={persistEditStash}
          onClearDraft={clearEditStash}
          onEdit={onEdit}
          onCancel={exitEdit}
          editToolbarPills={editToolbarPills}
          agentContext={editAgentContext}
        />
      </div>
    );
  }

  // ── Display ──────────────────────────────────────────────
  // A right-aligned, fit-to-content bubble (capped at max-w-[768px]). The
  // right offset + bubble shape is what signals "this is what *you* said"
  // — the Cursor / ChatGPT / iMessage convention. The 768px cap matches the
  // agent answer lane's cap (turn-event-list.tsx): both content streams read
  // at 768 inside the wider max-w-[1152px] band/composer envelope. The
  // wrapper's `items-end` right-anchors this bubble to the band's right edge
  // (lining up with the composer's right edge); the answer lane is the
  // left-anchored counterpart, so the conversation reads prompt-right /
  // answer-left within the wide envelope. The cap is ABSOLUTE, so the bubble
  // fills the available width when the band is narrower than 768 (shrunk
  // col 2 → it fits the window) and only caps once past 768. NOT sticky
  // any more:
  // the prompt scrolls freely with the transcript (the JumpToPromptPill
  // still offers a manual "jump to your prompt" when it scrolls off).
  //   • bg-highlighted-bg + border-border1 + px-3 py-2 (12px horizontal /
  //     8px vertical) + rounded-sm (4px, all corners) — the inner
  //     MessageContent keeps its text-fg1, so the bubble look is unchanged
  //     from before; only the width + alignment changed.
  //   • cursor-text/select-text: the bubble is plain content now, so its
  //     text is selectable — click-to-edit moved to the explicit edit
  //     button in the hover actions row beneath it.
  // The actions row (edit / copy / age) is absolutely positioned at the
  // bottom-right and fades in on hover, so it costs no layout height.
  // Auto-sent bubbles ("sent by Zeros" — PR island / Create PR): the brown
  // treatment + the firing button's icon differentiates them from typed
  // messages. Copy-only (editable is false — callers omit onEdit).
  const AutoIcon = autoAction ? autoActionIcon(autoAction) : null;
  return (
    <div className="zeros-agent-turn-prompt group/usermsg relative flex flex-col items-end">
      <div
        className={cn(
          "w-fit max-w-[768px] cursor-text rounded-sm border px-3 py-2 select-text",
          autoAction
            ? // font-medium (500) sets the auto-sent label apart from typed
              // prose — only these "Create a PR" / "Commit & Push" bubbles.
              "bg-brown-bg text-brown-fg border-transparent font-medium"
            : "border-border1 bg-highlighted-bg",
        )}
      >
        <ClampedUserPrompt
          surfaceActive={surfaceActive}
          fadeFrom={autoAction ? "from-brown-bg" : "from-highlighted-bg"}
        >
          {AutoIcon ? (
            // 16px icon at 2px stroke, tight 6px gap to the label (2026-07-19
            // sizing spec for auto-sent bubbles).
            <div className="flex items-start gap-1.5">
              <AutoIcon
                className="text-brown-fg mt-0.5 size-4 shrink-0"
                strokeWidth={2}
              />
              <div className="min-w-0">{children}</div>
            </div>
          ) : (
            children
          )}
        </ClampedUserPrompt>
      </div>
      {typeof originalText === "string" && (
        <UserMessageActions
          text={originalText}
          createdAt={createdAt}
          canEdit={editable}
          onEdit={beginEdit}
        />
      )}
    </div>
  );
});

// ──────────────────────────────────────────────────────────
// ClampedUserPrompt — max-height cap + "More" reveal
// ──────────────────────────────────────────────────────────
//
// A sent prompt taller than PROMPT_MAX_HEIGHT is TRUNCATED, not scrolled:
// the previous per-bubble scroll (max-h-[60vh] + hidden scrollbar) trapped
// wheel events on a giant paste and read as a glitch. Instead the clipped
// last line fades into the bubble bg and a "More" pill floats over it;
// clicking reveals the full message.
//
// `expanded` is LOCAL state, but on its own that is NOT enough to collapse
// on tab switch: the keep-alive chat deck (column2-chat-deck.tsx) keeps
// hidden chats MOUNTED (visibility-hidden), so this component survives a
// switch-and-return with its state intact. We therefore also collapse
// whenever the chat is hidden (surfaceActive=false) — so returning to a
// chat shows the prompt clamped again and re-expanding needs another click.
const PROMPT_MAX_HEIGHT = 600; // px — keep in sync with the max-h-[600px] literal below.

function ClampedUserPrompt({
  children,
  fadeFrom,
  surfaceActive,
}: {
  children: React.ReactNode;
  /** Gradient start color matching the bubble bg so the truncation
   *  dissolves into it — `from-highlighted-bg` (typed) / `from-brown-bg`
   *  (auto-sent). Passed as a class since Tailwind v4 needs the literal. */
  fadeFrom: string;
  /** False while this chat is hidden behind another tab; drives the
   *  collapse-on-hide the keep-alive deck would otherwise defeat. */
  surfaceActive: boolean;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  // Measure once on mount (a sent prompt's text is immutable) and on width
  // reflow via the observer (the bubble narrows/widens as col 2 resizes).
  // scrollHeight reports the FULL content height even while the box is
  // clamped (max-height + overflow-hidden don't shrink it), so the verdict
  // stays correct across collapsed → expanded → resize. Layout effect so the
  // clamp lands before paint (no unclamped flash on a long prompt).
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () =>
      setOverflowing(el.scrollHeight > PROMPT_MAX_HEIGHT + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Collapse when the chat is hidden so it reads collapsed on return.
  useEffect(() => {
    if (!surfaceActive) setExpanded(false);
  }, [surfaceActive]);

  const clamped = overflowing && !expanded;

  return (
    <div className="relative">
      <div
        ref={contentRef}
        className={cn(clamped && "max-h-[600px] overflow-hidden")}
      >
        {children}
      </div>
      {clamped && (
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
          // Whole bottom strip is the hit target: fade the clipped last line
          // into the bubble bg (bottom-opaque → top-transparent) and center the
          // "More" pill on it. h-14 (56px) ≈ two lines of feathering.
          className={cn(
            "group/more absolute inset-x-0 bottom-0 z-[1] flex h-14 cursor-pointer items-end justify-center bg-gradient-to-t to-transparent pb-1 focus-visible:outline-none",
            fadeFrom,
          )}
        >
          <span className="text-fg2 group-hover/more:bg-bg1-hover group-hover/more:text-fg1 group-focus-visible/more:ring-highlighted-bright inline-flex items-center gap-0.5 rounded-sm px-1.5 py-0.5 text-xs font-medium transition-colors group-focus-visible/more:ring-1">
            More
            <ChevronDown className="size-3.5" strokeWidth={2} />
          </span>
        </button>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// UserMessageActions — hover row beneath a sent user bubble
// ──────────────────────────────────────────────────────────
//
// Floats at the bubble's bottom-right (absolute, top-full) and fades in
// on hover/focus of the surrounding `group/usermsg`. Holds the edit and
// copy affordances plus a compact age badge. pointer-events are gated on
// hover so the (invisible) row never intercepts clicks on content below.
function UserMessageActions({
  text,
  createdAt,
  canEdit,
  onEdit,
}: {
  /** Plain text copied to the clipboard by the copy button. */
  text: string;
  /** Epoch-ms; rendered as a compact age. Omitted/0 hides the badge. */
  createdAt?: number;
  /** Whether the edit affordance is offered (false when no onEdit wired). */
  canEdit: boolean;
  onEdit: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const age = typeof createdAt === "number" ? formatCompactAge(createdAt) : "";

  const copy = useCallback(async () => {
    try {
      // Trim trailing whitespace so the clipboard matches the rendered
      // bubble (text-message.tsx trims the display) — copy never carries
      // stray end-of-message newlines/spaces. Edit keeps the raw text.
      await navigator.clipboard.writeText(text.trimEnd());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked under some sandbox configs */
    }
  }, [text]);

  // 16px button with a 12px icon (2px pad); age badge sits at text-xs (12px).
  const btn =
    "inline-flex size-4 items-center justify-center rounded-sm text-fg2 transition-colors hover:bg-bg1-hover hover:text-fg1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-highlighted-bright";

  return (
    <div className="pointer-events-none absolute top-full right-0 z-[2] flex items-center gap-0.5 pt-1 opacity-0 transition-opacity duration-150 ease-out group-focus-within/usermsg:pointer-events-auto group-focus-within/usermsg:opacity-100 group-hover/usermsg:pointer-events-auto group-hover/usermsg:opacity-100">
      {canEdit && (
        <Tooltip label="Edit message">
          <button
            type="button"
            onClick={onEdit}
            className={btn}
            aria-label="Edit message"
          >
            <Pencil className="size-3" strokeWidth={2} />
          </button>
        </Tooltip>
      )}
      <Tooltip label={copied ? "Copied" : "Copy message"}>
        <button
          type="button"
          onClick={copy}
          className={btn}
          aria-label={copied ? "Copied" : "Copy message"}
        >
          {copied ? (
            <Check className="size-3" strokeWidth={2} />
          ) : (
            <Copy className="size-3" strokeWidth={2} />
          )}
        </button>
      </Tooltip>
      {age && (
        <Tooltip
          label={createdAt ? new Date(createdAt).toLocaleString() : undefined}
        >
          <span className="text-fg3 px-1 text-xs tabular-nums select-none">
            {age}
          </span>
        </Tooltip>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// TurnPromptEditor — mounted only while edit mode is active.
// ──────────────────────────────────────────────────────────

function TurnPromptEditor({
  originalText,
  originalAttachments,
  originalSegments,
  stash,
  onPersistDraft,
  onClearDraft,
  onEdit,
  onCancel,
  editToolbarPills,
  agentContext,
}: {
  originalText: string;
  originalAttachments?: AgentTextMessageAttachment[];
  originalSegments?: MessageContentSegment[];
  stash: EditDraftStash | null;
  onPersistDraft: (stash: EditDraftStash) => void;
  onClearDraft: () => void;
  onEdit: (
    editedText: string,
    attachments: ComposerAttachment[],
    segments: MessageContentSegment[],
  ) => void;
  onCancel: () => void;
  editToolbarPills?: React.ReactNode;
  agentContext?: EditAgentContext;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Seed the editor: a prior in-progress edit (stash json) or the WHOLE
  // original message reconstructed as inline content — text + mention pills +
  // attachment pills (image bytes recovered from the persisted thumbnails), in
  // place. No separate "originals" row; everything is inline + editable.
  const initialContentRef = useRef<ComposerInitialContent>(
    stash?.json
      ? { json: stash.json, attachments: stash.newAttachments }
      : messageToEditorContent({
          text: originalText,
          segments: originalSegments,
          attachments: originalAttachments,
        }),
  );
  const originalAttachmentCount = useRef(
    initialContentRef.current.attachments.length,
  ).current;
  const submitRef = useRef<() => void>(() => {});
  const persistRef = useRef<() => void>(() => {});

  const composer = useComposerEditor({
    agentId: agentContext?.agentId ?? null,
    agentName: agentContext?.agentName ?? null,
    agentSupportsImage: agentContext?.agentSupportsImage,
    modelId: agentContext?.modelId ?? null,
    cwd: agentContext?.cwd ?? null,
    originUrl: agentContext?.originUrl ?? null,
    availableCommands: agentContext?.availableCommands ?? [],
    placeholder: "Edit your message…",
    onSubmit: () => submitRef.current(),
    onEscape: onCancel,
    onChange: () => persistRef.current(),
    initialContent: initialContentRef.current,
  });
  const {
    editor,
    isEmpty: composerEmpty,
    serialize,
    insertFiles: addFiles,
    editorContent,
    suggestionPopup,
    imagePreviewOverlay,
    dragActive,
    dragHandlers,
  } = composer;

  // Focus + caret at end once the editor mounts.
  useEffect(() => {
    if (editor) editor.commands.focus("end");
  }, [editor]);

  // Click outside the editor closes it (pills/menus render in-tree, so a
  // `contains` check covers the editor, attach button, pills, and overlay).
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent) => {
      const root = wrapperRef.current;
      if (!root) return;
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (root.contains(target)) return;
      onCancel();
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
    };
  }, [onCancel]);

  // Live-state mirror for the unmount persist/discard (can't read state in the
  // cleanup closure). Refreshed on every editor change. `submittedRef` flips
  // true only on send → discard the stash.
  const liveRef = useRef<{
    text: string;
    attachments: ComposerAttachment[];
    json: object | null;
  }>({
    text: stash?.text ?? originalText,
    attachments: stash?.newAttachments ?? initialContentRef.current.attachments,
    json: stash?.json ?? initialContentRef.current.json ?? null,
  });
  const persistDraft = useCallback(() => {
    const s = serialize();
    liveRef.current = {
      text: s?.displayText ?? "",
      attachments: s?.attachments ?? [],
      json: s?.json ?? null,
    };
  }, [serialize]);
  persistRef.current = persistDraft;

  const submittedRef = useRef(false);
  useEffect(() => {
    return () => {
      if (submittedRef.current) {
        onClearDraft();
        return;
      }
      const { text, attachments, json } = liveRef.current;
      const isPristine =
        text.trim() === originalText.trim() &&
        attachments.length === originalAttachmentCount;
      if (isPristine) {
        onClearDraft();
        return;
      }
      onPersistDraft({
        text,
        newAttachments: attachments,
        keptOriginals: [],
        json,
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitEdit = useCallback(() => {
    const s = serialize();
    const trimmed = (s?.displayText ?? "").trim();
    const attachments = s?.attachments ?? [];
    if (trimmed.length === 0 && attachments.length === 0) {
      // Nothing to send — treat as cancel.
      onCancel();
      return;
    }
    submittedRef.current = true;
    onEdit(
      trimmed,
      attachments,
      toMessageSegments(s?.segments ?? [], attachments),
    );
    onCancel();
  }, [serialize, onEdit, onCancel]);
  submitRef.current = submitEdit;

  const sendDisabled = composerEmpty;

  return (
    <div
      ref={wrapperRef}
      // Stop click bubbling so the parent wrapper's beginEdit handler
      // doesn't re-fire on every interaction inside the editor.
      onClick={(e) => e.stopPropagation()}
    >
      <PromptInput
        onSubmit={(e) => {
          e.preventDefault();
          if (!sendDisabled) submitEdit();
        }}
      >
        <div
          // Phase D3 (2026-05-08, refined): the edit composer drops its
          // own card chrome (border/bg/padding/shadow) so the outer
          // sticky wrapper's chrome shows through. The chromeless
          // override on PromptInputBody below also nullifies the
          // InputGroup primitive's default border/shadow/radius so
          // the surrounding sticky chrome reads cleanly.
          className={`zeros-agent-turn-prompt-edit relative${
            dragActive ? "ring-highlighted-bright/40 ring-2" : ""
          }`}
          {...dragHandlers}
        >
          <PromptInputBody className="items-stretch rounded-none border-0 bg-transparent p-0 shadow-none has-[[data-slot=input-group-control]:focus-visible]:border-0 has-[[data-slot=input-group-control]:focus-visible]:shadow-none has-[[data-slot=input-group-control]:focus-visible]:ring-0 dark:bg-transparent">
            {suggestionPopup}
            {/* TipTap editor — the whole message inline: text + mention pills +
                attachment pills (originals reconstructed in place + any new
                ones). Enter submits, Esc cancels (via the editor keymap). */}
            {editorContent}
            <PromptInputToolbar className="min-w-0 gap-1.5 pt-1 pr-0 pb-1 pl-0">
              {/* gap-0.5: exactly 2px between the + and the pill block, matching
                  the main composer (2026-07-10 user spec). */}
              <PromptInputTools className="gap-0.5">
                <Tooltip label="Attach file">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="Attach file"
                    className="rounded-sm"
                  >
                    <Plus size={14} />
                  </Button>
                </Tooltip>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = e.target.files;
                    if (files) void addFiles(files);
                    e.target.value = "";
                  }}
                />
                {editToolbarPills}
              </PromptInputTools>
              <Tooltip label="Resend" shortcut="↵">
                <PromptInputSubmit
                  disabled={sendDisabled}
                  aria-label="Resend edited prompt"
                  className="disabled:bg-bg2-hover disabled:text-fg2 size-8 disabled:opacity-100"
                />
              </Tooltip>
            </PromptInputToolbar>
          </PromptInputBody>
        </div>
      </PromptInput>
      {imagePreviewOverlay}
    </div>
  );
}

// (EditModeAttachmentChip removed 2026-06-09 — edit mode now reconstructs the
//  whole message inline via the editor, so there is no separate originals row.)
