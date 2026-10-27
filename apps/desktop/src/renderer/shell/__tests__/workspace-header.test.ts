import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import type { Project } from "../../state/projects-store";
import type { RepoBranchCatalog } from "../../platform/git";
import { createBranchCatalogCache } from "../../state/read-caches";

const state = vi.hoisted(() => ({
  documents: {} as Record<string, CloudWorkspaceDocument>, reads: [] as string[], activePage: "workspace",
  projects: {} as Record<string, Project>,
}));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 1 }));
vi.mock("../../state/cloud-workspace-catalog", () => ({
  cloudCatalogGeneration: () => 2, subscribeCloudWorkspaces: () => () => {},
  cloudWorkspaceDocument: (target: { organizationId: string; workspaceId: string }) => {
    const key = `cloud://${target.organizationId}/${target.workspaceId}`;
    state.reads.push(key); return state.documents[key];
  },
}));
vi.mock("../../state/use-active-workspace", () => ({ useActiveWorkspace: () => ({ workspace: null, folder: null }) }));
vi.mock("../../state/use-projects", () => ({ useProjectForFolder: (folder: string) => state.projects[folder] ?? null }));
vi.mock("../../state/workspace-store", () => ({ useWorkspaceStore: (select: (value: typeof state) => unknown) => select(state) }));
vi.mock("../workspace-tabs", () => ({ workspaceLabel: () => "Local branch" }));
vi.mock("../conversation/cloud-workspace-details", () => ({ CloudWorkspaceDetails: ({ folder }: { folder: string }) => createElement("button", { "aria-label": "Cloud workspace details", "data-folder": folder }) }));
vi.mock("../conversation/cloud-workspace-sharing-controls", () => ({ CloudWorkspaceSharePopover: () => createElement("button", { "aria-label": "Share workspace" }, "Share") }));
vi.mock("../conversation/cloud-workspace-ports-popover", () => ({ CloudWorkspacePortsPopover: () => createElement("button", { "aria-label": "Port forwarding" }) }));
import { TooltipProvider } from "../../shared/ui/primitives";
import { WorkspaceHeader } from "../conversation/workspace-header";

const first = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const second = "cloud://33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444";
const render = (props: Partial<Parameters<typeof WorkspaceHeader>[0]> = {}) => renderToStaticMarkup(createElement(TooltipProvider, {
  children: createElement(WorkspaceHeader, { folder: first, name: "Engine branch", trailing: createElement("button", { "aria-label": "Summary" }), ...props }),
}));
beforeEach(() => {
  createBranchCatalogCache.clear();
  state.documents = { [first]: { name: "Cloud feature" } as CloudWorkspaceDocument,
    [second]: { name: "Other organization" } as CloudWorkspaceDocument };
  state.reads = []; state.activePage = "workspace";
  state.projects = Object.fromEntries(["/local/personal", "/organizations/example/local"].map(folder => [folder, {
    id: folder, repoRoot: folder, name: "Repository", repoSlug: "example/repo",
    originUrl: "https://github.com/example/repo.git", isGitRepository: true, addedAt: 0,
  }]));
});
describe("workspace column header", () => {
  it.each(["/local/personal", "/organizations/example/local"])("keeps %s independent of cloud metadata and controls", folder => {
    const html = render({ folder, name: "Local feature", branch: true });
    expect(html).toContain("Local feature"); expect(html).toContain("lucide-git-branch");
    expect(html).toContain('aria-label="Summary"');
    expect(html).not.toContain("Cloud workspace details"); expect(html).not.toContain("Share workspace");
    expect(html).not.toContain("Port forwarding"); expect(state.reads).toEqual([]);
  });
  it.each(["/local/personal", "/organizations/example/local"])("labels unpublished Git in %s as Local before the workspace name", folder => {
    state.projects[folder].originUrl = null;
    const html = render({ folder, name: "Unpublished feature", branch: true });
    expect(html).toContain("lucide-hard-drive");
    expect(html).toContain(">Local<");
    expect(html.indexOf(">Local<")).toBeLessThan(html.indexOf("Unpublished feature"));
    expect(html).not.toContain("lucide-git-branch");
    expect(html).toContain('aria-label="Summary"');
    expect(state.reads).toEqual([]);
  });
  it("keeps plain folders and repositories on other hosts distinct from unpublished Git", () => {
    const folder = "/local/personal";
    state.projects[folder].originUrl = null;
    state.projects[folder].isGitRepository = false;
    expect(render({ folder })).toContain("lucide-folder");
    expect(render({ folder })).not.toContain(">Local<");
    state.projects[folder].isGitRepository = true;
    state.projects[folder].originUrl = "https://gitlab.com/example/repo.git";
    expect(render({ folder, branch: true })).toContain("lucide-git-branch");
    expect(render({ folder, branch: true })).not.toContain(">Local<");
  });
  it("uses exact project metadata through publication and Local/cloud/Local switches", () => {
    const folder = "/local/personal";
    state.projects[folder].originUrl = null;
    expect(render({ folder, branch: true })).toContain(">Local<");
    expect(render({ folder: "/organizations/example/local", branch: true })).not.toContain(">Local<");
    expect(render()).toContain("Cloud workspace details");
    expect(render()).not.toContain(">Local<");
    expect(render({ folder, branch: true })).toContain(">Local<");
    state.projects[folder].originUrl = "git@github.com:example/repo.git";
    expect(render({ folder, branch: true })).toContain("lucide-git-branch");
    expect(render({ folder, branch: true })).not.toContain(">Local<");
  });
  it("does not label a configured GitHub remote as Local just because it is not named origin", () => {
    const folder = "/local/personal";
    state.projects[folder].originUrl = null;
    createBranchCatalogCache.setData(JSON.stringify([folder, null]), {
      effectiveRemote: "upstream",
      remotes: [{ name: "upstream", url: "git@github.com:example/repo.git", isGitHub: true }],
    } as RepoBranchCatalog);
    const html = render({ folder, branch: true });
    expect(html).toContain("lucide-git-branch");
    expect(html).not.toContain(">Local<");
    createBranchCatalogCache.invalidate(JSON.stringify([folder, null]));
    createBranchCatalogCache.setError(JSON.stringify([folder, null]), new Error("Engine disconnected"));
    expect(render({ folder, branch: true })).toContain("lucide-git-branch");
    state.projects["/organizations/example/local"].originUrl = null;
    expect(render({ folder: "/organizations/example/local", branch: true })).toContain(">Local<");
  });
  it("uses cloud metadata and renders the column actions once", () => {
    const html = render();
    expect(html).toContain("Cloud feature"); expect(html).not.toContain("Engine branch");
    for (const label of ["Workspace header", "Cloud workspace details", "Summary"])
      expect(html.match(new RegExp(`aria-label="${label}"`, "g"))).toHaveLength(1);
    expect(html).toContain(`data-folder="${first}"`);
  });
  it("selects the exact owner on cloud to Local to another cloud transitions", () => {
    expect(render()).toContain("Cloud feature");
    expect(render({ folder: "/local/personal", name: "Offline local" })).toContain("Offline local");
    const other = render({ folder: second });
    expect(other).toContain("Other organization"); expect(other).not.toContain("Cloud feature");
    expect(state.reads).toEqual([first, second]);
  });
  it("retains placement metadata while hiding writable and Summary actions for read-only history", () => {
    const html = render({ readOnly: true });
    expect(html).toContain("Cloud workspace details"); expect(html).not.toContain("Share workspace");
    expect(html).not.toContain("Summary"); expect(html).not.toContain("Port forwarding");
  });
  it("reserves native window controls only in the column header", () => {
    expect(render({ windowControlsInset: true })).toContain("data-window-controls-reserve");
    expect(render()).not.toContain("data-window-controls-reserve");
  });
});
