// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  connections: { organization: [] as unknown[], personal: [] as unknown[], solo: false },
  visible: [{ installationId: 900, accountLogin: "acme", suspended: false }],
  select: vi.fn(), appConfigured: false, connect: vi.fn(), open: vi.fn(), cloudMethod: "github-app" as string | null, configure: vi.fn(), refreshIdentity: vi.fn(),
  drawer: { repositories: [] as unknown[] },
}));
vi.mock("../../../platform/cloud-github-levels", async original => ({
  ...(await original<typeof import("../../../platform/cloud-github-levels")>()),
  getCloudGithubLevelConnections: vi.fn(async () => fixtures.connections),
  connectCloudGithubInstallation: fixtures.connect,
  getCloudProjects: vi.fn(async () => ({ projects: [], personalAllowed: true, canCreateOrganization: true, limits: { personal: 20, repositories: 10 } })),
  getCloudGithubVisibleInstallations: vi.fn(async () => [...fixtures.visible]),
  getCloudGithubConnectionRepositories: vi.fn(async () => ({ connection: fixtures.connections.organization[0], nextPage: null, ...fixtures.drawer })),
}));

vi.mock("../../../platform/app", () => ({ shellOpenUrl: fixtures.open.mockResolvedValue(undefined) }));
vi.mock("../use-shared-github", () => ({ useSharedGithub: () => ({ read: { refresh: fixtures.refreshIdentity, data: { generation: "gen1", selectedMethod: fixtures.cloudMethod, methods: { "github-app": { configured: fixtures.cloudMethod === "github-app" || fixtures.appConfigured, login: "octo" } }, installUrl: "https://github.com/apps/fixture/installations/new" } } }) }));

vi.mock("../../../platform/cloud-github-connection", async original => ({
  ...(await original<typeof import("../../../platform/cloud-github-connection")>()), changeCloudGithubConnection: fixtures.select,
}));

import { GithubConnectionGroups, PersonalProjectsSetting, connectionStateHint } from "../cloud-github-levels";
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
const button = (name: string, scope: ParentNode = document.body) => [...scope.querySelectorAll("button")].find(node =>
  (node.getAttribute("aria-label") ?? node.textContent?.trim()) === name);
const click = async (name: string) => {
  const target = button(name);
  expect(target, name).toBeDefined();
  await act(async () => target!.click());
};
const page = (userId: string, canManage: boolean) => render(createElement(GithubConnectionGroups, {
  userId, organizationId: ORG, organizationName: "Withso", canManage, active: true, onConfigureIdentity: fixtures.configure,
}));

describe("GitHub at two levels in Settings", () => {
  it.each([false, true])("adds a visible installation at the chosen level (admin=%s)", async admin => {
    fixtures.connections = { organization: [], personal: [], solo: false };
    fixtures.connect.mockClear();
    await page(admin ? "admin-add" : "member-add", admin);
    await click("Add connection");
    if (admin) await click("Withso");
    else expect(button("Withso")).toBeUndefined();
    await click("Link @acme");
    expect(fixtures.connect).toHaveBeenCalledExactlyOnceWith(ORG, 900, admin ? "organization" : "personal");
  });

  it("links only the matching migrated organization account", async () => {
    fixtures.connections = { organization: [connection(USER, "ACME", "organization", "active", null)], personal: [], solo: false };
    fixtures.connect.mockClear();
    await page("unbound-member", false);
    expect(button("Link @ACME")).toBeUndefined();
    await page("migrated", true);
    await click("Link @ACME");
    await click("Link @acme");
    expect(fixtures.connect).toHaveBeenCalledExactlyOnceWith(ORG, 900, "organization");
  });

  it("offers the deployed Reinstall link only to the organization manager", async () => {
    fixtures.connections = { organization: [connection(USER, "acme", "organization", "uninstalled")], personal: [], solo: false };
    await page("reinstall-member", false);
    expect(button("Reinstall @acme")).toBeUndefined();
    await page("reinstall-admin", true);
    await click("Reinstall @acme");
    expect(fixtures.open).toHaveBeenCalledWith("https://github.com/apps/fixture/installations/new");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("GitHub returned a different installation");
    expect(button("Link @acme", document.querySelector('[role="dialog"]')!)).toBeUndefined();
  });

  it.each(["pat", null])("offers App sign-in for a bound installation when Cloud uses %s", async method => {
    fixtures.cloudMethod = method;
    fixtures.configure.mockClear();
    fixtures.connect.mockClear();
    fixtures.connections = { organization: [connection(USER, "acme", "organization")], personal: [], solo: false };
    try {
      await page("member-link-" + method, false);
      await click("Link @acme");
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("GitHub App sign-in");
      await click("Configure account identity");
      expect(fixtures.configure).toHaveBeenCalledOnce();
      expect(fixtures.connect).not.toHaveBeenCalled();
    } finally { fixtures.cloudMethod = "github-app"; }
  });

  it("explains the App sign-in when Cloud uses a PAT", async () => {
    fixtures.cloudMethod = "pat";
    try {
      await page("cloud-pat", false);
      await click("Add connection");
      expect(document.body.textContent).toContain("GitHub App sign-in");
      expect(button("Configure account identity")).toBeDefined();
      expect(button("Link @acme", document.querySelector('[role="dialog"]')!)).toBeUndefined();
    } finally { fixtures.cloudMethod = "github-app"; }
  });

  it("offers to select a saved Cloud App for discovery without changing Local", async () => {
    fixtures.cloudMethod = "pat";
    fixtures.appConfigured = true;
    try {
      await page(USER, false);
      await click("Add connection");
      await click("Use GitHub App for Cloud");
      expect(fixtures.select).toHaveBeenCalledExactlyOnceWith(USER, ORG, "gen1", { action: "select", method: "github-app" });
    } finally { fixtures.appConfigured = false; fixtures.cloudMethod = "github-app"; }
  });

  it("explains a missing App grant in connection details and rechecks it without writing a connection", async () => {
    fixtures.connections = { organization: [connection(USER, "acme", "organization")], personal: [], solo: false };
    fixtures.connect.mockClear();
    await page("invisible-for-app", false);
    expect(button("Link @acme")).toBeUndefined();
    expect(button("View @acme")?.textContent).toContain("No access as @octo");
    await click("View @acme");
    const details = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(details.textContent).toContain("Get access to a repository owned by @acme on GitHub.");
    expect(details.textContent).toContain("Switch to a GitHub account with access under Configure account identity.");
    expect(button("Install on another account", details)).toBeUndefined();
    expect(button("Configure account identity", details)).toBeDefined();
    fixtures.visible.push({ installationId: 501, accountLogin: "acme", suspended: false });
    try {
      await click("Refresh installations");
      expect(button("View @acme")?.textContent).not.toContain("No access");
      expect(details.textContent).not.toContain("Get access to a repository");
      expect(button("Link @acme")).toBeUndefined();
      expect(fixtures.connect).not.toHaveBeenCalled();
    } finally { fixtures.visible.pop(); }
  });

  it("opens account identity from an inaccessible installation without starting an installation", async () => {
    fixtures.connections = { organization: [connection(USER, "acme", "organization")], personal: [], solo: false };
    fixtures.configure.mockClear();
    fixtures.open.mockClear();
    await page("denied-switch", false);
    await click("View @acme");
    await click("Configure account identity");
    expect(fixtures.configure).toHaveBeenCalledOnce();
    expect(fixtures.open).not.toHaveBeenCalled();
  });

  it("shows connection details after signing in with a saved App whose installation grant is missing", async () => {
    fixtures.connections = { organization: [connection(USER, "acme", "organization")], personal: [], solo: false };
    fixtures.cloudMethod = "pat";
    fixtures.appConfigured = true;
    fixtures.refreshIdentity.mockClear();
    try {
      await page("link-sign-in", false);
      await click("Link @acme");
      await click("Use GitHub App for Cloud");
      expect(fixtures.refreshIdentity).toHaveBeenCalledOnce();
      fixtures.cloudMethod = "github-app";
      await page("link-sign-in", false);
      const details = document.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(details.textContent).toContain("No access as @octo");
      expect(details.textContent).not.toContain("Link @acme");
      expect(button("Install on another account", details)).toBeUndefined();
    } finally { fixtures.appConfigured = false; fixtures.cloudMethod = "github-app"; }
  });

  it("keeps a member's personal connection editable and excludes other members' accounts", async () => {
    fixtures.connections = { organization: [], personal: [connection(USER, "octo", "personal"),
      { ...connection(ORG, "someone-else", "personal"), mine: false }], solo: false };
    await page("personal-manager", false);
    expect(document.body.textContent).not.toContain("someone-else");
    await click("View @octo");
    expect(button("Disconnect")).toBeDefined();
    await click("Manage on GitHub");
    expect(fixtures.open).toHaveBeenCalledWith("https://github.com/settings/installations/501");
  });

  it("names each GitHub edge state with one fix", () => {
    expect(connectionStateHint({ state: "suspended", accountLogin: "withso", installationId: 1 })).toBe("Suspended in GitHub. Unsuspend the Zeros App there.");
    expect(connectionStateHint({ state: "uninstalled", accountLogin: "withso", installationId: 1 })).toBe("The Zeros App was uninstalled. Install it again in GitHub.");
    expect(connectionStateHint({ state: "active", accountLogin: "withso", installationId: null })).toContain("Connect this account");
    expect(connectionStateHint({ state: "active", accountLogin: "withso", installationId: 1 })).toBeNull();
  });

  it("opens a connection's drawer with every repository it can read and the projects using each, with no add step", async () => {
    fixtures.connections = { organization: [connection("77777777-7777-4777-8777-777777777777", "withso", "organization", "active", 900)], personal: [], solo: false };
    fixtures.drawer = { repositories: [{ id: "42", repository: "withso/zeros", defaultBranch: "main", private: true,
      projects: [{ id: "88888888-8888-4888-8888-888888888881", name: "zeros" }] },
      { id: "43", repository: "withso/web", defaultBranch: "main", private: false, projects: [] }] };
    await page("drawer-member", false);
    await click("View @withso");
    expect([...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(["General", "Repositories"]);
    expect(button("Disconnect")).toBeUndefined();
    const tab = document.querySelector<HTMLElement>('[role="tab"][value="repositories"]') ??
      [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(node => node.textContent === "Repositories")!;
    await act(async () => tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
    const drawer = document.body.textContent ?? "";
    // Said once: what the list is, and that nothing is added here.
    expect(drawer.match(/can read/g)).toHaveLength(1);
    expect(drawer).toContain("Everything this connection can read. Nothing to add here: pick them when you create a project.");
    expect(drawer).not.toContain("Manage access");
    expect(drawer).toContain("Private");
    expect(drawer).toContain("Public");
    expect(drawer).toContain("withso/zeros");
    expect(drawer).toContain("withso/web");
    expect(drawer).toContain("In zeros");
    expect([...document.body.querySelectorAll("button")].map(node => node.textContent)).not.toContain("Add to cloud");
  });

  it("reads repository inventory again for a different caller in the same organization", async () => {
    fixtures.connections = { organization: [connection(USER, "acme", "organization", "active", 900)], personal: [], solo: false };
    for (const who of ["alice", "bob"]) {
      fixtures.drawer = { repositories: [{ id: "7", repository: "acme/" + who, projects: [], private: true }] };
      await page(who, false);
      await click("View @acme");
      const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(el => el.textContent === "Repositories")!;
      await act(async () => tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
      expect(document.body.textContent).toContain("acme/" + who);
      if (who === "bob") expect(document.body.textContent).not.toContain("acme/alice");
      await click("Close");
    }
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
