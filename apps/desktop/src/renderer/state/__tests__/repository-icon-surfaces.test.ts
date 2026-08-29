import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("repository icon surface coverage", () => {
  it("warms all registered repository icons from the mounted app shell", () => {
    const appShell = source("apps/desktop/src/renderer/app-shell.tsx");

    expect(appShell).toContain("useWarmAutomaticRepositoryIcons(projects)");
  });

  it("uses the shared icon in dashboard filters and workspace cards", () => {
    const dashboard = source(
      "apps/desktop/src/renderer/features/dashboard/dashboard-page.tsx",
    );

    expect(dashboard).toContain("<RepositoryIcon project={project}");
    expect(dashboard).toContain("<DashboardRepositoryIcon project={p}");
    expect(dashboard).toMatch(
      /<DashboardRepositoryIcon\s+project=\{row\.project\}/,
    );
    expect(dashboard).not.toMatch(
      /\{projectInitial\((?:p\.name|row\.repoName|repoName)\)\}/,
    );
  });

  it("uses the shared icon in both workspace creation project pickers", () => {
    const dispatcher = source(
      "apps/desktop/src/renderer/shell/dispatcher/dispatcher-modal.tsx",
    );
    const createFromSource = source(
      "apps/desktop/src/renderer/shell/dispatcher/create-from-source.tsx",
    );

    expect(dispatcher).toMatch(/<RepositoryIcon\s+project=\{selectedProject\}/);
    expect(dispatcher).toMatch(/<RepositoryIcon\s+project=\{p\}/);
    expect(dispatcher).not.toMatch(/(?:selectedProject\?\.name|p\.name)\[0\]/);
    expect(createFromSource).toMatch(/<RepositoryIcon\s+project=\{project\}/);
    expect(createFromSource).not.toContain("project.name[0]");
  });

  it("uses the shared icon in the active conversation breadcrumb", () => {
    const header = source(
      "apps/desktop/src/renderer/shell/conversation/conversation-header.tsx",
    );

    expect(header).toMatch(/<RepositoryIcon\s+project=\{project\}/);
    expect(header).not.toContain("function projectInitial(");
  });
});
