import type { ReactNode } from "react";

import { Button } from "@/renderer/shared/ui/primitives/button";
import { cn } from "@/renderer/shared/ui/cn";

/** 22px: the composer's 18px corners stay concentric across the tray's 4px inset. */
export const COMPOSER_TRAY_RADIUS = "rounded-[calc(var(--radius-lg)*2.75)]";

/**
 * A composer that cannot act yet, or has something to say, sits inside a
 * slightly larger sidebar-bg tray with one status line beneath it and at most
 * one action. With no message the composer renders alone, so nothing moves
 * above it and nothing is drawn between the context row and the card.
 */
export function ComposerTray({
  message,
  action,
  children,
}: {
  message: ReactNode | null;
  action?: { label: string; onClick: () => void; onIntent?: () => void } | null;
  children?: ReactNode;
}) {
  if (!message) return <>{children}</>;
  return (
    <div
      data-composer-tray=""
      className={cn("bg-sidebar-bg flex w-full min-w-0 flex-col p-1", COMPOSER_TRAY_RADIUS)}
    >
      {children}
      <div className="flex min-h-9 min-w-0 items-center justify-between gap-3 pr-1.5 pl-3.5" role="status">
        <span className="text-fg3 min-w-0 truncate text-xs">{message}</span>
        {action && (
          <Button
            variant="ghost"
            size="compact"
            className="shrink-0"
            onClick={action.onClick}
            onPointerEnter={action.onIntent}
            onFocus={action.onIntent}
          >
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}
