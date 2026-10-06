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
      /ref=\{titleBandRef\}\s*className="flex h-10 shrink-0/,
    );
    expect(SIDEBAR).toMatch(
      /<div className=\{TRAFFIC_LIGHT_RESERVE_CLS\} aria-hidden="true" \/>\s*<SidebarToggleButton collapsed=\{false\} \/>/,
    );
    expect(SIDEBAR).toContain("useCustomWindowDrag(titleBandRef)");
    const settings = source(
      "apps/desktop/src/renderer/features/settings/settings-page.tsx",
    );
    expect(settings).toContain("useCustomWindowDrag(titleBandRef)");
    expect(settings).toMatch(
      /ref=\{titleBandRef\}\s*className="h-10 shrink-0"/,
    );
  });

  it("offers Home and Customize as destinations and Create as an action", () => {
    const nav = between(
      SIDEBAR,
      "<OrganizationSwitcher",
      'className="group/section',
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
    expect(nav).toContain("openDispatcher(contextProject?.id)");
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
      "ref={titleBandRef}",
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
      /^h-7 w-7 shrink-0 rounded-md text-fg2 hover:bg-sidebar-bg-hover hover:text-fg1 /,
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
  it("offers only Grouped and Ungrouped, with no repository-only filters", () => {
    expect(MODEL).toMatch(
      /SIDEBAR_WORKSPACE_LIST_FILTERS[^=]*=\s*\[\s*"grouped",\s*"ungrouped",?\s*\]/,
    );
    const menu = between(
      SIDEBAR,
      'aria-label="Filter workspaces"',
      "</DropdownMenu>",
    );
    expect(menu).toContain("SIDEBAR_WORKSPACE_LIST_FILTERS.map(");
    expect(menu).not.toContain("repositoryWorkspaceListFilter");
    expect(menu).not.toContain('"active"');
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

  it("uses repository icons and a trailing agent state in the mixed list", () => {
    const row = between(
      ROW,
      "export function SidebarWorkspaceRow(",
      "/** Placeholder row",
    );
    expect(row).toContain("<WorkspaceProjectIcon project={project} />");
    expect(row).toContain("trailingAgentState");
    // Any chat's activity, where a turn parked on the user rests.
    expect(row).toContain("useAnyChatWorkingActivity");
    expect(SIDEBAR).toContain("mixedRepositories={!groupedList}");
  });

  // Ungrouped rows spend the leading glyph on repository identity, and design
  // workspaces carry the same colour-word branch names code ones do — so the
  // PenTool relocates to the trailing cluster in BOTH row variants, so the
  // pending → confirmed swap neither drops nor re-adds it.
  it("relocates the design marker instead of dropping it in the mixed list", () => {
    const confirmed = between(
      ROW,
      "export function SidebarWorkspaceRow(",
      "/** Placeholder row",
    );
    const pending = ROW.slice(
      ROW.indexOf("export function PendingSidebarWorkspaceRow("),
    );
    for (const variant of [confirmed, pending]) {
      expect(variant).toContain("trailingDesignMark");
      expect(variant).toMatch(
        /trailingDesignMark[\s\S]{0,200}?<PenTool className="size-3\.5"/,
      );
    }
  });
});

describe("sidebar workspace rows", () => {
  it("fill the sidebar width with the shared hover and selection fill", () => {
    const cls = classConstant(ROW, "SIDEBAR_WORKSPACE_ROW_CLS");
    expect(cls).toMatch(/\bw-full\b/);
    expect(cls).toMatch(/\bh-7\.5\b/);
    expect(cls).toContain("hover:bg-(--surface-hover)");
    expect(cls).toContain("focus-within:bg-(--surface-hover)");
    expect(cls).toContain("data-[active=true]:bg-(--surface-hover)");
    expect(cls).toMatch(/data-\[active=true\]:text-fg1\b/);
    expect(SIDEBAR).toMatch(/<Surface\s+as="nav"\s+kind="sidebar"/);
    const surface = source(
      "apps/desktop/src/renderer/shared/ui/layout/surface.tsx",
    );
    expect(surface).toMatch(
      /sidebar:\s*"bg-sidebar-bg \[--surface-hover:var\(--sidebar-bg-hover\)\]/,
    );
  });

  it("keep the draft pencil at the row's end with Archive in its slot", () => {
    const row = between(
      ROW,
      "export function SidebarWorkspaceRow(",
      "/** Placeholder row",
    );
    // The slot holds the pencil, or a flat row's awaiting mark, which
    // outranks it (awaiting-mark-placement.test.ts).
    expect(row).toMatch(
      /<RunStream[\s\S]*?\{trailingMark && \([\s\S]*?<ComposerDraftIndicator \/>[\s\S]*?\{rowAction\}\s*<\/span>/,
    );
    expect(row).toContain("{!trailingMark && rowAction}");
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
      const handler = between(row, `${event}={() => {`, "}}");
      expect(handler).toContain("if (!surfaceActive) return;");
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
      /ref=\{titleBandRef\}\s*className="flex h-10 shrink-0 items-center gap-1/,
    );
    expect(TOGGLE).toContain("aria-controls={APP_SIDEBAR_ID}");
    expect(SIDEBAR).toContain("id={APP_SIDEBAR_ID}");
  });

  it("floors the sidebar at the width its title band controls need", () => {
    expect(SIDEBAR).toContain(
      `"relative flex min-w-[${HOME_SIDEBAR_MIN_PX}px] shrink-0"`,
    );
  });

  it("keeps the corner the collapsed controls float over clear", () => {
    expect(SHELL).toContain(
      "const collapsedControlsVisible = sidebarCollapsed && !settingsActive;",
    );
    expect(SHELL).toContain(
      "{collapsedControlsVisible && <CollapsedSidebarControls />}",
    );
    expect(SHELL).toContain('collapsedControlsVisible ? "mt-10" : ""');
    expect(SHELL).toContain("windowControlsInset={sidebarCollapsed}");
    // 8px leading-slot gutter + 108px spacer = the collapsed band's 116px.
    expect(PANE).toMatch(
      /windowControlsInset \? \(\s*<span\s*className="block h-full w-\[108px\] shrink-0"/,
    );
  });

  it("uses 30px rows and 2px gaps, with a quiet section header", () => {
    const entry = classConstant(SIDEBAR, "SIDEBAR_ENTRY_CLS");
    expect(entry).toMatch(/\bh-7\.5\b/);
    expect(classConstant(HEADER, "REPOSITORY_HEADER_CLS")).toMatch(
      /\bh-7\.5\b/,
    );
    expect(SIDEBAR).toContain('<div className="flex flex-col gap-0.5">');
    expect(SIDEBAR).toContain('className="flex flex-col gap-0.5 empty:hidden"');
    const section = SIDEBAR.slice(
      SIDEBAR.indexOf('className="group/section'),
      SIDEBAR.indexOf(
        "Workspaces\n",
        SIDEBAR.indexOf('className="group/section'),
      ),
    );
    expect(section).not.toContain("hover:bg-");
    expect(classConstant(SIDEBAR, "SECTION_LABEL_CLS")).toMatch(
      /\btext-3xxs\b[^"]*\btext-fg2\b|\btext-fg2\b[^"]*\btext-3xxs\b/,
    );
  });
});

describe("sidebar typography and colour", () => {
  it("sets every row label at 13px", () => {
    for (const cls of [
      classConstant(SIDEBAR, "SIDEBAR_ENTRY_CLS"),
      classConstant(ROW, "SIDEBAR_WORKSPACE_ROW_CLS"),
      classConstant(HEADER, "REPOSITORY_TOGGLE_CLS"),
    ]) {
      expect(cls).toMatch(/\btext-xs\b/);
      expect(cls).not.toMatch(/\btext-sm\b/);
    }
  });

  it("keeps repository names and workspace glyphs on fg2", () => {
    const header = classConstant(HEADER, "REPOSITORY_HEADER_CLS");
    expect(header).toMatch(/\btext-fg2\b/);
    expect(header).not.toMatch(/\btext-fg1\b/);
    expect(header).not.toContain("has-[:focus-visible]:bg-");
    expect(classConstant(ROW, "GLYPH_BOX_CLS")).toMatch(/\btext-fg2\b/);
  });

  it("presents device Personal as Local, sized to its name", () => {
    const switcher = source(
      "apps/desktop/src/renderer/features/team/organization-switcher.tsx",
    );
    expect(switcher).toContain(
      'export const LOCAL_ORGANIZATION_LABEL = "Local";',
    );
    expect(switcher).toContain("<LaptopMinimal strokeWidth={1.5} />");
    expect(switcher).toMatch(/\bw-fit max-w-full min-w-0\b/);
    expect(switcher).toContain(
      '<span className="min-w-0 truncate text-left">{label}</span>',
    );
    expect(switcher).toContain(
      '<ChevronDown className="size-3" strokeWidth={1.5} />',
    );
    expect(switcher).not.toContain("ExternalLink");
    expect(
      switcher.match(/<ArrowUpRight className="text-muted-fg ml-auto" \/>/g),
    ).toHaveLength(2);
  });
});

describe("sidebar repository headers", () => {
  it("swap the repository icon for the disclosure chevron on hover", () => {
    expect(HEADER).toMatch(/group-hover\/repo:invisible/);
    expect(HEADER).toMatch(
      /group-hover\/repo:flex group-focus-visible\/toggle:flex/,
    );
    expect(HEADER).toContain("<ChevronDown");
    expect(HEADER).toContain("<ChevronRight");
    expect(HEADER).toContain("aria-expanded={!collapsed}");
  });

  it("keep + visible and reveal settings and ⋯ on hover or while the menu is open", () => {
    expect(HEADER).toMatch(
      /menuOpen\s*\?\s*"flex"\s*:\s*"hidden group-hover\/repo:flex group-has-\[:focus-visible\]\/repo:flex"/,
    );
    const actions = HEADER.slice(HEADER.indexOf('"items-center gap-0.5"'));
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
    expect(menu).toContain(
      'className="text-red-primary focus:text-red-primary"',
    );
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
