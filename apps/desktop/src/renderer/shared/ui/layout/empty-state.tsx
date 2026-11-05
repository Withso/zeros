import * as React from "react";
import { CircleAlert } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";

/** A failure inside an empty state: one red 12/16 line with its 14px icon,
 *  under the text and above the action, which stays ready to try again. */
export function EmptyStateError({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      role="alert"
      data-slot="empty-state-error"
      className={cn(
        "text-red-primary m-0 flex max-w-sm items-start gap-1.5 text-left text-3xxs leading-4",
        className,
      )}
      {...props}
    >
      <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** The one empty state (docs/design-system.md §0): a 32px fg3 icon over one
 *  13/18 fg2 line, centred in the space it fills, plus one action only when
 *  it creates or configures something. A titled state (a named thing that
 *  hasn't started, such as Setup or Dev server) puts a 13 medium fg1 title
 *  between the icon and the line. A failure is one red line under the text
 *  (`error`); a list the state is about (`detail`) sits between them. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  detail,
  error,
  action,
  className,
  ...props
}: Omit<React.HTMLAttributes<HTMLDivElement>, "children" | "title"> & {
  /** A lucide glyph or any icon component that takes className. */
  icon: React.ElementType;
  title?: React.ReactNode;
  /** One line. */
  children: React.ReactNode;
  detail?: React.ReactNode;
  error?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center",
        className,
      )}
      {...props}
    >
      <Icon className="text-fg3 size-8" strokeWidth={1.25} aria-hidden />
      {title ? (
        <p className="text-fg1 m-0 -mb-1.5 text-xs leading-4.5 font-medium">{title}</p>
      ) : null}
      <p className="text-fg2 m-0 max-w-sm text-xs leading-4.5">{children}</p>
      {detail}
      {error ? <EmptyStateError>{error}</EmptyStateError> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
