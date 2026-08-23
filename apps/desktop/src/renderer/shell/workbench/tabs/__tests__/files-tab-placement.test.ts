import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

describe("Files tab explorer placement", () => {
  const filesTab = read("../files-tab.tsx");
  const fileViewer = read("../file-viewer.tsx");

  it("keeps one full-width viewer header above the shared right sidebar", () => {
    expect(fileViewer).toContain("bodyTrailing?: React.ReactNode");
    expect(fileViewer).toContain("headerBorder?: boolean");
    expect(fileViewer).toMatch(
      /data-testid="files-viewer-header"[\s\S]*?headerBorder && "border-border1 border-b"/,
    );
    expect(filesTab).toMatch(/<FileViewer[\s\S]*?\sheaderBorder\s/);
    expect(filesTab).toMatch(
      /data-testid="files-tree-header"\s*className="[^"]*\bborder-b\b[^"]*"/,
    );
    expect(fileViewer).toContain('data-testid="files-viewer-body"');
    expect(fileViewer).toMatch(
      /data-testid="files-viewer-body"[\s\S]*\{bodyTrailing\}/,
    );

    const bodyTrailingStart = filesTab.indexOf("bodyTrailing={");
    const bodyTrailing = filesTab.slice(
      bodyTrailingStart,
      filesTab.indexOf("onViewerModeChange=", bodyTrailingStart),
    );
    expect(bodyTrailingStart).toBeGreaterThan(-1);
    expect(
      bodyTrailing.indexOf('data-testid="files-sidebar-seam"'),
    ).toBeGreaterThan(-1);
    expect(bodyTrailing.indexOf("{sidebarPane}")).toBeGreaterThan(
      bodyTrailing.indexOf('data-testid="files-sidebar-seam"'),
    );
    expect(filesTab).toMatch(
      /useSidebarResizeDrag\(\s*containerRef,\s*sidebarRef,\s*"right",\s*\)/,
    );
  });

  it("keeps all three mutually exclusive sidebar actions in the trailing header", () => {
    const headerTrailingStart = filesTab.indexOf("headerTrailing={");
    const headerTrailing = filesTab.slice(
      headerTrailingStart,
      filesTab.indexOf("bodyTrailing={", headerTrailingStart),
    );
    expect(headerTrailing).toContain("headerTrailing={sidebarActions}");

    const sidebarActionsStart = filesTab.indexOf("const sidebarActions");
    const sidebarActions = filesTab.slice(
      sidebarActionsStart,
      filesTab.indexOf("const sidebarPane", sidebarActionsStart),
    );
    expect(sidebarActions.indexOf("{directoriesTrigger}")).toBeLessThan(
      sidebarActions.indexOf("{searchTrigger}"),
    );
    expect(sidebarActions.indexOf("{searchTrigger}")).toBeLessThan(
      sidebarActions.indexOf("{treeToggle}"),
    );

    const treeToggleStart = filesTab.indexOf("const treeToggle");
    const treeToggle = filesTab.slice(
      treeToggleStart,
      filesTab.indexOf("const searchTrigger", treeToggleStart),
    );
    expect(treeToggle).toContain('aria-pressed={sidebarMode === "tree"}');

    expect(filesTab).toContain('toggleSidebarMode("tree")');
    expect(filesTab).toContain('toggleSidebarMode("search")');
    expect(filesTab).toContain('toggleSidebarMode("directories")');
    expect(filesTab.match(/ref=\{sidebarRef\}/g)).toHaveLength(1);
  });

  it("uses a same-size search column that stays empty until a query exists", () => {
    const searchSidebar = read("../files-search-sidebar.tsx");
    expect(searchSidebar).toContain('data-testid="files-search-sidebar"');
    expect(searchSidebar).toMatch(
      /search\.trim\(\)\s*&&\s*\([\s\S]*<WorkspaceFileTree/,
    );
    expect(searchSidebar).not.toContain("Popover");
    expect(searchSidebar).not.toContain('role="dialog"');
  });

  it("renders directory bulk actions directly below its search field", () => {
    const directories = read("../working-directories-panel.tsx");
    const input = directories.indexOf("<CommandInput");
    const actions = directories.indexOf(
      'data-testid="working-directories-actions"',
    );
    const list = directories.indexOf("<CommandList");
    expect(directories).toContain("export function WorkingDirectoriesPanel");
    expect(directories).not.toContain("<Popover");
    expect(input).toBeGreaterThan(-1);
    expect(actions).toBeGreaterThan(input);
    expect(list).toBeGreaterThan(actions);
    expect(directories).toContain('data-testid="working-directories-panel"');
  });

  it("mounts Working folders from shared server state and warms it on intent", () => {
    const directories = read("../working-directories-panel.tsx");
    expect(directories).toContain("useCachedRead(");
    expect(directories).toContain("workingDirectoriesCache");
    expect(directories).toContain("enabled: active");
    expect(directories).not.toMatch(
      /useEffect\([\s\S]{0,900}listWorkingDirectories/,
    );

    expect(filesTab).toContain("prefetchWorkingDirectories");
    expect(filesTab).toContain("onPointerEnter={warmWorkingDirectories}");
    expect(filesTab).toContain("onFocus={warmWorkingDirectories}");
    expect(filesTab).toMatch(
      /<WorkingDirectoriesPanel[\s\S]{0,180}active=\{active\}/,
    );
  });

  it("places Copy in the path cluster instead of the far-right controls", () => {
    const pathActionsStart = fileViewer.indexOf(
      'data-testid="file-path-actions"',
    );
    const pathActions = fileViewer.slice(
      pathActionsStart,
      fileViewer.indexOf("</div>", pathActionsStart),
    );
    const trailingStart = fileViewer.indexOf(
      '<div className="flex shrink-0 items-center gap-1">',
      pathActionsStart,
    );
    const trailing = fileViewer.slice(
      trailingStart,
      fileViewer.indexOf("{headerTrailing}", trailingStart),
    );
    expect(pathActionsStart).toBeGreaterThan(-1);
    expect(pathActions).toContain("<CodeBlockCopyButton");
    expect(trailing).not.toContain("<CodeBlockCopyButton");
  });
});
