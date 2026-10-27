import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Create Workspace page routing", () => {
  it("renders the dispatcher as page content instead of a dialog", () => {
    const dispatcher = source(
      "apps/desktop/src/renderer/shell/dispatcher/dispatcher-modal.tsx",
    );

    expect(dispatcher).toContain("export function DispatcherPage");
    expect(dispatcher).toContain("<main");
    expect(dispatcher).not.toContain("<Dialog");
    expect(dispatcher).not.toContain("DialogContent");
  });

  it("keeps project and source above the composer without the retired mode toggle", () => {
    const dispatcher = source(
      "apps/desktop/src/renderer/shell/dispatcher/dispatcher-modal.tsx",
    );
    const context = dispatcher.indexOf('data-dispatcher-context=""');
    const card = dispatcher.indexOf("<section");
    const composer = dispatcher.search(/<DispatcherComposer(?:\s|>)/);

    expect(context).toBeGreaterThanOrEqual(0);
    expect(dispatcher).not.toContain("<WorkspaceModeToggleView");
    expect(card).toBeGreaterThan(context);
    expect(composer).toBeGreaterThan(card);
    expect(dispatcher).not.toContain('data-dispatcher-mode-switcher=""');
  });

  it("routes the shared launcher into Create and mounts it beside the app sidebar", () => {
    const provider = source(
      "apps/desktop/src/renderer/shell/add-project-provider.tsx",
    );
    const shell = source("apps/desktop/src/renderer/app-shell.tsx");

    expect(provider).toContain('type: "OPEN_CREATE_PAGE"');
    expect(provider).not.toContain("setDispatcherOpen");
    expect(shell).toContain('activePage === "create"');
    expect(shell).toContain("useRetainedViewKeys(activeHomePageId, 5)");
    expect(shell).toContain(
      "<AppSidebar hidden={settingsActive || sidebarCollapsed} />",
    );
    expect(shell).toContain("<DispatcherPage");
    expect(shell).toContain(
      'useNewTabHotkeys(activePage === "workspace" && workspaceToolsAvailable)',
    );
  });
});
