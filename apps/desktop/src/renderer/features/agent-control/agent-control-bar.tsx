import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { CircleStop } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import { Button } from "@/renderer/shared/ui/primitives/button";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { Kbd } from "@/renderer/shared/ui/primitives/kbd";
import { Toolbar } from "@/renderer/shared/ui/primitives/toolbar";

export interface AgentControlBarProps {
  /** `strip` is the picture-in-picture hover toolbar; `pill` floats at the
   * bottom center of whatever the agent is controlling. */
  variant: "strip" | "pill";
  /** The page on the strip, the agent on the pill. */
  title: string;
  /** What the agent is doing right now. The strip has no room for it. */
  detail?: string;
  leading?: ReactNode;
  /** Hidden bars fade out and stop taking the pointer. */
  visible?: boolean;
  stopLabel: string;
  stopping?: boolean;
  onStop: () => void;
  /** Esc stops the agent too while its page or this bar has focus. */
  escapeHint?: boolean;
  /** Actions after Stop, such as the picture-in-picture Hide and Restore. */
  actions?: ReactNode;
  className?: string;
  style?: CSSProperties;
  "data-testid"?: string;
}

const FADE =
  "transition-opacity duration-120 ease-out motion-reduce:transition-none";

/** Shows which agent is in control and lets the user take it back. Stop ends
 * only the agent's control, never the whole turn. */
export function AgentControlBar({
  variant,
  title,
  detail,
  leading,
  visible = true,
  stopLabel,
  stopping = false,
  onStop,
  escapeHint = false,
  actions,
  className,
  style,
  "data-testid": testId,
}: AgentControlBarProps) {
  const visibility = visible ? "opacity-100" : "pointer-events-none opacity-0";
  const stop = (event: MouseEvent) => {
    // The strip sits over a surface that restores the Browser column on click.
    event.stopPropagation();
    if (!stopping) onStop();
  };
  if (variant === "strip") {
    return (
      <div
        className={cn(
          "border-border1 bg-bg1/95 flex h-7 items-center gap-1.5 border-b px-2 text-left backdrop-blur-sm",
          FADE,
          visibility,
          className,
        )}
        style={style}
        data-testid={testId}
      >
        {leading}
        <span
          className="text-fg1 text-2xxs min-w-0 flex-1 truncate text-left"
          title={title}
        >
          {title}
        </span>
        <IconButton
          type="button"
          motion="none"
          className="pointer-events-auto"
          disabled={stopping}
          onClick={stop}
          label={stopLabel}
          {...(escapeHint ? { "aria-keyshortcuts": "Escape" } : {})}
        >
          <CircleStop className="size-3" aria-hidden="true" />
        </IconButton>
        {actions}
      </div>
    );
  }
  return (
    <Toolbar
      aria-label={`${title} control`}
      className={cn(
        "w-max max-w-full gap-1.5 pl-2 shadow-[var(--shadow-dropdown)]",
        FADE,
        visibility,
        className,
      )}
      style={style}
      data-testid={testId}
    >
      {leading}
      <span className="text-fg1 shrink-0 text-xs font-medium">{title}</span>
      {detail ? (
        <span className="text-fg3 min-w-0 truncate text-xs" title={detail}>
          {detail}
        </span>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        size="compact"
        className="ml-1 shrink-0"
        disabled={stopping}
        onClick={stop}
        aria-label={stopLabel}
        {...(escapeHint ? { "aria-keyshortcuts": "Escape" } : {})}
      >
        <CircleStop aria-hidden="true" />
        Stop
      </Button>
      {escapeHint ? (
        <Kbd aria-hidden="true" className="mr-1">
          esc
        </Kbd>
      ) : null}
    </Toolbar>
  );
}
