import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../shared/ui/cn";
import { DOCK_CARD_CLS } from "../features/agent/composer-shell";

/** The frame that takes the composer's place (archived, read-only, no-Creator): a dock card like the ones above a
 * live composer, with an icon, one line, optional detail lines and actions on the right. */
export function ComposerReplacementBar({ icon, message, details, stacked = details !== undefined, actions, cardProps }: {
  icon: ReactNode;
  message: ReactNode;
  /** Lines under the message (saved time, errors, reasons). */
  details?: ReactNode;
  /** The message sits in its own column even without details (the archived bar's layout). */
  stacked?: boolean;
  actions?: ReactNode;
  cardProps?: HTMLAttributes<HTMLDivElement> & { [key: `data-${string}`]: string };
}) {
  return (
    <div className="mx-auto w-full max-w-(--chat-column) shrink-0 px-7 pt-2 pb-4">
      <div className={cn(DOCK_CARD_CLS, "flex items-center gap-3 px-3.5 py-3")} role="status" {...cardProps}>
        {icon}
        {stacked ? (
          <div className="min-w-0 flex-1">
            <p className="text-fg2 text-sm">{message}</p>
            {details}
          </div>
        ) : <p className="text-fg2 min-w-0 flex-1 text-sm">{message}</p>}
        {actions}
      </div>
    </div>
  );
}
