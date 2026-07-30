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
// It also absorbs the prefetch. Rule 11 forbids a click handler that awaits
// I/O, and this panel needs exactly the bytes the click needs — so opening it
// warms the shared cache and the click resolves from memory. One mechanism,
// and its cost is now justified by something the user can see.
//
// There is deliberately NO footer: no "click to attach", no render-cap
// disclosure, no teach line. A header of three facts and the file.

// --- IMPORTS ---
import { useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon } from "./agent-icon";
import { loadTranscriptSnapshot } from "./chat-transcript-attach";
import { formatCompactAge } from "./format-age";
import { ScrollArea } from "@/zeros/ui/primitives";
import type { TranscriptMode } from "./transcript-format";

// --- CONSTANTS ---
/** Lines rendered into the panel's DOM. See TranscriptPreviewShell. */
const PREVIEW_LINE_CAP = 400;

// --- TYPES ---
export interface TranscriptPreviewCardProps {
  /** Source chat. */
  chatId: string;
  /** Agent that authored it — the mark and the name in the header row. */
  agentId: string | null;
  agentName: string | null;
  /** Persisted transcript rows. Same number the pill shows. */
  messageCount: number;
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
  messageCount,
  lastMessageAt,
  body,
}: {
  agentId: string | null;
  agentName: string | null;
  messageCount: number;
  lastMessageAt: number;
  /** Null while a read is in flight — the header stands alone, no skeleton. */
  body: string | null;
}) {
  // The panel shows ~20 lines and the formatter's document cap is 2,000,000
  // chars, so rendering line-per-div uncapped mounts up to ~40,000 nodes in
  // one synchronous commit — a multi-second freeze on a gesture the user
  // hasn't committed to, directly above the composer. 400 is ~20 screens of
  // scroll: past any reasonable peek, nowhere near a stall.
  const { lines, clipped } = useMemo(() => {
    if (body === null) return { lines: [] as string[], clipped: false };
    const all = body.split("\n");
    return {
      lines: all.slice(0, PREVIEW_LINE_CAP),
      clipped: all.length > PREVIEW_LINE_CAP,
    };
  }, [body]);

  return (
    <div className="flex max-h-[19rem] w-full flex-col">
      {/* Header — exactly three facts, and they are free: all three come from
          the summary row already in hand, so this paints on the same frame the
          panel opens and the body follows in one step. No skeleton (AGENTS.md:
          never animate over a waterfall). */}
      <div className="border-border1 text-fg2 flex shrink-0 items-center gap-1.5 border-b px-3 py-2 text-xs">
        <AgentIcon agentId={agentId} iconUrl={null} size={13} />
        <span className="text-fg1 font-semibold">{agentName ?? "Agent"}</span>
        <span className="text-fg3">·</span>
        <span>
          {messageCount} {messageCount === 1 ? "message" : "messages"}
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
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-3 py-2.5">
          {lines.map((line, i) => (
            <PreviewLine key={i} line={line} />
          ))}
          {/* The clip is disclosed INLINE, in the transcript's own voice —
              the same way formatTranscript already marks every other elision.
              A panel that quietly showed a fraction of the file would be the
              one lie this whole surface exists to prevent, and there is
              deliberately no footer to put it in. */}
          {clipped && (
            <div className="text-fg3 mt-3 text-xs italic">
              …{PREVIEW_LINE_CAP.toLocaleString()} lines shown — the attachment
              carries the whole transcript.
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/** The row pill's preview — reads through the shared cache, which is also what
 *  makes the subsequent click resolve from memory. */
export function TranscriptPreviewCard({
  chatId,
  agentId,
  agentName,
  messageCount,
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
      messageCount={messageCount}
      lastMessageAt={lastMessageAt}
      body={body}
    />
  );
}
