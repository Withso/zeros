// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationSummary } from "../../team/control-plane";

const state = vi.hoisted(() => ({
  unified: true,
  organization: null as OrganizationSummary | null,
  saved: new Map<string, string>(),
  writes: [] as Array<[string, string, string]>,
  projects: [] as Array<{ id: string; name: string; repoRoot?: string; originUrl?: string | null; addedAt?: number }>,
  cloudRepositories: [] as string[],
  cloudAccess: true,
  dispatch: vi.fn(),
  openUrl: vi.fn(async (_url: string) => {}),
}));
vi.mock("../../../platform/app", async (original) => ({
  ...(await original<typeof import("../../../platform/app")>()),
  shellOpenUrl: state.openUrl,
}));
vi.mock("../../../config/release-channel", async (original) => ({
  ...(await original<typeof import("../../../config/release-channel")>()),
  isFeatureEnabled: (feature: string) =>
    feature === "unified-workspaces" ? state.unified : true,
}));
vi.mock("../../team/team-store", async (original) => ({
  ...(await original<typeof import("../../team/team-store")>()),
  useActiveOrganization: () => state.organization,
  useTeams: () => ({ me: { user: { id: "member" } } }),
  getActiveOrganizationIdSnapshot: () =>
    state.organization && !state.organization.isPersonal ? state.organization.id : null,
}));
vi.mock("../../team/cloud-workspace-account-access", () => ({
  hasCloudWorkspaceAccountAccess: () => state.cloudAccess,
}));
vi.mock("../../../state/use-organization-projects", () => ({
  useOrganizationProjects: () => ({ projects: state.projects }),
}));
vi.mock("../../../state/store", async (original) => ({
  ...(await original<typeof import("../../../state/store")>()),
  useWorkspaceDispatch: () => state.dispatch,
  useActivePage: () => "settings",
}));
vi.mock("../settings-scope", async (original) => ({
  ...(await original<typeof import("../settings-scope")>()),
  readScopedSettingsSelection: (owner: string, kind: string, fallback: string) =>
    state.saved.get(`${owner}:${kind}`) ?? fallback,
  writeScopedSettingsSelection: (owner: string, kind: string, value: string) => {
    state.writes.push([owner, kind, value]);
    state.saved.set(`${owner}:${kind}`, value);
  },
}));
vi.mock("../experimental-features", async (original) => ({
  ...(await original<typeof import("../experimental-features")>()),
  useExperimentalFeature: () => [true, () => {}],
}));
vi.mock("../internal-features", async (original) => ({
  ...(await original<typeof import("../internal-features")>()),
  useIsInternalUser: () => false,
}));
vi.mock("../../team/organization-switcher", () => ({ OrganizationSwitcher: () => null }));
vi.mock("../../team/join-team-dialog", () => ({ JoinTeamDialog: () => null }));
vi.mock("../cloud-computer-panel", () => ({ CloudComputerPanel: () => "cloud-computer-fixture" }));
vi.mock("../cloud-computer-store", () => ({
  prefetchCloudComputer: () => {},
  useCloudComputerRepositories: () => state.cloudRepositories,
}));
vi.mock("../cloud-github-section", () => ({
  CloudGithubSection: ({ title }: { title?: unknown }) =>
    createElement("div", null, "cloud-github-fixture", title as never),
}));
vi.mock("../github-section", () => ({
  GitHubSection: ({ title }: { title?: unknown }) =>
    createElement("div", null, "local-github-fixture", title as never),
}));
vi.mock("../providers-panel", () => ({
  ProvidersPanel: ({ unified }: { unified?: boolean }) =>
    unified ? "unified-agents-fixture" : "agents-fixture",
}));
vi.mock("../environment-panel", () => ({
  EnvironmentPanel: ({ unified }: { unified?: boolean }) =>
    unified ? "unified-environment-fixture" : "environment-fixture",
}));
vi.mock("../computer-use-panel", () => ({
  ComputerUseSettingsSection: ({ device }: { device?: boolean }) =>
    device ? "computer-use-device-fixture" : "computer-use-fixture",
  ComputerPermissionRows: () => null,
}));
vi.mock("../workspace-api-access-setting", async (original) => ({
  ...(await original<typeof import("../workspace-api-access-setting")>()),
  WorkspaceApiAccessSetting: () => "workspace-api-access-fixture",
}));
vi.mock("../local-commands-settings", () => ({
  AlwaysAllowLocalCommands: () => "local-commands-fixture",
}));
vi.mock("../migrate-legacy", () => ({ ensureSettingsTomlMigrated: vi.fn() }));
vi.mock("../project-page", async (original) => ({
  ...(await original<typeof import("../project-page")>()),
  ProjectPage: ({ project }: { project: { key: string } }) => `project-page-fixture:${project.key}`,
}));
vi.mock("../../../shell/add-project-provider", () => ({
  useAddProject: () => ({ openProject: vi.fn(), openGithubProject: vi.fn(), quickStart: vi.fn() }),
}));
vi.mock("../../../shared/ui/open-settings-file-button", () => ({ OpenSettingsFileButton: () => null }));

import { SettingsPage } from "../settings-page";
import { TooltipProvider } from "../../../shared/ui/primitives/tooltip";

const ORGANIZATION = {
  id: "org-a",
  name: "Withso",
  isPersonal: false,
  workspaceCapabilities: { cloud: true },
} as unknown as OrganizationSummary;
const ORGANIZATION_OWNER = JSON.stringify(["member", "org-a"]);

let container: HTMLDivElement;
let root: Root | null = null;

function render() {
  act(() => root?.unmount());
  container.replaceChildren();
  root = createRoot(container);
  act(() => root!.render(createElement(TooltipProvider, null, createElement(SettingsPage))));
  return container;
}
const heading = () => container.querySelector("h1")?.textContent;
const rail = () =>
  [...container.querySelectorAll('nav[aria-label="Settings sections"] > *')]
    .map((node) => node.textContent?.trim())
    .filter(Boolean);
const activeEntry = () =>
  container.querySelector('nav [role="tab"][data-state="active"]')?.textContent;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  state.unified = true;
  state.organization = null;
  state.saved.clear();
  state.writes = [];
  state.projects = [];
  state.cloudRepositories = [];
  state.cloudAccess = true;
  state.dispatch.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("unified Settings rail", () => {
  it("lists Personal and Projects under the Personal owner, without an organization group", () => {
    state.projects = [{ id: "project-zeros", name: "Zeros" }];
    render();
    const groups = rail();
    expect(groups[0]).toBe("Personal");
    expect(groups).toContain("Projects");
    expect(groups).not.toContain("Withso");
    const text = container.querySelector("nav")!.textContent!;
    for (const label of ["General", "Computer use", "Agents", "GitHub", "Environment", "Git & PR", "Profile"])
      expect(text).toContain(label);
    expect(text).not.toMatch(/Terminal Agents|Integrations|Cloud Computer/);
    const project = [...container.querySelectorAll('nav [role="tab"]')].find(
      (node) => node.textContent === "Zeros",
    ) as HTMLElement;
    act(() => project.click());
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(heading()).toBe("Zeros");
    expect(container.textContent).toContain("project-page-fixture:local:project-zeros");
    expect(state.saved.get("local:section")).toBe("project:local:project-zeros");
  });

  it("adds the organization's group by name and its cloud repositories as Projects", () => {
    state.organization = ORGANIZATION;
    state.cloudRepositories = ["withso/zeros"];
    render();
    expect(rail()).toEqual([
      "Personal",
      expect.stringContaining("General"),
      "Withso",
      "GeneralMembersCloud Computer",
      "Projects",
      "zeros",
    ]);
  });

  it("opens Members on the organization's web dashboard, marked as leaving the app", () => {
    state.organization = ORGANIZATION;
    render();
    const members = [...container.querySelectorAll('nav [role="tab"]')].find(
      (node) => node.textContent === "Members",
    ) as HTMLElement;
    expect(members.getAttribute("aria-description")).toBe("Opens in your browser");
    act(() => members.click());
    const url = new URL(state.openUrl.mock.calls[0][0] as string);
    expect(url.searchParams.get("organization")).toBe("org-a");
    expect(url.searchParams.get("section")).toBe("members");
    expect(state.writes).toEqual([]);
  });

  it("joins a repository on this Mac and in the cloud into one project, and old saved pages land on it", () => {
    state.organization = ORGANIZATION;
    state.projects = [{ id: "project-zeros", name: "Zeros", repoRoot: "/Users/me/zeros", originUrl: "git@github.com:withso/zeros.git", addedAt: 1 }];
    state.cloudRepositories = ["withso/zeros"];
    for (const saved of ["cloud-repo:git:withso/zeros", "repo:project-zeros:git", "project:github:withso/zeros"]) {
      state.saved.set(`${ORGANIZATION_OWNER}:section`, saved);
      render();
      expect(rail().slice(-2)).toEqual(["Projects", "Zeros"]);
      expect(heading()).toBe("Zeros");
      expect(container.querySelector("header p")?.textContent).toBe("withso/zeros");
      expect(container.textContent).toContain("project-page-fixture:github:withso/zeros");
      expect(activeEntry()).toBe("Zeros");
    }
    expect(state.writes).toEqual([]);
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("shows this Mac's projects under the Personal owner with no cloud side", () => {
    state.projects = [{ id: "project-zeros", name: "Zeros", repoRoot: "/Users/me/zeros", originUrl: "git@github.com:withso/zeros.git", addedAt: 1 }];
    state.cloudRepositories = ["withso/zeros"];
    render();
    expect(rail().slice(-2)).toEqual(["Projects", "Zeros"]);
  });

  it("splits General: personal rows, then This Mac; organization rows on their own page", () => {
    state.organization = ORGANIZATION;
    state.saved.set(`${ORGANIZATION_OWNER}:section`, "user:general");
    render();
    expect(heading()).toBe("General");
    const page = container.textContent!;
    expect(page).toContain("Follow-up behavior");
    expect(page).toContain("Show hidden workspaces in dashboard");
    expect(page).toContain("This Mac");
    expect(page).toContain("Restart automatically on update");
    expect(page).toContain("Share anonymous usage data");
    expect(page).not.toMatch(/computer-use-fixture|workspace-api-access-fixture|local-commands-fixture/);

    state.saved.set(`${ORGANIZATION_OWNER}:section`, "user:org-general");
    render();
    expect(heading()).toBe("General");
    expect(container.querySelector("header p")?.textContent).toBe("Withso");
    expect(container.textContent).toContain("workspace-api-access-fixture");
    expect(container.textContent).toContain("local-commands-fixture");
    expect(container.textContent).not.toContain("Follow-up behavior");

    state.saved.set(`${ORGANIZATION_OWNER}:section`, "user:computer-use");
    render();
    expect(heading()).toBe("Computer use");
    expect(container.textContent).toContain("computer-use-device-fixture");
  });

  it("hides the organization General when the organization has no rows of its own", () => {
    state.organization = ORGANIZATION;
    state.cloudAccess = false;
    state.saved.set(`${ORGANIZATION_OWNER}:section`, "user:org-general");
    render();
    expect(heading()).toBe("Agents");
    const groups = rail();
    expect(groups.slice(groups.indexOf("Withso"), groups.indexOf("Withso") + 2)).toEqual([
      "Withso",
      "MembersCloud Computer",
    ]);
  });

  it("composes This Mac and cloud GitHub and passes unified to Agents and Environment", () => {
    state.organization = ORGANIZATION;
    state.saved.set(`${ORGANIZATION_OWNER}:section`, "user:integrations");
    render();
    expect(heading()).toBe("GitHub");
    expect(container.textContent).toContain("local-github-fixture");
    expect(container.textContent).toContain("cloud-github-fixture");
    expect(container.textContent).toContain("Cloud");
    state.saved.set(`${ORGANIZATION_OWNER}:section`, "user:providers");
    render();
    expect(container.textContent).toContain("unified-agents-fixture");
    state.saved.set(`${ORGANIZATION_OWNER}:section`, "user:environment");
    render();
    expect(heading()).toBe("Environment");
    expect(container.textContent).toContain("unified-environment-fixture");
  });

  it("shows only this Mac's GitHub under the Personal owner", () => {
    state.saved.set("local:section", "user:integrations");
    render();
    expect(container.textContent).toContain("local-github-fixture");
    expect(container.textContent).not.toContain("cloud-github-fixture");
  });
});

describe("saved selections across the unified-workspaces flag", () => {
  it.each([
    ["user:computer-use", "Computer use", "General"],
    ["user:terminal-agents", "Agents", "Terminal Agents"],
  ])("keeps %s through on → off → on without rewriting it", (saved, unifiedHeading, legacyHeading) => {
    state.saved.set("local:section", saved);
    render();
    expect(heading()).toBe(unifiedHeading);
    state.unified = false;
    render();
    expect(heading()).toBe(legacyHeading);
    state.unified = true;
    render();
    expect(heading()).toBe(unifiedHeading);
    expect(state.writes).toEqual([]);
    expect(state.saved.get("local:section")).toBe(saved);
  });

  it("opens the organization's legacy General for a saved organization General with the flag off", () => {
    state.organization = ORGANIZATION;
    state.saved.set(`${ORGANIZATION_OWNER}:section`, "user:org-general");
    state.unified = false;
    render();
    expect(heading()).toBe("General");
    expect(container.textContent).toContain("workspace-api-access-fixture");
    expect(container.textContent).toContain("computer-use-fixture");
    expect(state.writes).toEqual([]);
    expect(activeEntry()).toBe("General");
  });

  it("keeps the legacy rail when the flag is off", () => {
    state.organization = ORGANIZATION;
    state.unified = false;
    render();
    const text = container.querySelector("nav")!.textContent!;
    expect(text).not.toMatch(/Personal|Withso|Projects|Computer use|GitHub/);
    expect(text).toContain("Integrations");
    expect(heading()).toBe("Agents");
  });
});
