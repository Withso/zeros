// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  connections: { organization: [] as unknown[], personal: [] as unknown[], solo: false },
  drawer: { repositories: [] as unknown[] },
}));
vi.mock("../../../platform/cloud-github-levels", async original => ({
  ...(await original<typeof import("../../../platform/cloud-github-levels")>()),
  getCloudGithubLevelConnections: vi.fn(async () => fixtures.connections),
  getCloudProjects: vi.fn(async () => ({ projects: [], personalAllowed: true, canCreateOrganization: true, limits: { personal: 20, repositories: 10 } })),
  getCloudGithubVisibleInstallations: vi.fn(async () => [{ installationId: 900, accountLogin: "acme", suspended: false }]),
  getCloudGithubConnectionRepositories: vi.fn(async () => ({ connection: fixtures.connections.organization[0], nextPage: null, ...fixtures.drawer })),
}));

import { GithubConnectionsSection, PersonalProjectsSetting, connectionStateHint } from "../cloud-github-levels";
import { projectForRepository, type CloudProjects } from "../../../platform/cloud-github-levels";

const ORG = "11111111-1111-4111-8111-111111111111", USER = "22222222-2222-4222-8222-222222222222";
const connection = (id: string, account: string, level: "organization" | "personal", state = "active", installationId: number | null = 501) =>
  ({ id, installationId, accountLogin: account, level, state, mine: level === "personal" });
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = async (element: Parameters<Root["render"]>[0]) => {
  await act(async () => { root.render(element); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return container.textContent ?? "";
};
const buttons = () => [...container.querySelectorAll("button")].map(node => node.textContent);

describe("GitHub at two levels in Settings", () => {
  it("lets owners and admins manage the organization's connections and shows members them read-only", async () => {
    fixtures.connections = { organization: [connection("33333333-3333-4333-8333-333333333333", "withso", "organization")], personal: [], solo: false };
    let text = await render(createElement(GithubConnectionsSection, { userId: USER, organizationId: ORG, level: "organization", canManage: true,
      active: true, title: "Connections", description: "Shared." }));
    expect(text).toContain("withso");
    expect(buttons()).toEqual(expect.arrayContaining(["Repositories", "Remove", "Connect"]));
    text = await render(createElement(GithubConnectionsSection, { userId: "44444444-4444-4444-8444-444444444444", organizationId: ORG, level: "organization",
      canManage: false, active: true, title: "Connections", description: "Shared." }));
    expect(text).toContain("Managed by admins");
    expect(buttons()).not.toContain("Remove");
    expect(buttons()).not.toContain("Connect");
  });

  it("lists only the caller's own personal connections on Personal", async () => {
    fixtures.connections = { organization: [connection("33333333-3333-4333-8333-333333333333", "withso", "organization")],
      personal: [connection("55555555-5555-4555-8555-555555555555", "me-gh", "personal")], solo: false };
    const text = await render(createElement(GithubConnectionsSection, { userId: "66666666-6666-4666-8666-666666666666", organizationId: ORG, level: "personal",
      canManage: true, active: true, title: "Only you", description: "Yours." }));
    expect(text).toContain("me-gh");
    expect(text).not.toContain("withso");
  });

  it("names each GitHub edge state with one fix", () => {
    expect(connectionStateHint({ state: "suspended", accountLogin: "withso", installationId: 1 })).toBe("Suspended in GitHub. Unsuspend the Zeros App there.");
    expect(connectionStateHint({ state: "uninstalled", accountLogin: "withso", installationId: 1 })).toBe("The Zeros App was uninstalled. Install it again in GitHub.");
    expect(connectionStateHint({ state: "active", accountLogin: "withso", installationId: null })).toContain("Connect this account");
    expect(connectionStateHint({ state: "active", accountLogin: "withso", installationId: 1 })).toBeNull();
  });

  it("opens a connection's drawer with every repository it can read and the projects using each, with no add step", async () => {
    fixtures.connections = { organization: [connection("77777777-7777-4777-8777-777777777777", "withso", "organization")], personal: [], solo: false };
    fixtures.drawer = { repositories: [{ id: "42", repository: "withso/zeros", defaultBranch: "main", private: true,
      projects: [{ id: "88888888-8888-4888-8888-888888888881", name: "zeros" }] },
      { id: "43", repository: "withso/web", defaultBranch: "main", private: false, projects: [] }] };
    await render(createElement(GithubConnectionsSection, { userId: "88888888-8888-4888-8888-888888888888", organizationId: ORG, level: "organization", canManage: true,
      active: true, title: "Connections", description: "Shared." }));
    await act(async () => { [...container.querySelectorAll("button")].find(node => node.textContent === "Repositories")!.click(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const drawer = document.body.textContent ?? "";
    expect(drawer).toContain("Repositories this connection can read. Projects pick their repositories from these.");
    expect(drawer).toContain("withso/zeros");
    expect(drawer).toContain("withso/web");
    expect(drawer).toContain("In zeros");
    expect([...document.body.querySelectorAll("button")].map(node => node.textContent)).not.toContain("Add to cloud");
  });

  it("explains what forbidding projects for one member does, read-only for members", async () => {
    let text = await render(createElement(PersonalProjectsSetting, { userId: "99999999-9999-4999-8999-999999999999", organizationId: ORG, canManage: true, active: true }));
    expect(text).toContain("existing workspaces keep working");
    text = await render(createElement(PersonalProjectsSetting, { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", organizationId: ORG, canManage: false, active: true }));
    expect(text).toContain("Managed by admins");
  });
});

describe("a repository's one-repository project", () => {
  const project = (id: string, level: "organization" | "personal", repositories: string[]) => ({ id, name: id, level, ownerUserId: null, canEdit: true,
    repositories: repositories.map((repository, position) => ({ repository, repositoryId: String(position + 1), connectionId: null, defaultBranch: null,
      setup: null, setupScript: null, position })) });
  it("is the organization's first, then the caller's own, and never a project of several repositories", () => {
    const list = { personalAllowed: true, canCreateOrganization: true, limits: { personal: 20, repositories: 10 }, projects: [
      project("88888888-8888-4888-8888-888888888881", "organization", ["withso/zeros", "withso/web"]),
      project("88888888-8888-4888-8888-888888888882", "personal", ["withso/zeros"]),
      project("88888888-8888-4888-8888-888888888883", "organization", ["withso/zeros"]),
    ] } as CloudProjects;
    expect(projectForRepository(list, "Withso/Zeros")?.id).toBe("88888888-8888-4888-8888-888888888883");
    expect(projectForRepository({ ...list, projects: list.projects.slice(0, 2) }, "withso/zeros")?.id).toBe("88888888-8888-4888-8888-888888888882");
    expect(projectForRepository(list, "withso/web")).toBeNull();
    expect(projectForRepository(null, "withso/zeros")).toBeNull();
  });
});
