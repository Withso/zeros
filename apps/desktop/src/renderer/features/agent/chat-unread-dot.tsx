import { cn } from "../../shared/ui/cn";

/** An agent finished while nobody was looking (chat-unread.ts). The dot fills
 *  the slot its surface gives it (a chat tab's agent logo, a workspace row's
 *  mark) in --brown-fg. Decorative: tabs and rows name the state in their own
 *  accessible label. */
export function ChatUnreadDot({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center",
        className,
      )}
      aria-hidden="true"
      data-chat-unread=""
    >
      <span className="bg-brown-fg size-1.5 rounded-full" />
    </span>
  );
}
