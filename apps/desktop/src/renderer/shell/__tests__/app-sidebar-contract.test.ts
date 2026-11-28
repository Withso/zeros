import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { HOME_SIDEBAR_MIN_PX } from "../home-sidebar-width";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

const SIDEBAR = source("apps/desktop/src/renderer/shell/app-sidebar.tsx");
const ROW = source("apps/desktop/src/renderer/shell/sidebar-workspace-row.tsx");
const HEADER = source(
  "apps/desktop/src/renderer/shell/sidebar-repository-header.tsx",
);
const SHELL = source("apps/desktop/src/renderer/app-shell.tsx");
const MODEL = source(
  "apps/desktop/src/renderer/shell/sidebar-workspace-model.ts",
);
const MENU = source("apps/desktop/src/renderer/shell/sidebar-workspace-menu.tsx");
const GROUP_HEADER = source("apps/desktop/src/renderer/shell/sidebar-group-header.tsx");

/** The literal class string assigned to a top-level `const NAME = "…"`. */
function classConstant(src: string, name: string): string {
  const match = new RegExp(`const ${name} =\\s*\\n?\\s*"([^"]*)"`).exec(src);
  if (!match) throw new Error(`${name} not found`);
  return match[1];
}

function between(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  const to = src.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`${start} … ${end} not found`);
  return src.slice(from, to);
}

describe("app shell navigation", () => {
  it("replaces the top bar and Home rail with one always-mounted sidebar", () => {
    expect(SHELL).toContain(
      "<AppSidebar hidden={settingsActive || sidebarCollapsed} />",
    );
    expect(SHELL).not.toContain("<TopBar");
    expect(SHELL).not.toContain("<HomeSidebar");
  });

  it("keeps the 40px title band clear of the macOS traffic lights", () => {
    const electronMain = source("apps/desktop/electron/main.ts");
    expect(electronMain).toContain('titleBarStyle: "hiddenInset"');
    expect(electronMain).toContain("trafficLightPosition: { x: 19, y: 12 }");
    expect(SIDEBAR).toMatch(
      /data-tauri-drag-region\s*className="flex h-10 shrink-0/,
    );
    expect(SIDEBAR).toMatch(
      /<div className=\{TRAFFIC_LIGHT_RESERVE_CLS\} aria-hidden="true" \/>\s*<SidebarToggleButton collapsed=\{false\} \/>/,
    );
    expect(SIDEBAR).not.toContain("useCustomWindowDrag");
    const settings = source(
      "apps/desktop/src/renderer/features/settings/settings-page.tsx",
    );
    expect(settings).not.toContain("useCustomWindowDrag");
    expect(settings).toMatch(
      /data-tauri-drag-region\s*className="flex h-10 shrink-0/,
    );
  });

  it("offers Home and Customize as destinations and Create as an action", () => {
    const nav = between(
      SIDEBAR,
      "<OrganizationSwitcher",
      "ref={listRef}",
    );
    const home = nav.indexOf("<House strokeWidth={1.5} />");
    const customize = nav.indexOf("Customize</span>");
    const create = nav.indexOf('aria-label="Create workspace"');
    expect(home).toBeGreaterThan(0);
    expect(nav).toContain('<span className="truncate">Home</span>');
    expect(nav).not.toContain("Dashboard</span>");
    expect(customize).toBeGreaterThan(home);
    expect(create).toBeGreaterThan(customize);
    const createButton = nav.slice(nav.lastIndexOf("<Button", create), create);
    expect(createButton).not.toContain("data-state");
    expect(createButton).not.toContain("aria-current");
    expect(nav).toContain("onClick={handleCreateWorkspace}");
    expect(SIDEBAR).toContain("() => openDispatcher(contextProject?.id)");
    // Adding a repository lives on Create, the welcome view and the menu bar.
    expect(SIDEBAR).not.toContain("Add repository");
  });

  it("keeps the navigation keepers the top bar owned", () => {
    for (const keeper of [
      "usePruneLegacyPhantomProjects();",
      "useSyncProjectsToEngine();",
      "usePrefetchSettings(projectRepoRoots);",
      "useNativeRuntimeNotice();",
      "useWorkspaceRunActivitySync(realWorkspaces);",
      'dispatch({ type: "CONFIRM_WORKSPACE_TARGET", folder: activeFolder });',
    ]) {
      expect(SIDEBAR).toContain(keeper);
    }
    // Hidden on Settings: inert, and its polling resource monitor unmounted.
    expect(SIDEBAR).toContain('{...(hidden ? { inert: "" } : {})}');
    expect(SIDEBAR).toContain("{!hidden && <ResourceMonitor />}");
  });

  it("follows resources with Go back and Go forward in the title band", () => {
    const band = between(
      SIDEBAR,
      "data-tauri-drag-region",
      "<OrganizationSwitcher",
    );
    const resources = band.indexOf("{!hidden && <ResourceMonitor />}");
    expect(resources).toBeGreaterThan(0);
    expect(band.indexOf("<SidebarHistoryButtons")).toBeGreaterThan(resources);
    expect(band).toMatch(/\{!hidden && \(\s*<SidebarHistoryButtons/);
    const buttons = source(
      "apps/desktop/src/renderer/shell/sidebar-history-buttons.tsx",
    );
    expect(buttons).toContain('label="Go back"');
    expect(buttons).toContain('label="Go forward"');
    expect(classConstant(buttons, "HISTORY_BUTTON_CLS")).toMatch(
      /^h-7 w-7 shrink-0 rounded-md text-fg2 hover:bg-bg1-raised-hover hover:text-fg1 /,
    );
    // A disabled button drops pointer events, which would hand a quick second
    // click to the title band's double-click zoom.
    expect(buttons).toContain("aria-disabled={!available || undefined}");
    expect(buttons).not.toMatch(/\sdisabled=/);
  });

  it("has no archived-workspaces picker in the title band", () => {
    expect(SIDEBAR).not.toContain("ArchivedWorkspacePicker");
    expect(SIDEBAR).not.toContain("Archived workspaces");
    expect(SIDEBAR).not.toContain("Search archived workspaces");
  });
});

describe("sidebar workspace list presentations", () => {
  it("offers Repository, Status and None with independent repository and sort controls", () => {
    expect(MODEL).toMatch(
      /SIDEBAR_WORKSPACE_LIST_FILTERS[^=]*=\s*\[\s*"grouped",\s*"status",\s*"ungrouped",?\s*\]/,
    );
    expect(MENU).toContain('aria-label="Group by"');
    expect(MENU).toContain('aria-label="Sort by"');
    // Step 2: the view menu has no search; every option is a checklist or switch.
    expect(MENU).not.toContain('type="search"');
    expect(MENU).not.toContain('"Then by"');
    for (const label of ["Sub-group", "Hide empty groups", "Needs you on top", "Unread only", "Has unsent draft", "Show archived", "Compact view", "Expand child workspaces"])
      expect(MENU, label).toContain(label);
    expect(SIDEBAR).not.toContain("repositoryWorkspaceListFilter");
  });

  it("persists the folded legacy presentation once, after painting it", () => {
    expect(SIDEBAR).toContain(
      "const listFilter = sidebarWorkspaceListFilter(requestedFilter);",
    );
    expect(SIDEBAR).toMatch(
      /if \(listFilter !== requestedFilter\) \{\s*dispatch\(\{ type: "SET_WORKSPACE_LIST_FILTER", filter: listFilter \}\);/,
    );
  });

  it("leads every row with the project logo and the loader while working", () => {
    const row = between(
      ROW,
      "export function SidebarWorkspaceRow(",
      "/** Placeholder row",
    );
    expect(row).toContain("<WorkspaceProjectIcon project={project} />");
    expect(row).not.toContain("trailingAgentState");
    // Any chat's activity, where a turn parked on the user rests.
    expect(row).toContain("useAnyChatWorkingActivity");
    expect(SIDEBAR).not.toContain("mixedRepositories");
  });

  // Design workspaces keep their pen in the leading slot in both row variants,
  // so the pending → confirmed swap neither drops nor re-adds it.
  it("keeps the design marker in the leading slot of both row variants", () => {
    const confirmed = between(
      ROW,
      "export function SidebarWorkspaceRow(",
      "/** Placeholder row",
    );
    const pending = ROW.slice(
      ROW.indexOf("export function PendingSidebarWorkspaceRow("),
    );
    expect(confirmed).toMatch(/lead === "design" \? <PenTool className="size-3\.5"/);
    expect(pending).toMatch(/kind === "design" \? \(\s*<PenTool className="size-3\.5"/);
  });

  // A parent's leading slot is the toggle for its child workspaces; there is
  // no separate "N child workspaces" row.
  it("toggles child workspaces from the parent's leading slot", () => {
    expect(ROW).toContain("data-child-workspaces-toggle={workspace.id}");
    expect(ROW).toMatch(/aria-expanded=\{childrenExpanded\}/);
    expect(SIDEBAR).toContain("onToggleChildren={item.childCount ? () => toggleChildWorkspaces(item.workspace.id) : undefined}");
    expect(SIDEBAR).not.toContain("child workspaces`}</span>");
  });
});

describe("sidebar workspace rows", () => {
  it("fill the sidebar width with the shared hover and their own selected fill", () => {
    const cls = classConstant(ROW, "SIDEBAR_WORKSPACE_ROW_CLS");
    expect(cls).toMatch(/\bw-full\b/);
    expect(classConstant(ROW, "SIDEBAR_WORKSPACE_COMPACT_ROW_CLS")).toMatch(/\bh-8\b/);
    expect(cls).toContain("hover:bg-(--surface-hover)");
    expect(cls).toContain("focus-within:bg-(--surface-hover)");
    // Step 2: selected shares the sidebar's own hover fill.
    expect(cls).toContain("data-[active=true]:bg-(--surface-hover)");
    expect(cls).not.toContain("selected-bg");
    expect(cls).toMatch(/data-\[active=true\]:text-fg1\b/);
    expect(cls).toContain("has-[>button:focus-visible]:inset-ring-accent");
    expect(cls).not.toContain("has-[>button:focus-visible]:ring-[3px]");
    expect(SIDEBAR).toMatch(/<Surface\s+as="nav"\s+kind="sidebar"/);
    expect(classConstant(HEADER, "REPOSITORY_HEADER_CLS")).toMatch(/\bh-7\b/);
    const surface = source(
      "apps/desktop/src/renderer/shared/ui/layout/surface.tsx",
    );
    expect(surface).toMatch(
      /sidebar:\s*"bg-nav-bg \[--surface-hover:var\(--nav-bg-hover\)\]/,
    );
  });

  it("keep the draft pencil after the name, with Archive (a tick) over the row's end", () => {
    const row = between(
      ROW,
      "export function SidebarWorkspaceRow(",
      "/** Placeholder row",
    );
    expect(row).toMatch(
      /\{label\}<\/span>\s*\{showDraft && \([\s\S]*?<ComposerDraftIndicator \/>/,
    );
    expect(row).toMatch(/\{rowAction\}\s*<\/div>/);
    expect(row).toContain("icon: <ArchiveIcon ");
    expect(classConstant(ROW, "SIDEBAR_WORKSPACE_ACTION_OVERLAY_CLS")).toMatch(
      /group-hover\/workspace:opacity-100/,
    );
  });

  it("give a legacy plain folder its settings in the Archive slot", () => {
    const row = between(
      ROW,
      "export function SidebarWorkspaceRow(",
      "/** Placeholder row",
    );
    expect(row).toMatch(
      /!localFolder\s*\?\s*\{\s*tooltip: "Archive workspace"/,
    );
    expect(row).toMatch(
      /onOpenSettings\s*\?\s*\{\s*tooltip: "Folder settings"/,
    );
    expect(SIDEBAR).toMatch(
      /onOpenSettings=\{\s*item\.project\.isGitRepository === false/,
    );
  });

  it("keep the workspace context menu, prefetch intent and DOM hooks", () => {
    const row = between(
      ROW,
      "export function SidebarWorkspaceRow(",
      "/** Placeholder row",
    );
    expect(row).toContain("<WorkspaceContextMenu");
    for (const event of ["onPointerEnter", "onFocus"]) {
      const handler = between(row, `${event}={(event) => {`, "}}");
      expect(handler).toContain("if (!surfaceActive || !eventInsideOwnDom(event)) return;");
      expect(handler).toContain("onPrefetch(workspace);");
    }
    expect(row).toContain('data-workspace-tab="true"');
    expect(row).toContain("data-workspace-id={workspace.id}");
  });

  it("register the selected optimistic row with the reveal machinery", () => {
    expect(SIDEBAR).toMatch(
      /const activeSelectionKey\s*=\s*activeWorkspaceId \?\? activePendingCreate\?\.token \?\? null;/,
    );
    expect(SIDEBAR).toContain('if (activePage !== "workspace") return null;');
    expect(SIDEBAR).toContain(
      "rowRef={(node) => registerRow(selectionKey, node)}",
    );
    const pending = ROW.slice(
      ROW.indexOf("export function PendingSidebarWorkspaceRow("),
    );
    expect(pending).toContain("ref={rowRef}");
  });
});

describe("sidebar collapse and geometry", () => {
  const TOGGLE = source("apps/desktop/src/renderer/shell/sidebar-toggle.tsx");
  const PANE = source(
    "apps/desktop/src/renderer/shell/conversation/conversation-pane.tsx",
  );
  const WORKSPACE_HEADER = source(
    "apps/desktop/src/renderer/shell/conversation/workspace-header.tsx",
  );

  it("seats the panel-left toggle after the traffic lights in both states", () => {
    expect(TOGGLE).toContain('import { PanelLeft } from "lucide-react";');
    expect(TOGGLE).toMatch(
      /export const TRAFFIC_LIGHT_RESERVE_CLS = "h-full w-\[80px\] shrink-0";/,
    );
    // Nudged up 1px onto the traffic lights' ~19px midline in both states.
    expect(TOGGLE).toMatch(/const TOGGLE_CLS =\s*"[^"]*-translate-y-px/);
    // The open title band and the collapsed band share the reserve and the
    // same 4px gap, so the button never moves when it is pressed.
    expect(TOGGLE).toMatch(
      /className="absolute top-0 left-0 z-\(--z-chrome\) flex h-10 items-center gap-1 pr-1"/,
    );
    expect(SIDEBAR).toMatch(
      /data-tauri-drag-region\s*className="flex h-10 shrink-0 items-center gap-1/,
    );
    expect(TOGGLE).toContain("aria-controls={APP_SIDEBAR_ID}");
    expect(SIDEBAR).toContain("id={APP_SIDEBAR_ID}");
  });

  it("floors the sidebar at the width its title band controls need", () => {
    expect(SIDEBAR).toContain(
      `resourceSummary ? "min-w-[280px]" : "min-w-[${HOME_SIDEBAR_MIN_PX}px]"`,
    );
  });

  it("opens Create beside the sidebar with no repositories or nothing chosen", () => {
    expect(SHELL).toContain('const nothingSelected = activePage === "workspace" && !activeWorkspaceFolder;');
    expect(SHELL).toMatch(
      /const opensCreate =\s*\(showWelcome && \(activePage === "dashboard" \|\| activePage === "workspace"\)\) \|\|\s*nothingSelected;/,
    );
    expect(SHELL).toContain('activePage === "create" || opensCreate');
    // The full-window welcome is gone; Create's start banners replace it.
    expect(SHELL).not.toContain("NoProjectsView");
    const CREATE = source("apps/desktop/src/renderer/shell/dispatcher/dispatcher-modal.tsx");
    expect(CREATE).toMatch(/\{!cloud\.computerMode && !selectedProject && \(\s*<CreateStartBanners/);
    expect(CREATE).toContain("!needsGitSetup && selectedProject && (");
  });

  it("keeps the corner the collapsed controls float over clear", () => {
    expect(SHELL).toContain(
      "const collapsedControlsVisible = sidebarCollapsed && !settingsActive;",
    );
    expect(SHELL).toContain(
      "{collapsedControlsVisible && <CollapsedSidebarControls />}",
    );
    // Home reserves the corner in the Dashboard's own title row instead of
    // dropping every page below a 40px band; only Create still starts below.
    expect(SHELL).toContain('collapsedControlsVisible && activeHomePageId === "create" ? "mt-10" : ""');
    const DASHBOARD = source("apps/desktop/src/renderer/features/dashboard/dashboard-page.tsx");
    expect(DASHBOARD).toMatch(/sidebarCollapsed && \(\s*<span\s+className=\{COLLAPSED_CONTROLS_RESERVE_CLS\}/);
    expect(TOGGLE).toContain('export const COLLAPSED_CONTROLS_RESERVE_CLS = "h-full w-29 shrink-0";');
    expect(SHELL).toContain("windowControlsInset={sidebarCollapsed}");
    // The reserve belongs to the single column header, above all split panes.
    expect(PANE).toMatch(
      /<ConversationWorkspaceHeader\s[\s\S]*?windowControlsInset=\{windowControlsInset\}/,
    );
    expect(WORKSPACE_HEADER).toMatch(
      /windowControlsInset && <span className="block h-full w-\[108px\] shrink-0"[^>]*data-window-controls-reserve/,
    );
    expect(PANE).not.toContain("data-window-controls-reserve");
    expect(WORKSPACE_HEADER.match(/data-window-controls-reserve/g)).toHaveLength(1);
  });

  it("uses 32px rows and 2px gaps on one 16px icon column, with a quiet section header", () => {
    const entry = classConstant(SIDEBAR, "SIDEBAR_ENTRY_CLS");
    // 8px list inset + 8px padding and no border put every icon at 16px.
    for (const cls of ["h-8", "px-2", "gap-2", "border-0", "data-[state=active]:bg-selected-bg", "[&>svg]:text-fg3"]) {
      expect(entry.split(/\s+/), cls).toContain(cls);
    }
    // Every header (section, group, sub-group, repository) is one 28px row.
    expect(classConstant(HEADER, "REPOSITORY_HEADER_CLS")).toMatch(/\bh-7\b/);
    expect(classConstant(GROUP_HEADER, "SIDEBAR_GROUP_HEADER_CLS")).toMatch(/\bh-7\b/);
    expect(SIDEBAR).toContain('<div className="flex flex-col gap-0.5">');
    expect(SIDEBAR).toContain('className="flex flex-col gap-0.5 empty:hidden"');
    expect(SIDEBAR).toContain('{section.id === null ? "My workspaces" : section.label}');
    expect(SIDEBAR).toContain("setSidebarSectionCollapsed(id, !collapsed)");
    expect(SIDEBAR).toContain('level="section"');
    const header = classConstant(GROUP_HEADER, "SIDEBAR_GROUP_HEADER_CLS").split(/\s+/);
    for (const cls of ["text-3xxs", "leading-4", "font-medium", "hover:bg-(--surface-hover)"]) expect(header, cls).toContain(cls);
    expect(GROUP_HEADER).toContain('section: "pl-2 text-fg3"');
    // The scroller's 4px top inset keeps the first header's focus ring whole.
    expect(SIDEBAR).toContain('className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2"');
  });
});

describe("sidebar typography and colour", () => {
  it("sets every row label at 13px and every header at 12px", () => {
    for (const cls of [
      classConstant(SIDEBAR, "SIDEBAR_ENTRY_CLS"),
      classConstant(ROW, "SIDEBAR_WORKSPACE_ROW_CLS"),
    ]) {
      expect(cls).toMatch(/\btext-xs\b/);
      expect(cls).not.toMatch(/\btext-sm\b/);
    }
    for (const cls of [
      classConstant(HEADER, "REPOSITORY_HEADER_CLS"),
      classConstant(GROUP_HEADER, "SIDEBAR_GROUP_HEADER_CLS"),
    ]) expect(cls).toMatch(/\btext-3xxs\b/);
  });

  it("keeps repository names and workspace glyphs on fg2", () => {
    const header = classConstant(HEADER, "REPOSITORY_HEADER_CLS");
    expect(header).toMatch(/\btext-fg2\b/);
    // Hover lifts the name with the whole row's fill; at rest it is fg2.
    expect(header.split(/\s+/)).toContain("hover:text-fg1");
    expect(header.split(/\s+/)).not.toContain("text-fg1");
    expect(header).not.toContain("has-[:focus-visible]:bg-");
    // An open repository page fills its header like a selected row.
    expect(header.split(/\s+/)).toContain("data-[active=true]:bg-(--surface-hover)");
    expect(classConstant(ROW, "GLYPH_BOX_CLS")).toMatch(/\btext-fg2\b/);
  });

  it("presents device Personal as Local in a full-width nav row", () => {
    const switcher = source(
      "apps/desktop/src/renderer/features/team/organization-switcher.tsx",
    );
    expect(switcher).toContain(
      'export const LOCAL_ORGANIZATION_LABEL = "Local";',
    );
    expect(switcher).toContain("<LaptopMinimal strokeWidth={1.5} />");
    // Step 2: 32px tall, only as wide as the name and its arrow.
    expect(switcher).toMatch(/\bh-8 w-fit max-w-full min-w-0\b/);
    expect(switcher).toContain(
      '<span className="min-w-0 truncate text-left">{label}</span>',
    );
    expect(switcher).toContain(
      '<ChevronDown className="size-3!" strokeWidth={1.5} />',
    );
    expect(switcher).not.toContain("ExternalLink");
    expect(
      switcher.match(/<ArrowUpRight className="text-fg3 ml-auto" \/>/g),
    ).toHaveLength(2);
  });
});

describe("sidebar repository headers", () => {
  it("keep the logo and put the arrow at the right end, after the actions", () => {
    expect(HEADER).not.toMatch(/group-hover\/repo:invisible/);
    expect(HEADER).toContain("<RepositoryIcon project={project} className={REPOSITORY_ICON_CHIP_CLS} />");
    const arrow = HEADER.indexOf("data-sidebar-header-arrow");
    expect(arrow).toBeGreaterThan(HEADER.indexOf("aria-label={`Create workspace in ${project.name}`}"));
    expect(HEADER).toContain("<ChevronDown");
    expect(HEADER).toContain("<ChevronRight");
    expect(HEADER).toContain("aria-expanded={!collapsed}");
    expect(HEADER).toContain('<span className="text-fg3 shrink-0 font-normal tabular-nums">{count}</span>');
  });

  it("reveal settings, ⋯ and + before the arrow on hover or while the menu is open", () => {
    // Overlaid on a fade instead of toggling display, so the name never
    // re-truncates under the pointer; the fade stays click-through.
    expect(classConstant(HEADER, "REPOSITORY_HOVER_ACTIONS_CLS")).toMatch(
      /^pointer-events-none absolute inset-y-0 right-full\b[^"]*\bopacity-0\b/,
    );
    expect(HEADER).toMatch(
      /menuOpen\s*\?\s*"opacity-100 \[&_button\]:pointer-events-auto"\s*:\s*"group-hover\/repo:opacity-100 group-hover\/repo:\[&_button\]:pointer-events-auto group-has-focus-visible\/repo:opacity-100 group-has-focus-visible\/repo:\[&_button\]:pointer-events-auto"/,
    );
    expect(HEADER).not.toContain("hidden group-hover/repo:flex");
    const actions = HEADER.slice(HEADER.indexOf("REPOSITORY_HOVER_ACTIONS_CLS,"));
    const plus = actions.indexOf(
      "aria-label={`Create workspace in ${project.name}`}",
    );
    const menuEnd = actions.indexOf("</DropdownMenu>");
    expect(plus).toBeGreaterThan(menuEnd);
  });

  it("offer the requested repository actions and no Hide repository", () => {
    const menu = between(
      HEADER,
      "<DropdownMenuContent",
      "</DropdownMenuContent>",
    );
    const labels = [...menu.matchAll(/<span>([^<]+)<\/span>/g)].map(
      (match) => match[1],
    );
    expect(labels).toEqual([
      "Create workspace",
      "Create from…",
      "Configuration",
      "Remove repository",
    ]);
    expect(HEADER).not.toMatch(/Hide repository/);
    expect(menu).toContain("requestCreateFromSource(project.id);");
    expect(menu).toContain('variant="destructive"');
    expect(menu).not.toContain("text-red-text");
  });

  it("share the Paths section's removal flow instead of duplicating it", () => {
    expect(HEADER).toContain(
      'import { RemoveRepositoryDialog } from "../features/repositories/repositories-panel";',
    );
    const panel = source(
      "apps/desktop/src/renderer/features/repositories/repositories-panel.tsx",
    );
    expect(panel).toContain("export function RemoveRepositoryDialog(");
    expect(panel).toContain("forgetRepositoryCollapsed(project.id);");
  });
});
