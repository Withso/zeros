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
  it.each([null, "/local/personal", "/organizations/example/local", first, second])(
    "gives %s native titlebar behavior on its first render",
    folder => {
      for (const readOnly of [false, true]) {
        const html = render({ folder, readOnly, windowControlsInset: true });
        const header = html.match(/<div[^>]*data-workspace-header=""[^>]*>/)?.[0];
        expect(header).toContain('data-tauri-drag-region=""');
        expect(html).toContain("data-window-controls-reserve");
        expect(html.includes('aria-label="Summary"')).toBe(!readOnly);
      }
    },
  );
  it("retains native chrome through Local, organization-local and cloud owner switches", () => {
    for (const folder of ["/local/personal", first, "/organizations/example/local", second, "/local/personal"]) {
      expect(render({ folder })).toContain('data-tauri-drag-region=""');
    }
  });
  it.each(["/local/personal", "/organizations/example/local"])("keeps %s independent of cloud metadata and controls", folder => {
    const html = render({ folder, name: "Local feature", branch: true });
    expect(html).toContain("Local feature"); expect(html).toContain("lucide-git-branch");
    expect(html).toContain('aria-label="Summary"');
    expect(html).not.toContain("Cloud workspace details"); expect(html).not.toContain("Share workspace");
    expect(html).not.toContain("Port forwarding"); expect(state.reads).toEqual([]);
  });
  // 2026-11-06 direction (Zeros Design v378): branch, folder and cloud share
  // one 28px glyph slot so the name always starts at the same column; the
  // unpublished-Git "Local" badge that replaced the glyph is gone.
  const slot = (html: string) => html.match(/<div[^>]*data-workspace-placement=""[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
  it.each(["/local/personal", "/organizations/example/local"])("keeps unpublished Git in %s on the branch glyph, with no Local badge", folder => {
    state.projects[folder].originUrl = null;
    const html = render({ folder, name: "Unpublished feature", branch: true });
    expect(slot(html)).toContain("inline-flex size-7");
    expect(slot(html)).toContain("lucide-git-branch");
    expect(html).not.toContain(">Local<");
    expect(html).not.toContain("lucide-hard-drive");
    expect(html).toContain('aria-label="Summary"');
    expect(state.reads).toEqual([]);
  });
  it("gives a plain folder the folder glyph in the same 28px slot", () => {
    const folder = "/local/personal";
    state.projects[folder].originUrl = null;
    state.projects[folder].isGitRepository = false;
    const html = render({ folder });
    expect(slot(html)).toContain("inline-flex size-7");
    expect(slot(html)).toContain("lucide-folder");
    expect(html).not.toContain(">Local<");
  });
  it("shows the same glyph whatever the remote, through publication and Local/cloud/Local switches", () => {
    const folder = "/local/personal";
    const branchOnly = (html: string) => slot(html).includes("lucide-git-branch") && !html.includes(">Local<") && !html.includes("lucide-hard-drive");
    state.projects[folder].originUrl = null;
    expect(branchOnly(render({ folder, branch: true }))).toBe(true);
    expect(render()).toContain("Cloud workspace details");
    expect(branchOnly(render({ folder: "/organizations/example/local", branch: true }))).toBe(true);
    createBranchCatalogCache.setData(JSON.stringify([folder, null]), {
      effectiveRemote: "upstream",
      remotes: [{ name: "upstream", url: "git@github.com:example/repo.git", isGitHub: true }],
    } as RepoBranchCatalog);
    expect(branchOnly(render({ folder, branch: true }))).toBe(true);
    createBranchCatalogCache.invalidate(JSON.stringify([folder, null]));
    createBranchCatalogCache.setError(JSON.stringify([folder, null]), new Error("Engine disconnected"));
    expect(branchOnly(render({ folder, branch: true }))).toBe(true);
    state.projects[folder].originUrl = "https://gitlab.com/example/repo.git";
    expect(branchOnly(render({ folder, branch: true }))).toBe(true);
    state.projects[folder].originUrl = "git@github.com:example/repo.git";
    expect(branchOnly(render({ folder, branch: true }))).toBe(true);
  });
  it.each([null, "/local/personal", "/organizations/example/local", first])("draws no divider under the %s header row", folder => {
    const header = render({ folder, branch: true }).match(/<div[^>]*data-workspace-header=""[^>]*>/)?.[0] ?? "";
    expect(header).toContain("h-10");
    expect(header).not.toMatch(/\bborder-b\b/);
    expect(header).not.toContain("border-border1");
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
