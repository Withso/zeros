// ============================================
// COMPONENT: TranscriptPreviewCard
// PURPOSE: Show a chat's transcript on hover — the file itself, not a
//          tooltip describing it.
// USED IN: chat-transcript-pills.tsx (the row) and composer-editor/pills.tsx
//          (the staged chip).
// ============================================
//
// Every other honesty device considered here was a DESCRIPTION of the
// attachment — a byte count, a running total against the model budget, a
// tooltip listing what got elided. All of them are proxies, all of them can
// disagree with the file, and each one wanted a permanent seat in the row.
// Showing the transcript is strictly better information at strictly less cost,
// because it is on hover: the row pays nothing for it.
//
// It also absorbs the prefetch. The click handler must not await
// I/O, and this panel needs exactly the bytes the click needs — so opening it
// warms the shared cache and the click resolves from memory. One mechanism,
// and its cost is now justified by something the user can see.
//
// There is deliberately NO footer: no "click to attach", no render-cap
// disclosure, no teach line. A header of three facts and the file — the WHOLE
// file. It scrolls to the end, so there is no
// longer a truncation to disclose.

// --- IMPORTS ---
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from "react";

import { AgentIcon } from "./agent-icon";
import { loadTranscriptSnapshot } from "./chat-transcript-attach";
import { formatCompactAge } from "./format-age";
import type { TranscriptMode } from "./transcript-format";

// --- CONSTANTS ---
/** Lines mounted per step — one on open, one more each time the reader
 *  approaches the end. See TranscriptPreviewShell. */
const PREVIEW_LINE_STEP = 400;

/** How close to the bottom counts as "about to run out", in px. Roughly one
 *  panel-height of runway, so the next step is mounted before the reader can
 *  reach the seam. */
const PREVIEW_GROW_MARGIN = 400;

/** Mount more lines if the reader is within PREVIEW_GROW_MARGIN of the end.
 *
 *  Pure so the one arithmetic decision in this file is pinned by a test rather
 *  than by reading a scroll handler. `scrollHeight - scrollTop - clientHeight`
 *  is the distance still below the viewport; it goes NEGATIVE on a trackpad
 *  bounce, which must still read as "at the end".
 *
 *  Growth is geometric in the middle and FLAT at both ends — half of what is
 *  already mounted, floored at one step and capped at five.
 *
 *  The floor: a peek must never mount more than one step, and every realistic
 *  transcript lives in the first two or three (400 / 800 / 1,200), where this
 *  is exactly a flat step.
 *
 *  The acceleration: the formatter's document cap is 2,000,000 chars, so a very
 *  long full transcript is ~40,000 lines, and a flat 400 would ask for a
 *  hundred scroll-to-the-end gestures to reach the end of it. "You can see the
 *  whole thing" has to be true in the hand, not just in principle.
 *
 *  The ceiling is the part that is easy to leave out and shouldn't be. Uncapped
 *  half-again growth re-creates the exact stall the step exists to prevent,
 *  just deferred: the 20,500 → 30,750 step would mount ten thousand divs in one
 *  synchronous commit, inside a hover panel sitting over the composer. Capped,
 *  no single commit is ever more than 2,000 nodes, and the worst case is still
 *  ~20 gestures rather than ~100. */
export function nextPreviewLimit(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  limit: number,
  total: number,
  step = PREVIEW_LINE_STEP,
): number {
  if (limit >= total) return limit;
  const below = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  if (below > PREVIEW_GROW_MARGIN) return limit;
  const grow = Math.min(step * 5, Math.max(step, Math.ceil(limit / 2)));
  return Math.min(total, limit + grow);
}

// --- TYPES ---
export interface TranscriptPreviewCardProps {
  /** Source chat. */
  chatId: string;
  /** Agent that authored it — the mark and the name in the header row. */
  agentId: string | null;
  agentName: string | null;
  /** Prompts the user sent. Same number the pill shows. */
  userMessageCount: number;
  /** Epoch ms of the newest message; 0 when unknown (then the line is
   *  omitted rather than rendered as 1970). */
  lastMessageAt: number;
  /** Which body to render — the one a click would attach, or for the staged
   *  chip, the one actually in the file. */
  mode: TranscriptMode;
  /** Passed to the formatter so the header and relative paths match the
   *  attachment byte for byte. */
  title: string;
  folder: string;
}

// --- WORKFLOWS ---
/** Read + format through the shared cache. Returns null while in flight and
 *  on failure alike: a preview is an affordance, not an operation, so a failed
 *  read shows the header it already has rather than an error the user did not
 *  ask for. The click path surfaces read failures — that one IS an operation. */
function useTranscriptBody(
  chatId: string,
  mode: TranscriptMode,
  lastMessageAt: number,
  title: string,
  folder: string,
): string | null {
  const [body, setBody] = useState<string | null>(null);
  // The revision this panel is showing, FROZEN at open.
  //
  // `lastMessageAt` advances every ~400ms while the source chat streams (the
  // summaries hook re-pulls on DB_CHANGED), and it is part of the cache key.
  // Depending on it directly meant an open panel over a streaming chat blanked
  // to header-only and re-issued a full engine page walk two or three times a
  // second, with the walks overlapping because each new revision evicts the
  // one before it. A preview is a look at the transcript as it was when you
  // opened it — the panel unmounts on pointer-leave, so the next hover is a
  // fresh look at a fresh revision, which is the honest behaviour anyway.
  const frozen = useRef(lastMessageAt);

  useEffect(() => {
    let cancelled = false;
    setBody(null);
    void loadTranscriptSnapshot({
      chatId,
      mode,
      lastMessageAt: frozen.current,
      meta: { title, folder },
    })
      .then((snap) => {
        if (!cancelled) setBody(snap.text);
      })
      .catch(() => {
        /* header stands alone */
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, mode, title, folder]);

  return body;
}

// --- RENDER ---
/** One `## Heading` / body line of the transcript.
 *
 *  Deliberately NOT the chat's Markdown renderer: this is a peek, and mounting
 *  the full pipeline (syntax highlighting, mermaid, link handling) on pointer
 *  intent is how a preview becomes a performance bug. Role headings get `fg1`
 *  so the turn structure is scannable; everything else is body text. */
function PreviewLine({ line }: { line: string }) {
  if (line.startsWith("## ")) {
    return (
      <div className="text-fg1 mt-3 text-xs font-semibold first:mt-0">
        {line.slice(3)}
      </div>
    );
  }
  if (line.startsWith("# ")) {
    return (
      <div className="text-fg1 mt-3 text-xs font-semibold first:mt-0">
        {line.slice(2)}
      </div>
    );
  }
  if (!line.trim()) return <div className="h-2" />;
  return <div className="text-fg2 text-xs leading-snug">{line}</div>;
}

/** The panel itself. Split from the reading wrapper because the two callers
 *  get their body from different places: the row's pill reads through the
 *  cache (and that read IS the click's warm-up), while the composer chip
 *  already HOLDS the file — re-reading for it would be both wasteful and
 *  wrong, since the chip is a snapshot and the source may have moved on. */
export function TranscriptPreviewShell({
  agentId,
  agentName,
  userMessageCount,
  lastMessageAt,
  body,
}: {
  agentId: string | null;
  agentName: string | null;
  userMessageCount: number;
  lastMessageAt: number;
  /** Null while a read is in flight — the header stands alone, no skeleton. */
  body: string | null;
}) {
  const all = useMemo(() => (body === null ? [] : body.split("\n")), [body]);

  // How much of `all` is mounted. It GROWS as the reader scrolls, so the whole
  // transcript is reachable — the panel withholds nothing, it just doesn't
  // build it all up front.
  //
  // The cap used to be a hard 400 lines with an inline "…400 lines shown"
  // marker, because the formatter's document cap is 2,000,000 chars and
  // line-per-div uncapped mounts ~40,000 nodes in one synchronous commit — a
  // multi-second freeze on a gesture the user hasn't committed to, directly
  // above the composer. Paying that cost one screen at a time keeps the open
  // exactly as cheap as it was and removes the ceiling, which is the same
  // trade the transcript itself makes: agent-chat.tsx pages older history in
  // on scroll with no affordance because scrolling back should show everything.
  //
  // The grown limit is stored WITH the body it was grown for, and reset during
  // render rather than in an effect. A new body is a new document and must
  // start at one step again — but an effect only fires after commit, so the
  // render that first sees the new body would mount it at the OLD limit and
  // then re-render. That is invisible on the pill (its body always passes
  // through null while the read is in flight) and real on the composer chip,
  // whose body swaps text→text when a chip is re-attached in place: 2,700
  // lines of the new transcript mounted and thrown away.
  const [grown, setGrown] = useState<{ body: string | null; limit: number }>({
    body,
    limit: PREVIEW_LINE_STEP,
  });
  const limit = grown.body === body ? grown.limit : PREVIEW_LINE_STEP;

  const lines = useMemo(() => all.slice(0, limit), [all, limit]);

  const onScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
      const next = nextPreviewLimit(
        { scrollTop, scrollHeight, clientHeight },
        limit,
        all.length,
      );
      // Every scroll event on a fully-mounted transcript lands here, so the
      // guard is what keeps reading a short transcript free.
      if (next !== limit) setGrown({ body, limit: next });
    },
    [body, limit, all.length],
  );

  return (
    <div className="flex max-h-[19rem] w-full flex-col">
      {/* Header — exactly three facts, and they are free: all three come from
          the summary row already in hand, so this paints on the same frame the
          panel opens and the body follows in one step. No skeleton (AGENTS.md:
          never animate over a waterfall). */}
      {/* The rule is `border2`, not the `border1` default: this panel is a
          bg2 popover surface, and border1 is the divider for bg1. On bg2 it
          was invisible, so the header and the transcript ran together as one
          block — see zeros-tokens.css, "border2: … bg2 surfaces, popover
          panels". It now matches the card's own outer border. */}
      <div className="border-border2 text-fg2 flex shrink-0 items-center gap-1.5 border-b px-3 py-2 text-xs">
        <AgentIcon agentId={agentId} iconUrl={null} size={13} />
        <span className="text-fg1 font-semibold">{agentName ?? "Agent"}</span>
        <span className="text-fg3">·</span>
        {/* "prompts", not "messages". The number counts what the USER sent,
            and the word has to say so — "2 messages" over a chat showing four
            bubbles is the same ambiguity that made the old row-count reading
            of this line indefensible. One word, and it answers "how many times
            did I ask this agent something". */}
        <span>
          {userMessageCount} {userMessageCount === 1 ? "prompt" : "prompts"}
        </span>
        {/* The only time signal in the whole feature. It is here and nowhere
            else because here the user has already narrowed to one chat, so it
            informs instead of competing with five other timestamps. Compact
            form ("2h ago") to match the app's own vocabulary. */}
        {lastMessageAt > 0 && (
          <>
            <span className="text-fg3">·</span>
            <span className="truncate">
              Last active {formatCompactAge(lastMessageAt)} ago
            </span>
          </>
        )}
      </div>
      {/* NATIVE overflow on the flex item itself — deliberately not
          <ScrollArea>, which is what shipped here and could not scroll at all.
          Radix makes its Viewport the scroller and that Viewport carries
          `h-full`; its containing block is the ScrollArea root, sized by
          `flex-1` inside a column that has a max-height and no height. A
          max-height does not make a box definite for percentage resolution, so
          `height:100%` fell back to `auto` and the viewport grew to its full
          6,870px content — overflow:scroll with nothing to scroll, clipped by
          the root's overflow-hidden. The wheel did nothing and the thumb never
          appeared (Radix mounts it on offsetHeight < scrollHeight, which was
          false).

          Scrolling the flex item itself needs no percentage height, so the cap
          stays in ONE place and short transcripts still shrink-wrap. It is
          also what the two popper surfaces in this app that already scroll do
          — checkpoint-rail.tsx's hover card and the command palette's list.

          overscroll-contain so hitting the end doesn't hand the wheel to the
          chat transcript behind the panel. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={onScroll}
      >
        <div className="px-3 py-2.5">
          {lines.map((line, i) => (
            <PreviewLine key={i} line={line} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The row pill's preview — reads through the shared cache, which is also what
 *  makes the subsequent click resolve from memory. */
export function TranscriptPreviewCard({
  chatId,
  agentId,
  agentName,
  userMessageCount,
  lastMessageAt,
  mode,
  title,
  folder,
}: TranscriptPreviewCardProps) {
  const body = useTranscriptBody(chatId, mode, lastMessageAt, title, folder);
  return (
    <TranscriptPreviewShell
      agentId={agentId}
      agentName={agentName}
      userMessageCount={userMessageCount}
      lastMessageAt={lastMessageAt}
      body={body}
    />
  );
}
