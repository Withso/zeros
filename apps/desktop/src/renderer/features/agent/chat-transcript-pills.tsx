// ============================================
// COMPONENT: ChatTranscriptPills
// PURPOSE: One click to carry another chat's history into this prompt.
// USED IN: chat-provenance.tsx (as its fourth row), on an empty chat only.
// ============================================
//
// A new chat tab is the one place in the app where you have JUST decided to
// start over — and, until now, the one place with no way to bring the last
// chat's context with you. The path it replaces is four steps and can't be
// undone: right-click the old tab (which you may have already closed) → Copy
// full transcript → click the new tab → paste 116 KB of Markdown into the
// composer, where it IS your prompt text and removing it means selecting 2,500
// lines by hand.
//
// Three decisions worth knowing before editing this file:
//
//   • EVERY CLICK ATTACHES THE CONCISE TRANSCRIPT. There is no mode switch in
//     the row. Concise is user-prompt → concluding answer per turn — the
//     decisions, at roughly a tenth of the volume, which is what a fresh agent
//     needs. Full is archaeology, and it lives on the right-click menu, which
//     is where this app already keeps exactly these two options (the chat
//     tab's own context menu). A group-level switch charged every user for a
//     choice most sessions never make, on the one line an empty state can
//     least afford to complicate.
//
//   • THE PILL IS LIVE; THE CHIP IS A FILE. Until you click, a pill tracks the
//     source chat — its count ticks, its preview re-reads, its shimmer comes
//     and goes. The click materialises a .txt and from that instant the
//     attachment is fixed. No staleness badge and no refresh glyph: an
//     attachment that chases its source is a file that changes under you
//     between reading it and sending it. Want newer? Remove and click again.
//
//   • THE COMPOSER DOCUMENT IS THE SOURCE OF TRUTH for "is this attached".
//     `stagedSourceKeys` comes off the TipTap doc, so removing a chip with its
//     × un-adds the pill for free. There is no second list to keep in sync,
//     which is the only way two representations of one fact stay honest.

// --- IMPORTS ---
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Check,
  ChevronDown,
  MessageCircleMore,
  MessageSquareText,
  Paperclip,
} from "lucide-react";

import {
  Button,
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ZerosSpinner,
} from "@/renderer/shared/ui/primitives";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/renderer/shared/ui/primitives/context-menu";
import { cn } from "@/renderer/shared/ui/cn";
import { AgentIcon } from "./agent-icon";
import {
  loadTranscriptSnapshot,
  splitTranscriptPills,
  transcriptPillLabel,
} from "./chat-transcript-attach";
import { TranscriptPreviewCard } from "./chat-transcript-preview";
import { useChatStreaming } from "./sessions-store";
import type { ChatSummaryWire } from "./agent-history-client";
import type { TranscriptMode } from "./transcript-format";

// --- TYPES ---
export interface ChatTranscriptPillsProps {
  /** Ordered newest-created first, current chat already excluded. */
  summaries: readonly ChatSummaryWire[];
  /** Source-chat ids with an attachment staged in the composer right now. */
  attachedChatIds: ReadonlySet<string>;
  /** Stage (or replace) this chat's transcript. Rejects nothing — a failed
   *  read is reported by the caller's toast. */
  onAttach: (summary: ChatSummaryWire, mode: TranscriptMode) => void;
  /** Un-stage whatever this chat contributed. */
  onRemove: (chatId: string) => void;
  /** Source chats whose read is in flight. Usually empty — the hover that
   *  precedes the click has already warmed it. */
  pendingChatIds?: ReadonlySet<string>;
  /** Abandon an in-flight attach (a second click on a pending pill). */
  onCancel?: (chatId: string) => void;
  /** Switch to that chat's tab — "wait, which one was that?" without spending
   *  a click on attach-then-undo. */
  onOpenChat: (chatId: string) => void;
}

interface PillProps {
  summary: ChatSummaryWire;
  attached: boolean;
  pending: boolean;
  onAttach: ChatTranscriptPillsProps["onAttach"];
  onRemove: ChatTranscriptPillsProps["onRemove"];
  onCancel: (chatId: string) => void;
  onOpenChat: ChatTranscriptPillsProps["onOpenChat"];
}

/** True once `pending` has held for 250ms.
 *
 *  A warm read resolves in single-digit milliseconds, so an unconditional
 *  spinner would flash on every click — worse than no feedback, because a
 *  flash reads as a glitch rather than as progress. */
function useDelayedPending(pending: boolean): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!pending) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), 250);
    return () => clearTimeout(t);
  }, [pending]);
  return shown;
}

// --- RENDER ---
/** The pill's leading glyph — sized by INK, not by box.
 *
 *  A pill is 24px around a 13px label, so the text beside the glyph is only
 *  ~9.3px of actual cap-height. Match that and the glyph reads as a sibling of
 *  the word; exceed it and the row reads as a strip of marks with captions.
 *
 *  The catch is that the two glyphs that share this slot fill their boxes very
 *  differently, so one number cannot drive both:
 *
 *    - the brand SVGs are full-bleed in a 0 0 24 24 viewBox — ink == box, so
 *      `size` is literally the ink height. 14 (the chat TAB's size, on a 28px
 *      row where the logo is the thing you aim at) is 1.5× the cap-height
 *      here, and even 12 is still 1.29×.
 *    - ZerosSpinner reserves 25% of its box as padding (innerRatio 0.75), so
 *      its ink is 0.75 × size.
 *
 *  Hence a fixed 14px SLOT with two different glyph sizes inside it, landing
 *  both on ~10px of ink. The slot is what keeps the pill from resizing under
 *  the pointer when the spinner swaps in mid-read.
 *
 *  LOGO_PX ALONE IS NOT ENOUGH, and this is the whole trap: `Button`'s base
 *  class carries `[&_svg]:size-4`, which pins EVERY descendant svg to 16px.
 *  AgentIcon sizes its wrapper <span> and leaves the inner svg on its
 *  `width="1em"` presentation attribute — and CSS beats presentation
 *  attributes, so inside a Button the mark renders 16px no matter what `size`
 *  says. Lowering `size` just shrank a span around an unchanged glyph.
 *  LOGO_CLASS is what actually moves the ink; the two must stay in step.
 *  (ZerosSpinner is exempt — it draws divs, not svg — which is why its size
 *  prop always worked.) */
const LOGO_PX = 10; // full-bleed → 10px of ink
const LOGO_CLASS = "[&_svg]:size-2.5"; // 10px — twMerge drops Button's size-4
const SPINNER_PX = 14; // × 0.75 innerRatio → 10.5px of ink

/** One chat = one pill.
 *
 *  `Button variant="secondary" size="sm"` already IS this shape — 24px tall,
 *  10px padding, 4px radius, 13px medium, transparent on border2, hover to
 *  bg2-hover/border3, 3px highlighted-bright focus ring. No className visual
 *  overrides; the pressed look is a documented shared variant. */
function TranscriptPill({
  summary,
  attached,
  pending,
  onAttach,
  onRemove,
  onCancel,
  onOpenChat,
}: PillProps) {
  const label = transcriptPillLabel(summary);
  const streaming = useChatStreaming(summary.chatId);
  const showSpinner = useDelayedPending(pending);

  // Pointer intent warms the same read the preview renders and the click
  // consumes (the click handler must not await I/O). The panel is
  // what makes this honest — the cost is paid for something the user sees.
  const warm = useCallback(() => {
    void loadTranscriptSnapshot({
      chatId: summary.chatId,
      mode: "concise",
      lastMessageAt: summary.lastMessageAt,
      meta: { title: summary.title, folder: summary.folder },
    }).catch(() => {
      /* the click path reports; a warm-up must never surface an error */
    });
  }, [summary.chatId, summary.lastMessageAt, summary.title, summary.folder]);

  // A pointer crossing the row touches every pill on the way past, and each
  // read is several engine round trips over up to 4 MB of raw payload — six
  // of those for a gesture that meant none of them. Resting for 150ms is the
  // difference between intent and transit; it is well under the preview's
  // 400ms, so anything the user actually looks at is warm before it opens.
  const warmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelWarm = useCallback(() => {
    if (warmTimer.current === null) return;
    clearTimeout(warmTimer.current);
    warmTimer.current = null;
  }, []);
  const warmOnRest = useCallback(() => {
    cancelWarm();
    warmTimer.current = setTimeout(warm, 150);
  }, [cancelWarm, warm]);
  useEffect(() => cancelWarm, [cancelWarm]);

  // Cancel beats remove beats attach. The pending pill stays enabled on
  // purpose — a disabled control mid-read is a dead end on a surface where
  // the read can legitimately take a minute.
  const toggle = () => {
    if (pending) onCancel(summary.chatId);
    else if (attached) onRemove(summary.chatId);
    else onAttach(summary, "concise");
  };

  // This button advertises `aria-haspopup="menu"`, and until now nothing made
  // that true for the keyboard: Radix's trigger listens for `contextmenu`
  // alone, macOS has no context-menu key, and Enter is already spent on the
  // default attach. So the full transcript — the menu's whole reason to exist
  // — was reachable by mouse only.
  //
  // ⌥-Enter synthesises the event Radix is already waiting for rather than
  // lifting the menu's open state into React: one route in, so the pointer and
  // the keyboard cannot drift apart. The coordinates matter — Radix anchors
  // the panel at the event's client point, and an undispatched 0,0 would open
  // it in the window corner instead of on the pill.
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const openMenuFromKeyboard = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!e.altKey || e.key !== "Enter") return;
    const el = pillRef.current;
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(r.left + r.width / 2),
        clientY: Math.round(r.bottom),
      }),
    );
  };

  const pill = (
    <Button
      ref={pillRef}
      type="button"
      variant={attached ? "secondary-on" : "secondary"}
      size="sm"
      aria-pressed={attached}
      aria-haspopup="menu"
      aria-busy={pending || undefined}
      // Carries the preview's header line, so a screen reader gets the same
      // three facts a sighted user gets from the panel without entering one.
      aria-label={`${
        pending ? "Cancel attaching" : attached ? "Remove" : "Attach"
      } transcript of ${label} — ${summary.agentName ?? "agent"}, ${
        summary.userMessageCount
      } ${summary.userMessageCount === 1 ? "prompt" : "prompts"}`}
      onPointerEnter={warmOnRest}
      onPointerLeave={cancelWarm}
      // Focus is always deliberate — no rest delay for the keyboard.
      onFocus={warm}
      onClick={toggle}
      onKeyDown={openMenuFromKeyboard}
      className={cn("max-w-[14.5rem] gap-1.5", LOGO_CLASS)}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {showSpinner || streaming ? (
          // One glyph, two causes: this read is running, or the source chat is.
          // Both are "something is happening to this chat", and it is the
          // identical swap conversation/chat-tabs makes on that chat's own tab — so
          // one animation means one thing everywhere in the app.
          <ZerosSpinner
            size={SPINNER_PX}
            variant="agent"
            label={showSpinner ? "Reading transcript" : "Agent working"}
          />
        ) : (
          <AgentIcon
            agentId={summary.agentId}
            iconUrl={null}
            size={LOGO_PX}
            // monochrome→brand on select is already the tab strip's idiom.
            monochrome={!attached}
          />
        )}
      </span>
      <span className="truncate">{label}</span>
      {attached ? (
        // No size class: LOGO_CLASS governs every glyph in this pill, and a
        // `size-*` here would be dead markup — the descendant rule outranks it.
        <Check className="text-green-primary" aria-hidden="true" />
      ) : (
        <span className="text-muted-fg text-2xxs tabular-nums">
          {summary.userMessageCount}
        </span>
      )}
    </Button>
  );

  // Two triggers, ONE element. Both roots render no DOM of their own, so the
  // two `asChild` triggers must nest directly around the Button and let Slot
  // merge their handlers onto it. Wrapping <HoverCard> in
  // <ContextMenuTrigger asChild> instead looks equivalent and is not: the
  // trigger would hand its ref and onContextMenu to a context provider, which
  // drops them — right-click would silently do nothing, which is the whole
  // route to the full transcript.
  return (
    <HoverCard openDelay={400} closeDelay={120}>
      <ContextMenu>
        <HoverCardTrigger asChild>
          <ContextMenuTrigger asChild>{pill}</ContextMenuTrigger>
        </HoverCardTrigger>
        <ContextMenuContent>
          {/* Same two words, same order, same icons as the chat tab's own
              menu. Concise stays listed even though a plain click already does
              it: three items cost nothing and naming the default is the
              cheapest possible teach. */}
          <ContextMenuItem onSelect={() => onAttach(summary, "concise")}>
            <MessageSquareText />
            <span>Attach concise transcript</span>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onAttach(summary, "full")}>
            <Paperclip />
            <span>Attach full transcript</span>
          </ContextMenuItem>
          {/* Under a separator because it unmounts this whole row by switching
              tabs — it must not sit adjacent to the two attach verbs. */}
          <ContextMenuSeparator className="bg-border3" />
          <ContextMenuItem onSelect={() => onOpenChat(summary.chatId)}>
            <span>Open this chat</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <HoverCardContent
        // Opens UPWARD into the empty transcript area — never down over the
        // composer the user came here to type into.
        side="top"
        align="start"
        collisionPadding={12}
        className="w-[24rem] overflow-hidden p-0"
      >
        <TranscriptPreviewCard
          chatId={summary.chatId}
          agentId={summary.agentId}
          agentName={summary.agentName}
          userMessageCount={summary.userMessageCount}
          lastMessageAt={summary.lastMessageAt}
          mode="concise"
          title={summary.title}
          folder={summary.folder}
        />
      </HoverCardContent>
    </HoverCard>
  );
}

export interface TranscriptPickerProps {
  summaries: readonly ChatSummaryWire[];
  attachedChatIds: ReadonlySet<string>;
  onAttach: ChatTranscriptPillsProps["onAttach"];
  onRemove: ChatTranscriptPillsProps["onRemove"];
  onClose: () => void;
}

/** Match a chat on its label AND its first prompt, so searching for something
 *  you said finds the chat you said it in.
 *
 *  Deliberately NOT wired to the FTS5 `messages.search` op: full-text hits
 *  surface chats whose title has nothing to do with the query, and a picker
 *  that returns transcripts you don't recognise is worse than one that returns
 *  fewer. This is a client-side filter over a list already in hand. */
export function filterTranscriptSummaries(
  summaries: readonly ChatSummaryWire[],
  query: string,
): readonly ChatSummaryWire[] {
  const q = query.trim().toLowerCase();
  if (!q) return summaries;
  return summaries.filter((s) =>
    `${transcriptPillLabel(s)} ${s.summary}`.toLowerCase().includes(q),
  );
}

/** The picker's guts, without the surface around them — so the row's popover
 *  and the composer menu's dialog are the same list with the same semantics.
 *
 *  No section headers, no open/closed split, no timestamps, no sizes: one row
 *  is one line, in the same creation order as the pills above it, so the
 *  picker's first rows ARE the row and "N more" is an honest label rather than
 *  a door into a differently-organised list. */
export function TranscriptPickerBody({
  summaries,
  attachedChatIds,
  onAttach,
  onRemove,
  onClose,
}: TranscriptPickerProps) {
  // Search text. Owned here rather than delegated to cmdk's built-in filter
  // because that one SORTS BY SCORE — which would silently re-order the list
  // the moment you typed, so the thing you were reaching for moves. Filtering
  // must narrow, never rearrange.
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => filterTranscriptSummaries(summaries, query),
    [summaries, query],
  );

  return (
    <>
      <CommandInput
        placeholder="Search chats…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No chats match.</CommandEmpty>
        <CommandGroup>
          {filtered.map((s) => {
            const label = transcriptPillLabel(s);
            const attached = attachedChatIds.has(s.chatId);
            return (
              <CommandItem
                key={s.chatId}
                value={s.chatId}
                onSelect={() => {
                  if (attached) onRemove(s.chatId);
                  else onAttach(s, "concise");
                  onClose();
                }}
                className="gap-2"
              >
                <AgentIcon
                  agentId={s.agentId}
                  iconUrl={null}
                  size={14}
                  monochrome
                />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {/* Same displacement the pill makes, so the picker is a second
                    VIEW of one state rather than a second state. */}
                {attached ? (
                  <Check
                    className="text-green-primary size-3 shrink-0"
                    aria-hidden="true"
                  />
                ) : (
                  <span className="text-muted-fg text-2xxs shrink-0 tabular-nums">
                    {s.userMessageCount}
                  </span>
                )}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </>
  );
}

/** The row's overflow surface. */
function TranscriptPickerPopoverBody(props: TranscriptPickerProps) {
  return (
    <Command shouldFilter={false}>
      <TranscriptPickerBody {...props} />
    </Command>
  );
}

/** The composer "+" menu's surface — the same picker, reached from a chat that
 *  already has messages, where the pill row is long gone. */
export function TranscriptPickerDialog({
  open,
  onOpenChange,
  ...rest
}: TranscriptPickerProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      shouldFilter={false}
      title="Attach chat transcript"
      description="Search this workspace's chats and attach one's transcript."
      className="max-w-[32rem]"
    >
      <TranscriptPickerBody {...rest} />
    </CommandDialog>
  );
}

const NO_PENDING: ReadonlySet<string> = new Set();

export function ChatTranscriptPills({
  summaries,
  attachedChatIds,
  onAttach,
  onRemove,
  onOpenChat,
  pendingChatIds = NO_PENDING,
  onCancel = () => {},
}: ChatTranscriptPillsProps) {
  // --- STATE ---
  // Overflow popover. Ephemeral by design — it is a transient disclosure on a
  // surface that unmounts the moment the chat has a message.
  const [pickerOpen, setPickerOpen] = useState(false);

  const { shown, overflow } = useMemo(
    () => splitTranscriptPills(summaries),
    [summaries],
  );

  // NO teardown here, deliberately. The cache is module-global and this
  // component mounts in every retained chat surface whose transcript is empty
  // — including hidden ones. A per-instance `useEffect(() =>
  // clearTranscriptCache, [])` therefore let ANY of those unmounting (a
  // background chat receiving its first message, say) wipe the entries a
  // different, visible row had just paid several engine round trips for,
  // turning its next click into a cold multi-second read. The two-entry MRU
  // in chat-transcript-attach.ts is the memory bound; a shared cache does not
  // get a per-instance owner.

  // The row appears or it doesn't — it never skeletons. This block sits above
  // a composer the user is about to type into; a placeholder is more
  // distracting than a missing line.
  if (summaries.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-fg2 flex items-center gap-2 text-sm">
        {/* A conversation glyph, not a paperclip: like the folder/branch/
            terminal rows it sits beside, this icon names WHAT the row is about
            — chats — rather than the mechanism that gets them there. */}
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <MessageCircleMore className="size-3.5" aria-hidden="true" />
        </span>
        {/* No colon and no trailing control: the pills are self-evidently the
            objects of the verb, and the mode switch that used to sit here is
            gone. */}
        <span>Add chat transcripts</span>
      </div>
      {/* Indented to the provenance rows' TEXT column (14px icon + 8px gap) so
          the pills read as belonging to the sentence above them without a box,
          a rule, or a heading. */}
      <div
        className="ml-[22px] flex flex-wrap gap-1.5"
        role="group"
        aria-label="Add chat transcripts"
      >
        {shown.map((s) => (
          <TranscriptPill
            key={s.chatId}
            summary={s}
            attached={attachedChatIds.has(s.chatId)}
            pending={pendingChatIds.has(s.chatId)}
            onAttach={onAttach}
            onRemove={onRemove}
            onCancel={onCancel}
            onOpenChat={onOpenChat}
          />
        ))}
        {overflow.length > 0 && (
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="gap-1"
              >
                {/* The count is the disclosure — never a silent cap. */}
                <span>{overflow.length} more</span>
                <ChevronDown className="size-3" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-[20rem] p-0">
              {/* The FULL list, not just the hidden tail: "N more" opens one
                  continuous list whose first rows are the pills you can
                  already see, which is what makes the label honest. */}
              <TranscriptPickerPopoverBody
                summaries={summaries}
                attachedChatIds={attachedChatIds}
                onAttach={onAttach}
                onRemove={onRemove}
                onClose={() => setPickerOpen(false)}
              />
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  );
}
