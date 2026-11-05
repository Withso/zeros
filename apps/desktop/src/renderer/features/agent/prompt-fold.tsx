// A sent message's fold, inside TurnPromptHeader's bubble. A long message
// stops at five lines that dissolve above Show more; unfolded, it shows up to
// fifteen and scrolls inside, fading only the edges its text runs past, above
// Show less. A message folding would not shorten renders as it is.

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { cn } from "@/renderer/shared/ui/cn";
import { Button } from "@/renderer/shared/ui/primitives/button";

/** The text a folded message keeps: five 20px lines. */
export const PROMPT_FOLD_COLLAPSED_PX = 100;
/** The most an unfolded message shows before it scrolls: fifteen lines. */
export const PROMPT_FOLD_EXPANDED_PX = 300;
/** The toggle's row: a 4px gap and the 24px compact Ghost button. */
export const PROMPT_FOLD_TOGGLE_ROW_PX = 28;

// The box reaches 4px past the text on every side (-m-1 p-1), so focus rings
// on pills at its edges stay inside its clip and mask; its heights add those
// 8px. Folded it clips rather than hides: not being a scroll container, it
// cannot be scrolled by a selection drag. Unfolded, the wheel passes to the
// transcript at the message's end.
export const PROMPT_FOLD_COLLAPSED_CLS =
  "max-h-[108px] overflow-clip mask-b-from-[calc(100%-2rem)]";
export const PROMPT_FOLD_EXPANDED_CLS =
  "max-h-[308px] overflow-y-auto [scrollbar-width:thin] data-more-above:mask-t-from-[calc(100%-2rem)] data-more-below:mask-b-from-[calc(100%-2rem)]";

/** Whether a message of this natural height folds: only when the folded view
 *  and its toggle are shorter, so Show more never reveals a lone line. */
export function promptFolds(height: number): boolean {
  return height > PROMPT_FOLD_COLLAPSED_PX + PROMPT_FOLD_TOGGLE_ROW_PX;
}

export function PromptFold({
  children,
  surfaceActive = true,
}: {
  children: React.ReactNode;
  /** False while the chat is a hidden retained layer: the fold neither
   *  measures nor stays unfolded there. */
  surfaceActive?: boolean;
}) {
  const id = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [folds, setFolds] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [edges, setEdges] = useState({ above: false, below: false });
  const unfolded = folds && expanded;
  const unfoldedRef = useRef(false);
  const revealToggle = useRef(false);

  const syncEdges = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const above = viewport.scrollTop > 0.5;
    const below = viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 0.5;
    setEdges((prev) => (prev.above === above && prev.below === below ? prev : { above, below }));
  }, []);

  // The text's natural height decides the fold. The first observation lands
  // after layout and before paint, and flushSync commits the fold within it,
  // so a long message never paints unfolded first. Observing nothing while
  // hidden also means a turn skipped by content-visibility is measured only
  // once it renders, and no hidden layer's 0px reading unfolds a message.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!surfaceActive || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.borderBoxSize?.[0]?.blockSize ?? entry?.contentRect.height ?? 0;
      if (!height) return;
      const next = promptFolds(height);
      flushSync(() => {
        setFolds(next);
        if (!next) setExpanded(false);
        if (next && unfoldedRef.current) syncEdges();
      });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [surfaceActive, syncEdges]);

  useEffect(() => {
    if (!surfaceActive) setExpanded(false);
  }, [surfaceActive]);

  useLayoutEffect(() => {
    unfoldedRef.current = unfolded;
    if (unfolded) syncEdges();
    // The toggle someone used stays in view as the message grows or shrinks.
    if (revealToggle.current) {
      revealToggle.current = false;
      toggleRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [unfolded, syncEdges]);

  const toggle = useCallback(() => {
    // Folding back starts the message from its top again.
    if (expanded && viewportRef.current) viewportRef.current.scrollTop = 0;
    revealToggle.current = true;
    setExpanded(!expanded);
  }, [expanded]);

  return (
    <>
      <div
        ref={viewportRef}
        id={id}
        data-prompt-fold={folds ? (expanded ? "expanded" : "collapsed") : undefined}
        data-more-above={unfolded && edges.above ? "" : undefined}
        data-more-below={unfolded && edges.below ? "" : undefined}
        onScroll={unfolded ? syncEdges : undefined}
        className={cn("-m-1 p-1", folds && (expanded ? PROMPT_FOLD_EXPANDED_CLS : PROMPT_FOLD_COLLAPSED_CLS))}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {folds && (
        // fg2 at rest like a MessageRow's actions, with the Ghost hover;
        // -ml-1.5 lines the label up with the message text.
        <div className="text-fg2 mt-1 -ml-1.5 flex">
          <Button
            ref={toggleRef}
            data-prompt-fold-toggle=""
            variant="ghost"
            size="compact"
            aria-expanded={expanded}
            aria-controls={id}
            onClick={toggle}
          >
            {expanded ? "Show less" : "Show more"}
          </Button>
        </div>
      )}
    </>
  );
}
