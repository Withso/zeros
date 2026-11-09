// ──────────────────────────────────────────────────────────
// Jump to latest — the floating return-to-tail affordance
// ──────────────────────────────────────────────────────────
//
// An icon-only button above the composer. It lives in the non-scrolling
// chrome (the relative wrapper around the composer), so it stays put as the
// reader scrolls, and fades in via the ocAgentJumpPillIn keyframe in
// styles/global/animations.css.
// ──────────────────────────────────────────────────────────

import React, { memo } from "react";
import { ArrowDown } from "lucide-react";

import { Tooltip } from "@/renderer/shared/ui/primitives";

interface JumpToLatestButtonProps {
  isAtBottom: boolean;
  jumpToBottom: (smooth?: boolean) => void;
}

/** Icon-only button. Mount inside the `relative` wrapper just above the
 *  composer so `absolute bottom-full mb-2` puts it 8px above the composer,
 *  centered on the composer column even when a docked summary island pads
 *  that wrapper (--chat-aside-inset). */
export const JumpToLatestButton = memo(function JumpToLatestButton({
  isAtBottom,
  jumpToBottom,
}: JumpToLatestButtonProps) {
  if (isAtBottom) return null;
  return (
    <Tooltip label="Latest message">
      <button
        type="button"
        className="zeros-agent-jump-pill zeros-agent-jump-pill-bottom border-border1 bg-bg2 text-fg1 hover:bg-bg2-hover absolute bottom-full left-[calc((100%-var(--chat-aside-inset,0px))/2)] z-10 mb-2 inline-flex size-9 -translate-x-1/2 [animation:ocAgentJumpPillIn_140ms_ease-out] cursor-pointer items-center justify-center rounded-sm border transition-colors"
        onClick={() => jumpToBottom(true)}
        aria-label="Jump to latest"
      >
        <ArrowDown className="size-4" />
      </button>
    </Tooltip>
  );
});
