import { useEffect, useState } from "react";
import {
  Archive,
  ArrowDownUp,
  ChevronDown,
  Columns3,
  Search,
  TextAlignJustify,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Button } from "../../shared/ui/primitives/button";
import { IconButton } from "../../shared/ui/primitives/icon-button";
import { Input } from "../../shared/ui/primitives/input";
import { Tooltip } from "../../shared/ui/primitives/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuCheckboxItem,
} from "../../shared/ui/primitives/dropdown-menu";
import {
  updateDashboardPreferences,
  type DashboardPreferences,
  type DashboardDisplay,
  type DashboardSort,
  type DashboardArchive,
  type DashboardView,
} from "./preferences";

const ARCHIVE_OPTIONS: { value: DashboardArchive; label: string }[] = [
  { value: "active", label: "Hiding archived" },
  { value: "all", label: "Showing all" },
  { value: "archived", label: "Only archived" },
];
const SORT_OPTIONS: { value: DashboardSort; label: string }[] = [
  { value: "activity", label: "Last active" },
  { value: "newest", label: "Newest" },
  { value: "name", label: "Name" },
  { value: "repository", label: "Repository" },
];
const DISPLAY_OPTIONS: { value: keyof DashboardDisplay; label: string }[] = [
  { value: "repository", label: "Repository" },
  { value: "repositoryIcon", label: "Repository icon" },
  { value: "lineChanges", label: "Line changes" },
  { value: "cost", label: "Cost" },
  { value: "owner", label: "Owner" },
  { value: "lastActive", label: "Last active" },
];

export function DashboardViewToggle({ view }: { view: DashboardView }) {
  return (
    // The segmented control: a 28px bg2 track with 24px items; the chosen
    // item is IconButton's pressed fill, the selected-bg Tabs uses, with no
    // edge.
    <div
      role="group"
      aria-label="Dashboard view"
      className="bg-bg2 flex items-center gap-0.5 rounded-lg p-0.5"
    >
      {(
        [
          { value: "board", label: "Board view", icon: Columns3 },
          { value: "list", label: "List view", icon: TextAlignJustify },
        ] as const
      ).map(({ value, label, icon: Icon }) => (
        <Tooltip key={value} label={label}>
          <IconButton
            size="compact"
            label={label}
            aria-pressed={view === value}
            className="hover:bg-transparent"
            onClick={() => updateDashboardPreferences({ view: value })}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </IconButton>
        </Tooltip>
      ))}
    </div>
  );
}

export function DashboardToolbar({
  preferences,
  query,
  onQueryChange,
  active,
}: {
  preferences: DashboardPreferences;
  query: string;
  onQueryChange: (query: string) => void;
  active: boolean;
}) {
  const [menu, setMenu] = useState<"archive" | "sort" | "display" | null>(null);
  useEffect(() => {
    if (!active) setMenu(null);
  }, [active]);
  const open = (name: NonNullable<typeof menu>) => ({
    open: active && menu === name,
    onOpenChange: (value: boolean) => setMenu(value ? name : null),
  });
  return (
    // Search leads at up to 280px; the menus keep to the right edge.
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 pb-3">
      <div className="relative w-70 min-w-45 shrink">
        <Search
          className="text-fg3 pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          type="search"
          aria-label="Search workspaces"
          placeholder="Search workspaces…"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="pr-8 pl-7 [&::-webkit-search-cancel-button]:appearance-none"
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.stopPropagation();
              onQueryChange("");
            }
          }}
        />
        {query && (
          <IconButton
            label="Clear search"
            className="absolute top-1 right-1"
            onClick={() => onQueryChange("")}
          >
            <X className="size-3.5" />
          </IconButton>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <DropdownMenu {...open("archive")}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="text-fg2"
              aria-label="Archive visibility"
            >
              <Archive />
              <span>
                {
                  ARCHIVE_OPTIONS.find(
                    (option) => option.value === preferences.archive,
                  )?.label
                }
              </span>
              <ChevronDown className="text-muted-fg" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={preferences.archive}
              onValueChange={(value) =>
                updateDashboardPreferences({
                  archive: value as DashboardArchive,
                })
              }
            >
              {ARCHIVE_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu {...open("sort")}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="text-fg2"
              aria-label="Sort workspaces"
            >
              <ArrowDownUp />
              <span>
                {
                  SORT_OPTIONS.find(
                    (option) => option.value === preferences.sort,
                  )?.label
                }
              </span>
              <ChevronDown className="text-muted-fg" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={preferences.sort}
              onValueChange={(value) =>
                updateDashboardPreferences({ sort: value as DashboardSort })
              }
            >
              {SORT_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu {...open("display")}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="text-fg2">
              <SlidersHorizontal />
              <span>Display</span>
              <ChevronDown className="text-muted-fg" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {DISPLAY_OPTIONS.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.value}
                checked={preferences.display[option.value]}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) =>
                  updateDashboardPreferences({
                    display: { [option.value]: checked === true },
                  })
                }
              >
                {option.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
