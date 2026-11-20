import type { ReactNode } from "react";

import { Button } from "@/renderer/shared/ui/primitives/button";
import { cn } from "@/renderer/shared/ui/cn";

/** 22px: the composer's 18px corners stay concentric across the tray's 4px bleed. */
export const COMPOSER_TRAY_RADIUS = "rounded-[calc(var(--radius-lg)*2.75)]";

/**
 * A composer that cannot act yet, or has something to say, sits on a slightly
 * larger sidebar-bg tray with one status line beneath it and at most one
 * action. The tray paints outside the composer's box: its fill bleeds 4px
 * around the card and its line hangs below it, so on a centered page nothing
 * above or at the card moves as the message comes and goes, and the tray only
 * grows downward. Content below the composer must leave room for the line.
 * The wrapper and the composer's slot never change, so the composer is not
 * remounted and keeps its focus and history.
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
  return (
    <div className="relative" {...(message ? { "data-composer-tray": "" } : {})}>
      {message && (
        <div
          aria-hidden="true"
          className={cn("bg-sidebar-bg pointer-events-none absolute -inset-x-1 -top-1 -bottom-10", COMPOSER_TRAY_RADIUS)}
        />
      )}
      {children}
      {message && (
        <div
          className="absolute inset-x-0 top-full flex h-9 min-w-0 items-center justify-between gap-3 pr-0.5 pl-2.5"
          role="status"
        >
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
      )}
    </div>
  );
}
