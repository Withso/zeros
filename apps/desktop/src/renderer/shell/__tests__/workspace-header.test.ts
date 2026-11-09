import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import type { Project } from "../../state/projects-store";
import type { RepoBranchCatalog, Workspace } from "../../platform/git";
import { createBranchCatalogCache } from "../../state/read-caches";

const state = vi.hoisted(() => ({
  documents: {} as Record<string, CloudWorkspaceDocument>, reads: [] as string[], activePage: "workspace",
  projects: {} as Record<string, Project>, cloudAccess: true,
}));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 1 }));
vi.mock("../../features/team/cloud-workspace-account-access", () => ({ useCloudWorkspaceAccountAccess: () => state.cloudAccess }));
vi.mock("../conversation/use-cloud-workspace-surface", () => ({ useCloudWorkspaceSurfaceActive: (active: boolean) => active }));
vi.mock("../../state/cloud-workspace-catalog", () => ({
  cloudCatalogGeneration: () => 2, subscribeCloudWorkspaces: () => () => {}, manageCloudWorkspace: async () => {},
  cloudWorkspaceDocument: (target: { organizationId: string; workspaceId: string }) => {
    const key = `cloud://${target.organizationId}/${target.workspaceId}`;
    state.reads.push(key); return state.documents[key];
  },
}));
vi.mock("../../state/use-active-workspace", () => ({ useActiveWorkspace: () => ({ workspace: null, folder: null }) }));
vi.mock("../../state/use-projects", () => ({ useProjectForFolder: (folder: string) => state.projects[folder] ?? null }));
vi.mock("../../state/workspace-store", () => ({ useWorkspaceStore: (select: (value: typeof state) => unknown) => select(state) }));
vi.mock("../workspace-tabs", () => ({ workspaceLabel: () => "Local branch" }));
import { TooltipProvider } from "../../shared/ui/primitives";
import { WorkspaceHeader, workspaceHeaderBranch } from "../conversation/workspace-header";
import { LocalWorkspaceDetailsCard, displayFolderPath } from "../conversation/local-workspace-details";

const first = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const second = "cloud://33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444";
const local = "/local/personal";
const organizationLocal = "/organizations/example/local";
const provided = (children: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(TooltipProvider, { children }));
const render = (props: Partial<Parameters<typeof WorkspaceHeader>[0]> = {}) => provided(
  createElement(WorkspaceHeader, { folder: first, name: "Engine branch", trailing: createElement("button", { "aria-label": "Summary" }), ...props }),
);
/** The header's one name-and-placement element: its tag, classes and markup. */
function identity(html: string) {
  const open = html.match(/<(button|span)\b[^>]*data-workspace-identity=""[^>]*>/);
  expect(open, "workspace identity").not.toBeNull();
  const [tag, start] = [open![1], open!.index!];
  const end = html.indexOf(`</${tag}>`, html.indexOf("data-workspace-placement", start));
  return { tag, opening: open![0], className: /class="([^"]*)"/.exec(open![0])?.[1] ?? "", html: html.slice(start, end) };
}
/** The header row's markup, which must not draw a closed popup's glyphs. */
const row = (html: string) => html.match(/<div[^>]*data-workspace-header=""[\s\S]*$/)?.[0] ?? "";
beforeEach(() => {
  createBranchCatalogCache.clear();
  const document = (name: string) => ({
    name, status: "ready", createdAt: "2026-11-01T00:00:00Z",
    repository: { forge: "github.com", owner: "example", name: "repo", revision: "refs/heads/main" },
    capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
  }) as CloudWorkspaceDocument;
  state.documents = { [first]: document("Cloud feature"), [second]: document("Other organization") };
  state.reads = []; state.activePage = "workspace"; state.cloudAccess = true;
  state.projects = Object.fromEntries([local, organizationLocal].map(folder => [folder, {
    id: folder, repoRoot: folder, name: "Repository", repoSlug: "example/repo",
    originUrl: "https://github.com/example/repo.git", isGitRepository: true, addedAt: 0,
  }]));
});
describe("workspace column header", () => {
  it.each([null, local, organizationLocal, first, second])(
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
    for (const folder of [local, first, organizationLocal, second, local]) {
      expect(render({ folder })).toContain('data-tauri-drag-region=""');
    }
  });
  it.each([local, organizationLocal])("keeps %s independent of cloud metadata and controls", folder => {
    const html = render({ folder, name: "Local feature", branch: "alex/local-feature" });
    expect(html).toContain("Local feature"); expect(identity(html).html).toContain("lucide-laptop");
    expect(html).toContain('aria-label="Summary"');
    expect(html).not.toContain("Cloud workspace"); expect(html).not.toContain("lucide-cloud");
    expect(html).not.toContain("Share workspace"); expect(html).not.toContain("Port forwarding");
    expect(state.reads).toEqual([]);
  });
  // 2026-11-09 direction: the name comes first and where the workspace lives
  // after it, as one ghost control that opens the workspace's details. It has
  // no fill at rest, only on hover and while its details are open.
  it.each([[local, "local", "lucide-laptop"], [organizationLocal, "local", "lucide-laptop"],
    [first, "cloud", "lucide-cloud"], [second, "cloud", "lucide-cloud"]] as const)(
    "puts the %s name first and its %s icon after it, in one ghost control",
    (folder, placement, glyph) => {
      const control = identity(render({ folder, name: "Feature", branch: "alex/feature" }));
      expect(control.tag).toBe("button");
      expect(control.opening).toContain('aria-haspopup="dialog"');
      const name = control.html.indexOf("data-workspace-name");
      expect(name).toBeGreaterThan(0);
      expect(name).toBeLessThan(control.html.indexOf(`data-workspace-placement="${placement}"`));
      expect(control.html).toContain(glyph);
      const classes = control.className.split(/\s+/);
      expect(classes.filter(cls => /^bg-/.test(cls))).toEqual([]);
      // A Tooltip around a popover trigger stamps its own data-state, so the
      // open fill keys off aria-expanded, which only the popover sets.
      expect(classes).toEqual(expect.arrayContaining(["hover:bg-bg2-highlight", "aria-expanded:bg-bg2-highlight"]));
    },
  );
  it("names the control by its visible name and placement", () => {
    expect(identity(render({ folder: local, name: "alex/fix-login" })).opening).toContain('aria-label="alex/fix-login, Local workspace"');
    expect(identity(render()).opening).toContain('aria-label="Cloud feature, Cloud workspace"');
  });
  it.each([local, organizationLocal])("gives every Local workspace in %s the laptop: branch, unpublished, plain folder", folder => {
    const laptopOnly = (html: string) => identity(html).html.includes("lucide-laptop") &&
      !/lucide-(?:git-branch|folder|hard-drive|cloud)\b/.test(row(html)) && !html.includes(">Local<");
    expect(laptopOnly(render({ folder, branch: "alex/published" }))).toBe(true);
    state.projects[folder].originUrl = null;
    expect(laptopOnly(render({ folder, branch: "alex/unpublished" }))).toBe(true);
    state.projects[folder].isGitRepository = false;
    expect(laptopOnly(render({ folder, name: "marketing-site" }))).toBe(true);
  });
  it("shows the same laptop whatever the remote, through publication and Local/cloud/Local switches", () => {
    const laptopOnly = (html: string) => identity(html).html.includes("lucide-laptop") && !/lucide-(?:git-branch|cloud)\b/.test(row(html));
    state.projects[local].originUrl = null;
    expect(laptopOnly(render({ folder: local, branch: "alex/a" }))).toBe(true);
    expect(identity(render()).html).toContain("lucide-cloud");
    expect(laptopOnly(render({ folder: organizationLocal, branch: "alex/a" }))).toBe(true);
    createBranchCatalogCache.setData(JSON.stringify([local, null]), {
      effectiveRemote: "upstream",
      remotes: [{ name: "upstream", url: "git@github.com:example/repo.git", isGitHub: true }],
    } as RepoBranchCatalog);
    expect(laptopOnly(render({ folder: local, branch: "alex/a" }))).toBe(true);
    createBranchCatalogCache.invalidate(JSON.stringify([local, null]));
    createBranchCatalogCache.setError(JSON.stringify([local, null]), new Error("Engine disconnected"));
    expect(laptopOnly(render({ folder: local, branch: "alex/a" }))).toBe(true);
    state.projects[local].originUrl = "https://gitlab.com/example/repo.git";
    expect(laptopOnly(render({ folder: local, branch: "alex/a" }))).toBe(true);
  });
  it("keeps the name and its laptop, with nothing to open, when there is no folder", () => {
    const control = identity(render({ folder: null, name: "Workspace" }));
    expect(control.tag).toBe("span");
    expect(control.html).toContain("Workspace"); expect(control.html).toContain("lucide-laptop");
    expect(control.opening).not.toContain("aria-haspopup");
  });
  it.each([null, local, organizationLocal, first])("draws no divider under the %s header row", folder => {
    const header = render({ folder, branch: "alex/a" }).match(/<div[^>]*data-workspace-header=""[^>]*>/)?.[0] ?? "";
    expect(header).toContain("h-10");
    expect(header).not.toMatch(/\bborder-b\b/);
    expect(header).not.toContain("border-border1");
  });
  it("uses cloud metadata and renders the column actions once", () => {
    const html = render();
    expect(identity(html).html).toContain("Cloud feature"); expect(html).not.toContain("Engine branch");
    for (const label of ["Workspace header", "Cloud feature, Cloud workspace", "Summary"])
      expect(html.match(new RegExp(`aria-label="${label}"`, "g"))).toHaveLength(1);
    expect(html.match(/data-workspace-identity=""/g)).toHaveLength(1);
  });
  it("selects the exact owner on cloud to Local to another cloud transitions", () => {
    expect(render()).toContain("Cloud feature");
    expect(render({ folder: local, name: "Offline local" })).toContain("Offline local");
    const other = render({ folder: second });
    expect(other).toContain("Other organization"); expect(other).not.toContain("Cloud feature");
    expect(state.reads).toEqual([first, second]);
  });
  it("keeps a cloud workspace's name and cloud, with nothing to open, until its account access is confirmed", () => {
    state.cloudAccess = false;
    const control = identity(render());
    expect(control.tag).toBe("span");
    expect(control.html).toContain("Cloud feature"); expect(control.html).toContain("lucide-cloud");
    expect(control.opening).not.toContain("aria-haspopup");
  });
  it("retains placement metadata while hiding writable and Summary actions for read-only history", () => {
    const html = render({ readOnly: true });
    expect(html).toContain('aria-label="Cloud feature, Cloud workspace"'); expect(html).not.toContain("Share workspace");
    expect(html).not.toContain("Summary"); expect(html).not.toContain("Port forwarding");
    expect(identity(render({ folder: local, name: "History", readOnly: true })).tag).toBe("button");
  });
  it("reserves native window controls only in the column header", () => {
    expect(render({ windowControlsInset: true })).toContain("data-window-controls-reserve");
    expect(render()).not.toContain("data-window-controls-reserve");
  });
});

describe("Local workspace details", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, "\n").split("\n").map(line => line.trim()).filter(Boolean);
  it("shows the name, then the branch, then the folder and Local", () => {
    const html = provided(createElement(LocalWorkspaceDetailsCard, {
      name: "fix-login", branch: "alex/fix-login", folder: "/Users/alex/zeros/workspaces/app/fix-login",
    }));
    expect(text(html)).toEqual(["fix-login", "Branch", "alex/fix-login", "Folder", "~/zeros/workspaces/app/fix-login", "Local"]);
    expect(html.indexOf("lucide-git-branch")).toBeLessThan(html.indexOf("alex/fix-login</span>"));
    expect(html.indexOf("lucide-folder")).toBeLessThan(html.indexOf("~/zeros"));
    // The cloud details' title, so both popups read as one.
    expect(html).toContain('class="text-fg1 mb-3 truncate text-xs leading-4.5 font-medium"');
    expect(html).toMatch(/<span class="[^"]*\btext-fg3\b[^"]*">Local<\/span><\/dd>/);
  });
  it("leaves out the branch for a plain folder", () => {
    const html = provided(createElement(LocalWorkspaceDetailsCard, { name: "marketing-site", folder: "/home/sam/marketing-site" }));
    expect(text(html)).toEqual(["marketing-site", "Folder", "~/marketing-site", "Local"]);
    expect(html).not.toContain("lucide-git-branch");
  });
  it("abbreviates the home folder on macOS, Linux and Windows, and nothing else", () => {
    expect(displayFolderPath("/Users/alex/Documents/To-do app")).toBe("~/Documents/To-do app");
    expect(displayFolderPath("/Users/alex")).toBe("~");
    expect(displayFolderPath("/home/user/zeros")).toBe("~/zeros");
    expect(displayFolderPath("C:\\Users\\alex\\code\\app")).toBe("~\\code\\app");
    expect(displayFolderPath("/opt/work/app")).toBe("/opt/work/app");
    expect(displayFolderPath("/Users/Shared/app")).toBe("/Users/Shared/app");
    expect(displayFolderPath("/Volumes/Work/app")).toBe("/Volumes/Work/app");
  });
  it("gives the details a real branch only: none for a synthetic folder row", () => {
    const base = { id: "ws_1", branch: "alex/fix-login", path: "/Users/alex/app" } as Workspace;
    expect(workspaceHeaderBranch(base)).toBe("alex/fix-login");
    expect(workspaceHeaderBranch({ ...base, id: "local:example/app", branch: "app" })).toBeUndefined();
    expect(workspaceHeaderBranch(null)).toBeUndefined();
  });
});
