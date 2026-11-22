// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../state/projects-store";

const s = vi.hoisted(() => ({ openGithubProject: vi.fn(), addProject: true }));
vi.mock("../../repositories/repositories-panel", () => ({
  ProjectLocalPart: ({ part, project }: { part: string; project: { id: string } }) => `local-${part}:${project.id}`,
}));
vi.mock("../ready-copy-section", () => ({
  ReadyCopySection: ({ projectId }: { projectId: string }) => `ready-copy:${projectId}`,
}));
vi.mock("../cloud-repository-panel", () => ({
  CloudRepositoryPanel: ({ part, repository }: { part: string; repository: string }) => `cloud-${part}:${repository}`,
}));
vi.mock("../../../shell/add-project-provider", () => ({
  useOptionalAddProject: () => (s.addProject ? { openGithubProject: s.openGithubProject } : null),
}));

import { ProjectPage, settingsProjects, type SettingsProject } from "../project-page";

const folder = (id: string, originUrl: string | null, addedAt = 1): Project =>
  ({ id, name: id, repoRoot: `/Users/me/${id}`, repoSlug: id, originUrl, addedAt, isGitRepository: true }) as Project;

let container: HTMLDivElement;
let root: Root;
const handlers = { onAddToCloud: vi.fn(), onOpenEnvironment: vi.fn(), onOpenCloudComputer: vi.fn() };
type Sharing = NonNullable<Parameters<typeof ProjectPage>[0]["sharing"]>;
function render(project: SettingsProject, options: { cloudAvailable?: boolean; canManageCloud?: boolean; initialFolderId?: string; sharing?: Sharing;
  readyCopy?: { organizationId: string; projectId: string } } = {}) {
  act(() => root.render(createElement(ProjectPage, {
    key: options.initialFolderId, project, surfaceActive: true, cloudAvailable: options.cloudAvailable ?? true,
    canManageCloud: options.canManageCloud ?? true, initialFolderId: options.initialFolderId, ...handlers,
    ...(options.sharing ? { sharing: options.sharing } : {}),
    ...(options.readyCopy ? { readyCopy: options.readyCopy } : {}),
  })));
  return container.textContent ?? "";
}
const headings = (selector: string) => [...container.querySelectorAll(selector)].map(node => node.textContent);
const button = (name: string) => [...container.querySelectorAll("button")].find(node => node.textContent === name);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  s.addProject = true;
  s.openGithubProject.mockClear();
  Object.values(handlers).forEach(handler => handler.mockClear());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Settings projects", () => {
  it("joins this Mac's folder with the organization's cloud repository and keeps GitHub's casing", () => {
    const [project] = settingsProjects([folder("zeros", "git@github.com:withso/zeros.git")], ["Withso/Zeros"]);
    expect(project).toMatchObject({ key: "github:withso/zeros", label: "zeros", subtitle: "Withso/Zeros", cloudRepository: "Withso/Zeros", github: "Withso/Zeros" });
    expect(project.local.map(row => row.id)).toEqual(["zeros"]);
  });

  it("lists local-only, cloud-only and remote-less projects, with stable references", () => {
    const local = [folder("app", "https://github.com/acme/app.git"), folder("scratch", null)];
    const cloud = ["withso/billing-api"];
    const projects = settingsProjects(local, cloud);
    expect(projects.map(project => [project.key, project.label, project.github])).toEqual([
      ["github:acme/app", "app", "acme/app"],
      ["local:scratch", "scratch", null],
      ["github:withso/billing-api", "billing-api", "withso/billing-api"],
    ]);
    expect(settingsProjects(local, cloud)).toBe(projects);
  });
});

describe("project page", () => {
  const both = settingsProjects([folder("zeros", "git@github.com:withso/zeros.git")], ["withso/zeros"])[0];

  it("shows both places and every part for a project in both", () => {
    const text = render(both);
    expect(text).toContain("/Users/me/zeros");
    expect(text).toContain("On the Cloud Computer");
    for (const part of ["local-scripts:zeros", "cloud-setup:withso/zeros", "local-git:zeros", "cloud-git:withso/zeros", "local-environment:zeros",
      "local-run-actions:zeros", "local-actions:zeros", "local-files:zeros", "local-paths:zeros"])
      expect(text).toContain(part);
    expect(button("Edit")).toBeDefined();
    expect(button("Add to cloud")).toBeUndefined();
    expect(button("Clone to this Mac")).toBeUndefined();
  });

  it("gives the page one level of sections and names a side only where both appear", () => {
    render(both);
    expect(headings("h2")).toEqual(["Where it runs", "Scripts", "Git", "Environment", "Run actions", "Actions", "Files to copy", "Folder"]);
    expect(headings("h3")).toEqual(["This Mac", "Cloud", "This Mac", "Cloud", "This Mac"]);
    expect(container.textContent).toContain("Setup runs when a workspace is created; Archive runs before one is archived.");
    const [local] = settingsProjects([folder("app", "https://github.com/acme/app.git")], []);
    render(local);
    expect(headings("h3")).toEqual([]);
  });

  it("gives members a read-only cloud row instead of the editors", () => {
    const text = render(both, { canManageCloud: false });
    expect(text).not.toContain("cloud-setup:");
    expect(text).not.toContain("cloud-git:");
    expect(text.match(/Managed by admins/g)).toHaveLength(2);
  });

  it("completes a local-only project with Add to cloud where cloud is available", () => {
    const [local] = settingsProjects([folder("app", "https://github.com/acme/app.git")], []);
    let text = render(local);
    expect(text).toContain("Not in cloud");
    expect(text).not.toMatch(/cloud-(setup|git)|Managed by admins|Defaults for cloud/);
    expect(headings("h3")).toEqual([]);
    act(() => button("Add to cloud")!.click());
    expect(handlers.onAddToCloud).toHaveBeenCalledOnce();
    text = render(local, { cloudAvailable: false });
    expect(text).not.toContain("Not in cloud");
    expect(button("Add to cloud")).toBeUndefined();
  });

  it("offers no cloud affordance for a folder without a GitHub remote", () => {
    const [scratch] = settingsProjects([folder("scratch", null)], []);
    const text = render(scratch);
    expect(text).not.toMatch(/Cloud|Add to cloud/);
  });

  it("completes a cloud-only project with Clone to this Mac", () => {
    const [cloudOnly] = settingsProjects([], ["withso/billing-api"]);
    const text = render(cloudOnly);
    expect(text).toContain("Not on this Mac");
    expect(text).not.toMatch(/local-/);
    expect(headings("h2")).toEqual(["Where it runs", "Scripts", "Git", "Environment"]);
    expect(headings("h3")).toEqual([]);
    act(() => button("Clone to this Mac")!.click());
    expect(s.openGithubProject).toHaveBeenCalledWith({ placement: "local", url: "https://github.com/withso/billing-api.git" });
    s.addProject = false;
    render(cloudOnly);
    expect(button("Clone to this Mac")).toBeUndefined();
  });

  it("marks the default of two clones and edits the default unless another is chosen", () => {
    const [two] = settingsProjects([folder("second", "withso/zeros", 9), folder("first", "withso/zeros", 2)], []);
    expect(two.local.map(row => row.id)).toEqual(["first", "second"]);
    let text = render(two);
    expect(text).toContain("/Users/me/first · Default for new workspaces");
    expect(container.querySelector('[aria-label="Folder these settings apply to"]')?.textContent).toBe("/Users/me/first (default)");
    expect(text).toContain("local-git:first");
    expect(text).not.toContain("local-git:second");
    text = render(two, { initialFolderId: "second" });
    expect(container.querySelector('[aria-label="Folder these settings apply to"]')?.textContent).toBe("/Users/me/second");
    expect(text).toContain("local-git:second");
    expect(text).not.toContain("local-git:first");
    text = render(two, { initialFolderId: "gone" });
    expect(text).toContain("local-git:first");
  });

  it("shows who a cloud repository is for: shared, or only you, with Share only where it can succeed and never Ask an admin", () => {
    const sharing = (level: "shared" | "private", canShare: boolean) =>
      ({ level, organizationName: "Withso", canShare, onShare: vi.fn() });
    expect(render(both, { sharing: sharing("shared", true) })).toContain("Shared with Withso");
    expect(button("Share with Withso")).toBeUndefined();
    const shareable = sharing("private", true);
    expect(render(both, { sharing: shareable })).toContain("Only you");
    act(() => button("Share with Withso")!.click());
    expect(shareable.onShare).toHaveBeenCalledOnce();
    // A private repository has no organization setup to edit.
    expect(container.textContent).not.toContain("cloud-setup:");
    // Not shareable now (a member, or a repository no organization connection reaches): "Only you" and nothing else.
    render(both, { sharing: sharing("private", false), canManageCloud: false });
    expect(container.textContent).toContain("Only you");
    expect(button("Share with Withso")).toBeUndefined();
    expect(container.textContent).not.toContain("Ask an admin");
  });

  it("shows the cloud repository's build in a Cloud build section, and nothing new for a local-only project", () => {
    expect(render(both, { readyCopy: { organizationId: "11111111-1111-4111-8111-111111111111", projectId: "88888888-8888-4888-8888-888888888881" } })).toContain("ready-copy:88888888-8888-4888-8888-888888888881");
    expect([...container.querySelectorAll("h2")].map(node => node.textContent)).toContain("Cloud build");
    const [local] = settingsProjects([folder("app", "https://github.com/acme/app.git")], []);
    expect(render(local, { readyCopy: { organizationId: "11111111-1111-4111-8111-111111111111", projectId: "88888888-8888-4888-8888-888888888881" } })).not.toContain("ready-copy:");
    expect(render(both)).not.toContain("ready-copy:");
  });

  it("offers no folder choice for one clone", () => {
    render(both);
    expect(container.querySelector('[aria-label="Folder these settings apply to"]')).toBeNull();
  });
});
