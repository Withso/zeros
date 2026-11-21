import type { ReactNode } from "react";
import { CircleCheck, CircleMinus, CircleX, LoaderCircle } from "lucide-react";

export type BuildHistoryState = "succeeded" | "failed" | "cancelled" | "queued" | "building";
export const BUILD_ICON: Record<BuildHistoryState, { icon: ReactNode; label: string }> = {
  succeeded: { icon: <CircleCheck className="text-fg2 size-4 shrink-0" aria-hidden />, label: "Built" },
  failed: { icon: <CircleX className="text-red-primary size-4 shrink-0" aria-hidden />, label: "Failed" },
  cancelled: { icon: <CircleMinus className="text-fg3 size-4 shrink-0" aria-hidden />, label: "Cancelled" },
  queued: { icon: <LoaderCircle className="text-fg2 size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />, label: "Queued" },
  building: { icon: <LoaderCircle className="text-fg2 size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />, label: "Building" },
};

/** One build in a history list: the Cloud Computer's and each repository's ready copy share it. */
export function BuildHistoryItem({ state, title, details, action }: { state: BuildHistoryState; title: string; details: readonly (string | null)[]; action?: ReactNode }) {
  const icon = BUILD_ICON[state];
  return (
    <li className="flex min-h-10 items-center justify-between gap-3 py-2">
      <span className="flex min-w-0 items-center gap-3">
        <span title={icon.label} className="inline-flex">{icon.icon}<span className="sr-only">{icon.label}</span></span>
        <span className="text-fg1 text-xs font-medium">{title}</span>
        <span className="text-muted-fg truncate text-xs">{details.filter(Boolean).join(" · ")}</span>
      </span>
      {action}
    </li>
  );
}
