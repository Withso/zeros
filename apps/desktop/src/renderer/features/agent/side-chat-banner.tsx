import { useLayoutEffect, useRef, useState } from "react";
import { GitFork } from "lucide-react";
import { useWorkspaceStore } from "../../state/store";
import type { SideChatSeed } from "./side-chat-seeds";

/** The first character index on the quote's second line, found by binary
 *  search over each character's top edge; null when it all fits on one line. */
export function firstLineEnd(length: number, topOf: (index: number) => number): number | null {
  if (length === 0) return null;
  const first = topOf(0);
  if (topOf(length - 1) <= first) return null;
  let low = 1;
  let high = length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (topOf(mid) > first) high = mid;
    else low = mid + 1;
  }
  return low;
}

/** Where the quote wraps at the banner's width. Measured with a Range over the
 *  full-width text, again whenever the width changes, and only while the chat
 *  is on screen: a retained hidden chat neither measures nor observes. */
function useQuoteBreak(text: string, active: boolean) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [cut, setCut] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const node = ref.current;
    const textNode = node?.firstChild;
    if (!node || !textNode || textNode.nodeType !== Node.TEXT_NODE || typeof document.createRange !== "function") return;
    const range = document.createRange();
    // Without layout (tests, very old engines) the quote keeps its clamp.
    if (typeof range.getClientRects !== "function") return;
    const measure = () => {
      const topOf = (index: number) => {
        range.setStart(textNode, index);
        range.setEnd(textNode, index + 1);
        return range.getClientRects()[0]?.top ?? 0;
      };
      setCut(firstLineEnd(text.length, topOf));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let width = node.getBoundingClientRect().width;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.width ?? 0;
      if (next > 0 && next !== width) {
        width = next;
        measure();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, active]);
  return { ref, cut };
}

/** The top of a side chat's transcript: a fork tile, "Branched from" and the
 *  source chat's name, then at most two lines of the branched-from message on
 *  a blue rule, the second line stopping at half width. It is the
 *  transcript's first item, so it scrolls away with it. */
export function SideChatBranchBanner({ seed, active = true }: { seed: SideChatSeed; active?: boolean }) {
  const liveTitle = useWorkspaceStore((state) => state.chats.find((chat) => chat.id === seed.sourceChatId)?.title);
  const name = liveTitle?.trim() || seed.sourceTitle || "a chat";
  const quote = seed.quote.replace(/\s+/g, " ").trim();
  const { ref, cut } = useQuoteBreak(quote, active);
  return (
    <div data-side-chat-banner="" className="flex w-full max-w-(--chat-lane) min-w-0 items-start gap-3 self-center">
      <span
        aria-hidden="true"
        data-side-chat-fork=""
        className="border-border1 bg-bg2 text-fg1 inline-flex size-7 shrink-0 items-center justify-center rounded-lg border"
      >
        <GitFork className="size-3.5" strokeWidth={1.5} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
        <p className="text-fg3 truncate text-xs leading-4.5" data-side-chat-source="">
          Branched from <span className="text-fg1 font-medium">{name}</span>
        </p>
        {quote && (
          <blockquote className="border-accent text-fg2 relative min-w-0 border-l-2 pl-2.5 text-xs leading-4.5">
            {/* The measured copy keeps the full text for the Range; it stays
                invisible and out of the accessibility tree once split. */}
            <span
              ref={ref}
              aria-hidden={cut !== null ? "true" : undefined}
              className={cut !== null ? "pointer-events-none invisible absolute inset-x-0 top-0 pl-2.5" : "line-clamp-2"}
            >
              {quote}
            </span>
            {cut !== null && (
              <>
                <span className="block truncate">{quote.slice(0, cut)}</span>
                <span className="block w-1/2 truncate">{quote.slice(cut).trimStart()}</span>
              </>
            )}
          </blockquote>
        )}
      </div>
    </div>
  );
}
