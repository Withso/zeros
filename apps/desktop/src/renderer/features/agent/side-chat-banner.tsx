import { GitBranch } from "lucide-react";
import type { SideChatSeed } from "./side-chat";

export function SideChatBranchBanner({ seed }: { seed: SideChatSeed }) {
  return (
    <div data-side-chat-banner="" className="flex w-full max-w-(--chat-lane) min-w-0 flex-col gap-1.5 self-center">
      <p className="text-fg3 flex items-center gap-1.5 text-xs leading-4.5">
        <GitBranch className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
        <span className="min-w-0 truncate">
          Branched from {seed.role === "user" ? "your message" : "message"}
          {seed.sourceTitle ? ` in ${seed.sourceTitle}` : ""}
        </span>
      </p>
      <blockquote className="border-border3 text-fg2 line-clamp-4 border-l-2 pl-2 text-xs leading-4.5 whitespace-pre-wrap wrap-anywhere">
        {seed.quote}
      </blockquote>
    </div>
  );
}
