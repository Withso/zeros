// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../state/projects-store";

const s = vi.hoisted(() => ({ openGithubProject: vi.fn(), addProject: true }));
vi.mock("../../repositories/repositories-panel", () => ({
  ProjectLocalPart: ({ part, project }: { part: string; project: { id: string } }) => `local-${part}:${project.id}`,
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
function render(project: SettingsProject, options: { cloudAvailable?: boolean; canManageCloud?: boolean } = {}) {
  act(() => root.render(createElement(ProjectPage, {
    project, surfaceActive: true, cloudAvailable: options.cloudAvailable ?? true, canManageCloud: options.canManageCloud ?? true, ...handlers,
  })));
  return container.textContent ?? "";
}
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
    for (const part of ["local-setup:zeros", "cloud-setup:withso/zeros", "local-git:zeros", "cloud-git:withso/zeros", "local-environment:zeros", "local-more:zeros"])
      expect(text).toContain(part);
    expect(button("Edit")).toBeDefined();
    expect(button("Add to cloud")).toBeUndefined();
    expect(button("Clone to this Mac")).toBeUndefined();
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
    expect(text).not.toMatch(/local-(setup|git|environment|more)/);
    act(() => button("Clone to this Mac")!.click());
    expect(s.openGithubProject).toHaveBeenCalledWith({ placement: "local", url: "https://github.com/withso/billing-api.git" });
    s.addProject = false;
    render(cloudOnly);
    expect(button("Clone to this Mac")).toBeUndefined();
  });

  it("marks the default of two clones", () => {
    const [two] = settingsProjects([folder("second", "withso/zeros", 9), folder("first", "withso/zeros", 2)], []);
    expect(two.local.map(row => row.id)).toEqual(["first", "second"]);
    expect(render(two)).toContain("/Users/me/first · Default for new workspaces");
  });
});
