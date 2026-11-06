// ──────────────────────────────────────────────────────────
// JumpPills — floating "jump to ..." affordances
// ──────────────────────────────────────────────────────────
//
// 01o: split into two components so they can be mounted in
// different DOM contexts:
//
//   JumpToPromptPill — top-right inside the Conversation (the
//     scroll container). Shows when the active turn's user
//     prompt has scrolled above the viewport.
//
//   JumpToLatestButton — icon-only circle above the composer.
//     Lives in the non-scrolling chrome (relative wrapper around
//     the composer), so it stays put as the user scrolls.
//
// Both fade in/out via the ocAgentJumpPillIn keyframe in
// styles/global/animations.css.
// ──────────────────────────────────────────────────────────

import React, { memo, useEffect, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";

import { Tooltip } from "@/renderer/shared/ui/primitives";

import { beginChatScrollNavigation } from "./chat-scroll-navigation";

interface JumpToPromptPillProps {
  scrollEl: HTMLElement | null;
  /** Element to jump to. Typically the active turn's user-prompt DOM
   *  node. null when there is no active prompt. */
  promptEl: HTMLElement | null;
}

/** What of the prompt shows on screen: a folded prompt's bubble clips its
 *  text, so the text's own box runs on below the bubble. */
function visiblePrompt(promptEl: HTMLElement): HTMLElement {
  return promptEl.closest<HTMLElement>("[data-user-bubble]") ?? promptEl;
}

export const JumpToPromptPill = memo(function JumpToPromptPill({
  scrollEl,
  promptEl,
}: JumpToPromptPillProps) {
  const [promptAbove, setPromptAbove] = useState(false);

  useEffect(() => {
    if (!scrollEl || !promptEl) {
      setPromptAbove(false);
      return;
    }
    const shown = visiblePrompt(promptEl);
    const update = () => {
      const containerTop = scrollEl.getBoundingClientRect().top;
      const promptBottom = shown.getBoundingClientRect().bottom;
      setPromptAbove(promptBottom < containerTop);
    };
    update();
    scrollEl.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(scrollEl);
    ro.observe(promptEl);
    // Folding and unfolding resize the bubble, not the text.
    if (shown !== promptEl) ro.observe(shown);
    return () => {
      scrollEl.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [scrollEl, promptEl]);

  const jumpToPrompt = () => {
    if (!scrollEl || !promptEl) return;
    const containerTop = scrollEl.getBoundingClientRect().top;
    const promptTop = promptEl.getBoundingClientRect().top;
    const target = scrollEl.scrollTop + (promptTop - containerTop);
    if (Math.abs(target - scrollEl.scrollTop) < 4) return;
    beginChatScrollNavigation(scrollEl, { target });
    scrollEl.scrollTo({ top: target, behavior: "smooth" });
  };

  if (!promptAbove) return null;
  return (
    <Tooltip label="Your prompt">
      <button
        type="button"
        // The 24px control pill; its wrapper in agent-chat pins it to the
        // column outside the scroller, above the top fade.
        className="zeros-agent-jump-pill zeros-agent-jump-pill-top border-border2 bg-bg2 text-fg1 hover:border-border3 hover:bg-bg2-highlight pointer-events-auto inline-flex h-6 [animation:ocAgentJumpPillIn_140ms_ease-out] cursor-pointer items-center gap-1 rounded-md border px-2 text-xs leading-4.5"
        onClick={jumpToPrompt}
        aria-label="Jump to your prompt"
      >
        <ArrowUp className="size-3.5" />
        <span>Jump to your prompt</span>
      </button>
    </Tooltip>
  );
});

interface JumpToLatestButtonProps {
  isAtBottom: boolean;
  jumpToBottom: (smooth?: boolean) => void;
}

/** Icon-only circle button. Mount inside a `relative` wrapper just
 *  above the composer so `absolute bottom-full mb-2 left-1/2` puts
 *  it directly above the composer with an 8px gap. */
export const JumpToLatestButton = memo(function JumpToLatestButton({
  isAtBottom,
  jumpToBottom,
}: JumpToLatestButtonProps) {
  if (isAtBottom) return null;
  return (
    <Tooltip label="Latest message">
      <button
        type="button"
        className="zeros-agent-jump-pill zeros-agent-jump-pill-bottom border-border1 bg-bg2 text-fg1 hover:bg-bg2-hover absolute bottom-full left-1/2 z-10 mb-2 inline-flex size-9 -translate-x-1/2 [animation:ocAgentJumpPillIn_140ms_ease-out] cursor-pointer items-center justify-center rounded-sm border transition-colors"
        onClick={() => jumpToBottom(true)}
        aria-label="Jump to latest"
      >
        <ArrowDown className="size-4" />
      </button>
    </Tooltip>
  );
});
