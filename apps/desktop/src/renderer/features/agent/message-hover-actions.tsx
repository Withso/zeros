import { useCallback, useState } from "react";
import { Check, Copy, MessageSquarePlus, Pencil } from "lucide-react";
import { cn } from "@/renderer/shared/ui/cn";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { Toolbar, ToolbarText } from "@/renderer/shared/ui/primitives/toolbar";

/** Clock time for the popup: "11:30 AM" today, "Nov 21, 11:30 AM" earlier. */
export function formatMessageTime(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const date = new Date(ts);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

export interface MessageHoverActionsProps {
  text: string;
  createdAt?: number;
  /** "Sent" for the user's message, "Received" for the agent's. */
  timeLabel: "Sent" | "Received";
  onEdit?: () => void;
  onSideChat?: () => void;
  /** Pointer or focus intent on Side chat warms its transcript. */
  onSideChatIntent?: () => void;
  /** Complete hover/focus visibility classes for the owning group. */
  revealClassName: string;
}

/** The floating bar above a message: time, copy, edit and Side chat. It takes
 *  pointer events only while revealed, so the hidden bar never intercepts
 *  clicks; its bottom padding bridges the gap to the message for the pointer. */
export function MessageHoverActions({
  text,
  createdAt,
  timeLabel,
  onEdit,
  onSideChat,
  onSideChatIntent,
  revealClassName,
}: MessageHoverActionsProps) {
  const [copied, setCopied] = useState(false);
  const time = typeof createdAt === "number" ? formatMessageTime(createdAt) : "";

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text.trimEnd());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked under some sandbox configs */
    }
  }, [text]);

  return (
    <div
      data-message-hover-actions=""
      className={cn(
        "pointer-events-none absolute right-0 bottom-full z-2 pb-1 opacity-0 transition-opacity duration-150 ease-out",
        revealClassName,
      )}
    >
      <Toolbar aria-label="Message actions">
        {time && (
          <Tooltip label={`${timeLabel} ${new Date(createdAt!).toLocaleString()}`}>
            <ToolbarText className="text-muted-fg tabular-nums select-none">{time}</ToolbarText>
          </Tooltip>
        )}
        <Tooltip label={copied ? "Copied" : "Copy message"}>
          <IconButton onClick={copy} label={copied ? "Copied" : "Copy message"}>
            {copied ? <Check strokeWidth={2} /> : <Copy strokeWidth={2} />}
          </IconButton>
        </Tooltip>
        {onEdit && (
          <Tooltip label="Edit message">
            <IconButton onClick={onEdit} label="Edit message">
              <Pencil strokeWidth={2} />
            </IconButton>
          </Tooltip>
        )}
        {onSideChat && (
          <Tooltip label="Side chat from here">
            <IconButton
              onClick={onSideChat}
              onPointerEnter={onSideChatIntent}
              onFocus={onSideChatIntent}
              label="Side chat from here"
            >
              <MessageSquarePlus strokeWidth={2} />
            </IconButton>
          </Tooltip>
        )}
      </Toolbar>
    </div>
  );
}
