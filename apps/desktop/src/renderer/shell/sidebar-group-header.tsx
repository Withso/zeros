// ============================================
// COMPONENT: SidebarGroupHeader
// PURPOSE: The one header row for the sidebar's sections (My workspaces,
//          Following, Archived), groups and sub-groups.
// USED IN: AppSidebar, SidebarArchivedSection
// ============================================
//
//   [icon] Label  count ………………………… [actions] [⌄]
//
// Every level is 28px with 12px medium text and its count after the label.
// Hover fills the whole row; the buttons inside keep their own hover on top.
// The arrow always sits at the right end, after any buttons, and turns right
// when collapsed. Sections read a step dimmer (fg3) than groups (fg2) so the
// top level stays the quietest; a sub-group indents 12px. Clicking anywhere
// else on the row collapses or expands it.

import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "../shared/ui/cn";
import { Button } from "../shared/ui/primitives/button";

export type SidebarGroupHeaderLevel = "section" | "group" | "subgroup";

export const SIDEBAR_GROUP_HEADER_CLS =
  "group/header relative flex h-7 w-full min-w-0 shrink-0 select-none items-center gap-1.5 rounded-md pr-0.5 text-3xxs leading-4 font-medium transition-none hover:bg-(--surface-hover) hover:text-fg1 has-[>button:focus-visible]:inset-ring has-[>button:focus-visible]:inset-ring-accent";
const LEVEL_CLS: Record<SidebarGroupHeaderLevel, string> = {
  section: "pl-2 text-fg3",
  group: "pl-2 text-fg2",
  subgroup: "pl-5 text-fg2",
};
const TOGGLE_CLS =
  "absolute inset-0 size-full rounded-md border-0 bg-transparent p-0 shadow-none transition-none hover:bg-transparent focus-visible:ring-0";

export function SidebarGroupHeader({
  level,
  label,
  count,
  icon,
  expanded,
  controls,
  onToggle,
  actions,
  className,
  ...data
}: {
  level: SidebarGroupHeaderLevel;
  label: string;
  count?: number;
  icon?: ReactNode;
  expanded: boolean;
  /** Id of the element holding this header's rows. */
  controls: string;
  onToggle: () => void;
  /** Buttons before the arrow (the filter menu, a repository's actions). */
  actions?: ReactNode;
  className?: string;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <div className={cn(SIDEBAR_GROUP_HEADER_CLS, LEVEL_CLS[level], className)} {...data}>
      <Button
        type="button"
        variant="ghost"
        className={TOGGLE_CLS}
        aria-expanded={expanded}
        aria-controls={controls}
        aria-label={count == null ? label : `${label}, ${count}`}
        onClick={onToggle}
      />
      <span className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-1.5">
        {icon && (
          <span className="inline-flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="min-w-0 truncate">{label}</span>
        {count != null && <span className="text-fg3 shrink-0 font-normal tabular-nums">{count}</span>}
      </span>
      <span className="relative flex shrink-0 items-center gap-0.5">
        {actions}
        <span className="text-fg3 pointer-events-none inline-flex size-6 items-center justify-center" aria-hidden="true" data-sidebar-header-arrow>
          {expanded ? <ChevronDown className="size-3.5" strokeWidth={1.5} /> : <ChevronRight className="size-3.5" strokeWidth={1.5} />}
        </span>
      </span>
    </div>
  );
}
