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

  it("routes the shared launcher into Create and mounts it beside HomeSidebar", () => {
    const provider = source(
      "apps/desktop/src/renderer/shell/add-project-provider.tsx",
    );
    const shell = source("apps/desktop/src/renderer/app-shell.tsx");

    expect(provider).toContain('type: "OPEN_CREATE_PAGE"');
    expect(provider).not.toContain("setDispatcherOpen");
    expect(shell).toContain('activePage === "create"');
    expect(shell).toContain("useRetainedViewKeys(activeHomePageId, 5)");
    expect(shell).toContain("<HomeSidebar />");
    expect(shell).toContain("<DispatcherPage");
    expect(shell).toContain(
      'activePage === "workspace" && !designWorkspaceRequested',
    );
  });
});
