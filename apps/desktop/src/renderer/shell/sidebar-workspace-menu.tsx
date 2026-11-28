import type { ReactNode } from "react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BookMarked,
  CalendarClock,
  CalendarPlus,
  CaseSensitive,
  CircleDot,
  Clock,
  Cloud,
  Eye,
  EyeOff,
  FolderGit2,
  GitPullRequest,
  Layers,
  ListFilter,
  ListTree,
  Mail,
  MessageCircleQuestion,
  Minus,
  Pencil,
  Rows2,
  Rows3,
  User,
  type LucideIcon,
} from "lucide-react";
import { ArchiveIcon } from "../shared/ui/archive-icon";
import type { Project } from "../state/projects-store";
import {
  SIDEBAR_AGENT_STATUS_FILTERS,
  SIDEBAR_PR_FILTERS,
  SIDEBAR_VIEW_DEFAULTS,
  resetSidebarView,
  setSidebarGroupHidden,
  setSidebarGroupOrder,
  setSidebarView,
  type SidebarAgentStatusFilter,
  type SidebarExtraGrouping,
  type SidebarGroupingId,
  type SidebarOwnerFilter,
  type SidebarPrFilter,
  type SidebarThenBy,
  type SidebarViewPreferences,
  type SidebarWorkspaceSort,
} from "../state/sidebar-list-preferences";
import { cn } from "../shared/ui/cn";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../shared/ui/primitives/dropdown-menu";
import { Switch } from "../shared/ui/primitives/switch";
import { Tooltip } from "../shared/ui/primitives/tooltip";
import { SIDEBAR_ROW_ACTION_CLS } from "./sidebar-repository-header";
import type { SidebarWorkspaceListFilter } from "./sidebar-workspace-model";
import { AGENT_STATUS_LABELS, PR_FILTER_LABELS } from "./sidebar-view-model";
import { parseRemote } from "./pr/github-url";
import { SidebarGroupOrderList, type SidebarGroupOrderItem } from "./sidebar-group-order-list";

type Icon = LucideIcon;
type GroupValue = SidebarWorkspaceListFilter | SidebarExtraGrouping;

const SORTS: readonly { value: SidebarWorkspaceSort; label: string; icon: Icon }[] = [
  { value: "updated", label: "Last updated", icon: Clock },
  { value: "created", label: "Created", icon: CalendarPlus },
  { value: "name", label: "Name", icon: CaseSensitive },
];
const GROUPS: readonly { value: GroupValue; label: string; icon: Icon }[] = [
  { value: "grouped", label: "Repository", icon: BookMarked },
  { value: "status", label: "Status", icon: CircleDot },
  { value: "placement", label: "Placement", icon: Cloud },
  { value: "owner", label: "Owner", icon: User },
  { value: "recency", label: "Recency", icon: CalendarClock },
  { value: "pr", label: "PR state", icon: GitPullRequest },
  { value: "ungrouped", label: "None", icon: Minus },
];
const THEN_BY_VALUE: Record<GroupValue, SidebarThenBy | null> = {
  grouped: "repository", status: "status", placement: "placement", owner: "owner", recency: "recency", pr: "pr", ungrouped: null,
};
const OWNER_LABELS: Record<SidebarOwnerFilter, string> = { mine: "Mine", following: "Following" };
const SORT_KEYS = ["direction", "needsYouFirst"] as const;
const FILTER_KEYS = ["statuses", "prStates", "owners", "unreadOnly", "draftOnly"] as const;
const GROUP_KEYS = ["grouping", "thenBy", "hideEmptyGroups", "groupOrder", "hiddenGroups"] as const;
const VIEW_KEYS = [...SORT_KEYS, ...FILTER_KEYS, ...GROUP_KEYS, "showProjectName", "compact", "expandChildren", "showArchived"] as const;

const APPLIED_CLS = "text-accent-text [&>svg]:text-accent-text";
const VALUE_CLS = "text-fg3 ml-3 shrink-0 text-3xxs tabular-nums";
const ICON_CLS = "text-fg2 size-3.5 shrink-0";

function differs<K extends keyof SidebarViewPreferences>(view: SidebarViewPreferences, key: K): boolean {
  return JSON.stringify(view[key]) !== JSON.stringify(SIDEBAR_VIEW_DEFAULTS[key]);
}

function toggled<T>(values: readonly T[], value: T, on: boolean): T[] {
  return on ? [...values.filter((entry) => entry !== value), value] : values.filter((entry) => entry !== value);
}

/** Choosing keeps the menu open: people try several views before settling. */
const stayOpen = (event: Event) => event.preventDefault();

/** A submenu's title with Reset once something in it differs from the default. */
function MenuHeader({ label, onReset }: { label: string; onReset?: (() => void) | null }) {
  return (
    <div className="flex h-7 items-center justify-between gap-2 pr-1 pl-2">
      <DropdownMenuLabel className="text-fg3 p-0 text-3xxs font-medium">{label}</DropdownMenuLabel>
      {onReset && (
        <DropdownMenuItem
          className="text-accent-text focus:text-accent-text h-6 w-auto px-1.5 text-3xxs"
          onSelect={(event) => {
            event.preventDefault();
            onReset();
          }}
        >
          Reset
        </DropdownMenuItem>
      )}
    </div>
  );
}

function SubTrigger({ icon: IconCmp, label, value, applied }: { icon: Icon; label: string; value?: ReactNode; applied: boolean }) {
  return (
    <DropdownMenuSubTrigger className={cn(applied && APPLIED_CLS)} data-applied={applied || undefined}>
      <IconCmp strokeWidth={1.5} className={cn(ICON_CLS, applied && "text-accent-text")} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value != null && <span className={cn(VALUE_CLS, applied && "text-accent-text")}>{value}</span>}
    </DropdownMenuSubTrigger>
  );
}

/** A menu row that toggles one boolean, drawn with the shared Switch. */
function SwitchRow({
  icon: IconCmp,
  label,
  checked,
  disabled,
  applied,
  onChange,
}: {
  icon: Icon;
  label: string;
  checked: boolean;
  disabled?: boolean;
  applied?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <DropdownMenuItem
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      className={cn(applied && APPLIED_CLS)}
      data-applied={applied || undefined}
      onSelect={(event) => {
        event.preventDefault();
        onChange(!checked);
      }}
    >
      <IconCmp strokeWidth={1.5} className={cn(ICON_CLS, applied && "text-accent-text")} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Switch checked={checked} disabled={disabled} tabIndex={-1} aria-hidden="true" className="pointer-events-none ml-3 scale-90" />
    </DropdownMenuItem>
  );
}

function CheckRow({ label, checked, count, onChange, icon: IconCmp }: { label: string; checked: boolean; count?: number; onChange: (checked: boolean) => void; icon?: Icon }) {
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      className={cn(checked && APPLIED_CLS)}
      onSelect={(event) => event.preventDefault()}
      onCheckedChange={onChange}
    >
      {IconCmp && <IconCmp strokeWidth={1.5} className={cn(ICON_CLS, checked && "text-accent-text")} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count != null && <span className={cn(VALUE_CLS, checked && "text-accent-text")}>{count}</span>}
    </DropdownMenuCheckboxItem>
  );
}

function FixedRow({ icon: IconCmp, label, disabled }: { icon: Icon; label: string; disabled?: boolean }) {
  return (
    <div className={cn("text-fg1 flex h-7 items-center gap-2 px-2 text-xs", disabled && "text-fg3")} aria-disabled={disabled || undefined}>
      <IconCmp strokeWidth={1.5} className={ICON_CLS} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </div>
  );
}

export interface SidebarWorkspaceMenuCounts {
  statuses: Readonly<Record<SidebarAgentStatusFilter, number>>;
  prStates: Readonly<Record<SidebarPrFilter, number>>;
}

/** The current grouping's groups for the Group menu, in their painted order. */
export interface SidebarWorkspaceMenuGroups {
  grouping: SidebarGroupingId;
  items: readonly SidebarGroupOrderItem[];
  hidden: readonly string[];
}

/** The sidebar's view menu: Sort, Filter, Group and Show, plus the row
 * switches. Defaults read neutral; only what the user changed turns blue. The
 * trigger carries no indicator. It opens beside the sidebar, so the list stays
 * in view while it changes, and choosing never closes it: a click outside,
 * Escape or the trigger does. */
export function SidebarWorkspaceMenu({
  active,
  projects,
  grouping,
  sort,
  view,
  repositoryIds,
  sharing,
  counts,
  groups: groupList,
  onGroupingChange,
  onSortChange,
  onRepositoryIdsChange,
  hiddenPlacements,
  onHiddenPlacementsChange,
}: {
  active: boolean;
  projects: readonly Project[];
  grouping: SidebarWorkspaceListFilter;
  sort: SidebarWorkspaceSort;
  view: SidebarViewPreferences;
  repositoryIds: readonly string[];
  /** Team sharing: the Owner filter and grouping only mean something there. */
  sharing: boolean;
  counts?: SidebarWorkspaceMenuCounts;
  /** The current grouping's groups to reorder and hide; null for None. */
  groups?: SidebarWorkspaceMenuGroups | null;
  onGroupingChange: (value: SidebarWorkspaceListFilter) => void;
  onSortChange: (value: SidebarWorkspaceSort) => void;
  onRepositoryIdsChange: (value: readonly string[]) => void;
  /** unified-workspaces: This Mac / Cloud, a view preference that starts with both shown. */
  hiddenPlacements?: readonly ("local" | "cloud")[];
  onHiddenPlacementsChange?: (value: readonly ("local" | "cloud")[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Beside the sidebar, not over it: 8px past its right edge, top-aligned
  // with the trigger. Measured on open; Radix flips it if the window is narrow.
  const [sideOffset, setSideOffset] = useState(8);
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const sidebar = trigger?.closest("[data-app-sidebar]");
    if (!trigger || !sidebar) return;
    setSideOffset(Math.max(4, Math.round(sidebar.getBoundingClientRect().right - trigger.getBoundingClientRect().right) + 8));
  }, [open]);
  const repositories = useMemo(
    () =>
      projects.map((project) => {
        const remote = parseRemote(project.originUrl);
        return { project, label: remote ? `${remote.owner}/${remote.repo}` : project.name };
      }),
    [projects],
  );
  const selected = new Set(repositoryIds);
  const placementFiltered = (hiddenPlacements?.length ?? 0) > 0;
  const groupValue: GroupValue = view.grouping ?? grouping;
  const groups = GROUPS.filter((entry) =>
    (entry.value !== "owner" || sharing) && (entry.value !== "placement" || hiddenPlacements !== undefined));

  const sortApplied = sort !== "updated" || SORT_KEYS.some((key) => differs(view, key));
  const filterCount =
    (repositoryIds.length > 0 ? 1 : 0) + (placementFiltered ? 1 : 0) +
    (view.statuses.length > 0 ? 1 : 0) + (view.prStates.length > 0 ? 1 : 0) + (view.owners.length > 0 ? 1 : 0) +
    (view.unreadOnly ? 1 : 0) + (view.draftOnly ? 1 : 0);
  const groupOrderApplied = !!groupList && ((view.groupOrder[groupList.grouping]?.length ?? 0) > 0 || groupList.hidden.length > 0);
  const groupApplied = groupValue !== "grouped" || differs(view, "thenBy") || differs(view, "hideEmptyGroups") || groupOrderApplied;
  const showApplied = view.showProjectName && !view.compact;
  const anyApplied = sortApplied || filterCount > 0 || groupApplied || showApplied ||
    view.compact || view.expandChildren || view.showArchived;

  const resetSort = () => {
    onSortChange("updated");
    resetSidebarView(SORT_KEYS);
  };
  const resetFilters = () => {
    onRepositoryIdsChange([]);
    onHiddenPlacementsChange?.([]);
    resetSidebarView(FILTER_KEYS);
  };
  const resetGroups = () => {
    onGroupingChange("grouped");
    resetSidebarView(GROUP_KEYS);
  };
  const resetAll = () => {
    onSortChange("updated");
    onGroupingChange("grouped");
    onRepositoryIdsChange([]);
    onHiddenPlacementsChange?.([]);
    resetSidebarView(VIEW_KEYS);
  };
  const setGroup = (value: GroupValue) => {
    if (value === "grouped" || value === "status" || value === "ungrouped") {
      onGroupingChange(value);
      setSidebarView({ grouping: null, ...(view.thenBy === THEN_BY_VALUE[value] ? { thenBy: null } : {}) });
    } else {
      setSidebarView({ grouping: value, ...(view.thenBy === value ? { thenBy: null } : {}) });
    }
  };
  const sortLabel = SORTS.find((entry) => entry.value === sort)?.label ?? "Last updated";
  const groupLabel = GROUPS.find((entry) => entry.value === groupValue)?.label ?? "Repository";
  const newest = sort === "name" ? "A to Z" : "Newest first";
  const oldest = sort === "name" ? "Z to A" : "Oldest first";

  return (
    <DropdownMenu open={active && open} onOpenChange={setOpen}>
      <Tooltip label="Filter workspaces" side="bottom" disabled={open}>
        <DropdownMenuTrigger asChild>
          <IconButton
            ref={triggerRef}
            type="button"
            size="compact"
            className={cn(SIDEBAR_ROW_ACTION_CLS, "relative")}
            label="Filter workspaces"
            aria-description={anyApplied ? "View changed from defaults" : undefined}
            data-filtered={anyApplied || undefined}
          >
            <ListFilter strokeWidth={1.5} />
          </IconButton>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent side="right" align="start" sideOffset={sideOffset} className="w-60" aria-label="Workspace display options">
        <MenuHeader label="View" onReset={anyApplied ? resetAll : null} />
        <DropdownMenuSub>
          <SubTrigger icon={ArrowUpDown} label="Sort" value={sortLabel} applied={sortApplied} />
          <DropdownMenuSubContent className="w-56" aria-label="Sort workspaces">
            <MenuHeader label="Sort" onReset={sortApplied ? resetSort : null} />
            <DropdownMenuRadioGroup value={sort} onValueChange={(value) => onSortChange(value as SidebarWorkspaceSort)} aria-label="Sort by">
              {SORTS.map(({ value, label, icon: IconCmp }) => (
                <DropdownMenuRadioItem key={value} value={value} onSelect={stayOpen} className={cn(value !== "updated" && sort === value && APPLIED_CLS)}>
                  <IconCmp strokeWidth={1.5} className={cn(ICON_CLS, value !== "updated" && sort === value && "text-accent-text")} />
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={view.direction} onValueChange={(value) => setSidebarView({ direction: value === "asc" ? "asc" : "desc" })} aria-label="Direction">
              <DropdownMenuRadioItem value="desc" onSelect={stayOpen}>
                <ArrowDown strokeWidth={1.5} className={ICON_CLS} />
                {newest}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="asc" onSelect={stayOpen} className={cn(view.direction === "asc" && APPLIED_CLS)}>
                <ArrowUp strokeWidth={1.5} className={cn(ICON_CLS, view.direction === "asc" && "text-accent-text")} />
                {oldest}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <SwitchRow icon={MessageCircleQuestion} label="Needs you on top" checked={view.needsYouFirst} applied={view.needsYouFirst}
              onChange={(needsYouFirst) => setSidebarView({ needsYouFirst })} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <SubTrigger icon={ListFilter} label="Filter" value={filterCount > 0 ? filterCount : undefined} applied={filterCount > 0} />
          <DropdownMenuSubContent className="w-56" aria-label="Workspace filters">
            <MenuHeader label="Filter" onReset={filterCount > 0 ? resetFilters : null} />
            <DropdownMenuSub>
              <SubTrigger icon={CircleDot} label="Status" value={view.statuses.length || undefined} applied={view.statuses.length > 0} />
              <DropdownMenuSubContent className="w-52" aria-label="Filter by status">
                <MenuHeader label="Status" onReset={view.statuses.length > 0 ? () => resetSidebarView(["statuses"]) : null} />
                {SIDEBAR_AGENT_STATUS_FILTERS.map((status) => (
                  <CheckRow key={status} label={AGENT_STATUS_LABELS[status]} checked={view.statuses.includes(status)} count={counts?.statuses[status]}
                    onChange={(checked) => setSidebarView({ statuses: toggled(view.statuses, status, checked) })} />
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {hiddenPlacements && onHiddenPlacementsChange && (
              <DropdownMenuSub>
                <SubTrigger icon={Cloud} label="Placement" value={placementFiltered ? 1 : undefined} applied={placementFiltered} />
                <DropdownMenuSubContent className="w-44" aria-label="Filter by placement">
                  <MenuHeader label="Placement" onReset={placementFiltered ? () => onHiddenPlacementsChange([]) : null} />
                  {(["local", "cloud"] as const).map((placement) => {
                    const shown = !hiddenPlacements.includes(placement);
                    const other = placement === "local" ? "cloud" : "local";
                    return (
                      <DropdownMenuCheckboxItem
                        key={placement}
                        checked={shown}
                        className={cn(placementFiltered && shown && APPLIED_CLS)}
                        // The last shown placement stays: hiding both would empty the list.
                        disabled={shown && hiddenPlacements.includes(other)}
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={(checked) => onHiddenPlacementsChange(checked ? [] : [placement])}
                      >
                        {placement === "local" ? "This Mac" : "Cloud"}
                      </DropdownMenuCheckboxItem>
                    );
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuSub>
              <SubTrigger icon={BookMarked} label="Repository" value={repositoryIds.length || undefined} applied={repositoryIds.length > 0} />
              <DropdownMenuSubContent className="max-h-80 w-60 overflow-y-auto" aria-label="Filter by repository">
                <MenuHeader label="Repository" onReset={repositoryIds.length > 0 ? () => onRepositoryIdsChange([]) : null} />
                {repositories.map(({ project, label }) => (
                  <DropdownMenuCheckboxItem
                    key={project.id}
                    checked={selected.has(project.id)}
                    className={cn(selected.has(project.id) && APPLIED_CLS)}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(checked) =>
                      onRepositoryIdsChange(checked ? [...repositoryIds, project.id] : repositoryIds.filter((id) => id !== project.id))
                    }
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{label}</span>
                      {repositories.some((other) => other.project.id !== project.id && other.label === label) && (
                        <span className="text-fg3 text-3xxs block truncate">{project.repoRoot}</span>
                      )}
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
                {repositories.length === 0 && (
                  <div className="text-fg3 flex h-7 items-center px-2 text-xs" role="status">No repositories</div>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <SubTrigger icon={GitPullRequest} label="PR state" value={view.prStates.length || undefined} applied={view.prStates.length > 0} />
              <DropdownMenuSubContent className="w-52" aria-label="Filter by pull request state">
                <MenuHeader label="PR state" onReset={view.prStates.length > 0 ? () => resetSidebarView(["prStates"]) : null} />
                {SIDEBAR_PR_FILTERS.map((state) => (
                  <CheckRow key={state} label={PR_FILTER_LABELS[state]} checked={view.prStates.includes(state)} count={counts?.prStates[state]}
                    onChange={(checked) => setSidebarView({ prStates: toggled(view.prStates, state, checked) })} />
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {sharing && (
              <DropdownMenuSub>
                <SubTrigger icon={User} label="Owner" value={view.owners.length || undefined} applied={view.owners.length > 0} />
                <DropdownMenuSubContent className="w-44" aria-label="Filter by owner">
                  <MenuHeader label="Owner" onReset={view.owners.length > 0 ? () => resetSidebarView(["owners"]) : null} />
                  {(["mine", "following"] as const).map((owner) => (
                    <CheckRow key={owner} label={OWNER_LABELS[owner]} checked={view.owners.includes(owner)}
                      onChange={(checked) => setSidebarView({ owners: toggled(view.owners, owner, checked) })} />
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuSeparator />
            <SwitchRow icon={Mail} label="Unread only" checked={view.unreadOnly} applied={view.unreadOnly}
              onChange={(unreadOnly) => setSidebarView({ unreadOnly })} />
            <SwitchRow icon={Pencil} label="Has unsent draft" checked={view.draftOnly} applied={view.draftOnly}
              onChange={(draftOnly) => setSidebarView({ draftOnly })} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <SubTrigger icon={Rows3} label="Group" value={groupLabel} applied={groupApplied} />
          <DropdownMenuSubContent className="w-64" aria-label="Group workspaces">
            <MenuHeader label="Group" onReset={groupApplied ? resetGroups : null} />
            <DropdownMenuSub>
              <SubTrigger icon={Rows3} label="Group by" value={groupLabel} applied={groupValue !== "grouped"} />
              <DropdownMenuSubContent className="w-48" aria-label="Group by">
                <DropdownMenuRadioGroup value={groupValue} onValueChange={(value) => setGroup(value as GroupValue)} aria-label="Group by">
                  {groups.map(({ value, label, icon: IconCmp }) => (
                    <DropdownMenuRadioItem key={value} value={value} onSelect={stayOpen} className={cn(value !== "grouped" && groupValue === value && APPLIED_CLS)}>
                      <IconCmp strokeWidth={1.5} className={cn(ICON_CLS, value !== "grouped" && groupValue === value && "text-accent-text")} />
                      {label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            {groupList && groupList.items.length > 0 ? (
              <SidebarGroupOrderList
                items={groupList.items}
                hidden={groupList.hidden}
                onReorder={(keys) => setSidebarGroupOrder(groupList.grouping, keys)}
                onToggleHidden={(key, hidden) => setSidebarGroupHidden(groupList.grouping, key, hidden)}
              />
            ) : (
              <div className="text-fg3 flex h-7 items-center px-2 text-xs" role="status">One list: no groups to order</div>
            )}
            <DropdownMenuSeparator />
            {groupValue !== "ungrouped" && (
              <DropdownMenuSub>
                <SubTrigger icon={Layers} label="Sub-group"
                  value={view.thenBy ? GROUPS.find((entry) => THEN_BY_VALUE[entry.value] === view.thenBy)?.label : "None"}
                  applied={view.thenBy !== null} />
                <DropdownMenuSubContent className="w-48" aria-label="Sub-group">
                  <MenuHeader label="Sub-group" onReset={view.thenBy ? () => resetSidebarView(["thenBy"]) : null} />
                  <DropdownMenuRadioGroup value={view.thenBy ?? "none"}
                    onValueChange={(value) => setSidebarView({ thenBy: value === "none" ? null : (value as SidebarThenBy) })} aria-label="Sub-group">
                    <DropdownMenuRadioItem value="none" onSelect={stayOpen}>
                      <Minus strokeWidth={1.5} className={ICON_CLS} />
                      None
                    </DropdownMenuRadioItem>
                    {groups.flatMap(({ value, label, icon: IconCmp }) => {
                      const then = THEN_BY_VALUE[value];
                      if (!then || value === groupValue) return [];
                      return [(
                        <DropdownMenuRadioItem key={value} value={then} onSelect={stayOpen} className={cn(view.thenBy === then && APPLIED_CLS)}>
                          <IconCmp strokeWidth={1.5} className={cn(ICON_CLS, view.thenBy === then && "text-accent-text")} />
                          {label}
                        </DropdownMenuRadioItem>
                      )];
                    })}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <SwitchRow icon={EyeOff} label="Hide empty groups" checked={view.hideEmptyGroups} applied={view.hideEmptyGroups}
              onChange={(hideEmptyGroups) => setSidebarView({ hideEmptyGroups })} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <SubTrigger icon={Eye} label="Show" value={showApplied ? 1 : undefined} applied={showApplied} />
          <DropdownMenuSubContent className="w-56" aria-label="Row properties">
            <MenuHeader label="Always shown" onReset={showApplied ? () => resetSidebarView(["showProjectName"]) : null} />
            <FixedRow icon={CircleDot} label="Status" />
            <FixedRow icon={GitPullRequest} label="Pull requests" />
            <FixedRow icon={Clock} label="Last updated" />
            <DropdownMenuSeparator />
            {view.compact ? (
              <>
                <MenuHeader label="Unavailable in Compact view" />
                <SwitchRow icon={FolderGit2} label="Project name" checked={false} disabled onChange={() => undefined} />
              </>
            ) : (
              <SwitchRow icon={FolderGit2} label="Project name" checked={view.showProjectName} applied={view.showProjectName}
                onChange={(showProjectName) => setSidebarView({ showProjectName })} />
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <SwitchRow icon={Rows2} label="Compact view" checked={view.compact} applied={view.compact}
          onChange={(compact) => setSidebarView({ compact })} />
        <SwitchRow icon={ListTree} label="Expand child workspaces" checked={view.expandChildren} applied={view.expandChildren}
          onChange={(expandChildren) => setSidebarView({ expandChildren })} />
        <SwitchRow icon={ArchiveIcon} label="Show archived" checked={view.showArchived} applied={view.showArchived}
          disabled={groupValue === "status"}
          onChange={(showArchived) => setSidebarView({ showArchived })} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
