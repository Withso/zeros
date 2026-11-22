import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CloudProject } from "../../../platform/cloud-github-levels";
import type { Project } from "../../../state/projects-store";

vi.mock("../ready-copy-section", () => ({ ReadyCopySection: ({ projectId }: { projectId: string }) => createElement("span", null, `ready-copy:${projectId}`) }));
vi.mock("../build-secrets-section", () => ({ BuildSecretsSection: () => createElement("span", null, "build-secrets") }));
vi.mock("../../../shell/add-project-provider", () => ({ useOptionalAddProject: () => ({ openGithubProject: vi.fn() }) }));
import { CloudProjectPage, cloudProjectSharing, cloudProjectSubtitle, macFolderFor } from "../cloud-project-page";

const repository = (name: string, setup: string | null = null, defaultBranch: string | null = "main") => ({
  repository: name, repositoryId: String(name.length), connectionId: null, defaultBranch, setup, setupScript: null, position: 0 });
const project = (patch: Partial<CloudProject> = {}): CloudProject => ({
  id: "88888888-8888-4888-8888-888888888881", name: "Zeros", level: "organization", ownerUserId: null, canEdit: true, canShare: false,
  repositories: [repository("withso/zeros", "pnpm install\npnpm build"), repository("withso/zeros-design-demo")], ...patch });
const folder = (id: string, originUrl: string | null): Project => ({ id, name: id, repoRoot: `/Users/me/${id}`, repoSlug: id, originUrl, addedAt: 1 });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'");
const render = (value: CloudProject, localProjects: Project[] = []) => text(renderToStaticMarkup(createElement(CloudProjectPage, {
  project: value, organization: { id: "11111111-1111-4111-8111-111111111111", name: "Withso" }, userKey: "user", connections: null,
  limits: { personal: 20, repositories: 10 }, localProjects, active: true, onChanged: vi.fn(), onOpenFolder: vi.fn() })));

describe("a cloud project's page", () => {
  it("says who can use it: only you, with Share only where the server says it can succeed, and never Ask an admin", () => {
    expect(cloudProjectSharing({ level: "personal", canEdit: true, canShare: false }, "Withso")).toEqual({ label: "Only you", hint: null, share: false });
    expect(cloudProjectSharing({ level: "personal", canEdit: true, canShare: true }, "Withso")).toEqual({ label: "Only you", hint: null, share: true });
    expect(cloudProjectSharing({ level: "organization", canEdit: true, canShare: false }, "Withso"))
      .toEqual({ label: "Shared with Withso", hint: "Members can use it when they can read every repository on GitHub.", share: false });
    expect(cloudProjectSharing({ level: "organization", canEdit: false, canShare: false }, "Withso").hint).toBe("Managed by admins");
    expect(cloudProjectSubtitle(project(), "Withso")).toBe("Withso · 2 repositories");
    expect(cloudProjectSubtitle(project({ level: "personal", repositories: [repository("acme/app")] }), "Withso")).toBe("Only you · 1 repository");
  });

  it("says once, only for several repositories, that each repository's own agent settings are not loaded", () => {
    const limit = "Agents start in the project folder, so settings a repository keeps for its own agent (hooks, permissions, rules, its own MCP file) are not loaded. Instructions files are.";
    expect(render(project())).toContain(limit);
    expect(render(project({ repositories: [repository("withso/zeros")] }))).not.toContain("Agents start in the project folder");
  });

  it("lets an editor change each repository's branch and setup, add repositories and manage build secrets", () => {
    const page = render(project());
    expect(page).toContain("ready-copy:88888888-8888-4888-8888-888888888881");
    expect(page).toContain("2 repositories");
    expect(page).toContain("pnpm install");
    expect(page).toContain("No setup script");
    expect(page).toContain("build-secrets");
    expect(page).toContain("Shared with Withso");
    const html = renderToStaticMarkup(createElement(CloudProjectPage, { project: project(), organization: { id: "11111111-1111-4111-8111-111111111111", name: "Withso" },
      userKey: "user", connections: null, limits: { personal: 20, repositories: 10 }, localProjects: [], active: true, onChanged: vi.fn(), onOpenFolder: vi.fn() }));
    expect(html).toContain('aria-label="Add repositories"');
    expect(html).toContain('aria-label="withso/zeros branch"');
    expect(page).not.toContain("Share with");
  });

  it("shows members the status and repositories read-only, without build secrets", () => {
    const html = renderToStaticMarkup(createElement(CloudProjectPage, { project: project({ canEdit: false }),
      organization: { id: "11111111-1111-4111-8111-111111111111", name: "Withso" }, userKey: "user", connections: null,
      limits: { personal: 20, repositories: 10 }, localProjects: [], active: true, onChanged: vi.fn(), onOpenFolder: vi.fn() }));
    const page = text(html);
    expect(page).toContain("ready-copy:");
    expect(page).toContain("withso/zeros-design-demo");
    expect(page).toContain("Managed by admins");
    expect(page).not.toContain("build-secrets");
    expect(html).not.toContain('aria-label="Add repositories"');
    expect(html).not.toContain("branch\"");
  });

  it("shows each repository's folder on this Mac, or offers a clone", () => {
    const local = [folder("zeros", "git@github.com:Withso/Zeros.git"), folder("other", "https://github.com/acme/other.git")];
    expect(macFolderFor(local, "withso/zeros")?.id).toBe("zeros");
    expect(macFolderFor(local, "withso/zeros-design-demo")).toBeNull();
    const page = render(project({ canEdit: false }), local);
    expect(page).toContain("/Users/me/zeros");
    expect(page).toContain("Not on this Mac");
    expect(page).toContain("Clone to this Mac");
    expect(page).toContain("Local workspaces use one repository at a time.");
  });
});
