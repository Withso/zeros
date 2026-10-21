import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationSummary } from "../../team/control-plane";

const state = vi.hoisted(() => ({
  allowed: false,
  organization: { id: "org-fixture", isPersonal: false } as OrganizationSummary | null,
  section: "user:cloud-computer",
  cloudPanel: vi.fn(),
  localPanel: vi.fn(),
}));
vi.mock("../../../config/release-channel", async original => ({
  ...(await original<typeof import("../../../config/release-channel")>()),
  isFeatureEnabled: () => state.allowed,
}));
vi.mock("../../team/team-store", async original => ({
  ...(await original<typeof import("../../team/team-store")>()),
  useActiveOrganization: () => state.organization,
  useTeams: () => ({ me: { user: { id: "user-fixture" } } }),
  getActiveOrganizationIdSnapshot: () => state.organization?.isPersonal ? null : state.organization?.id ?? "org-fixture",
}));
vi.mock("../../../state/use-organization-projects", () => ({ useOrganizationProjects: () => ({ projects: [] }) }));
vi.mock("../settings-scope", async original => ({
  ...(await original<typeof import("../settings-scope")>()),
  readScopedSettingsSelection: () => state.section,
}));
vi.mock("../internal-features", async original => ({
  ...(await original<typeof import("../internal-features")>()),
  useIsInternalUser: () => false,
}));
vi.mock("../../team/organization-switcher", () => ({ OrganizationSwitcher: () => null }));
vi.mock("../../team/join-team-dialog", () => ({ JoinTeamDialog: () => null }));
vi.mock("../cloud-computer-panel", () => ({ CloudComputerPanel: () => { state.cloudPanel(); return "cloud-computer-fixture"; } }));
vi.mock("../cloud-customization-panel", () => ({ CloudMcpPanel: () => { state.cloudPanel(); return "cloud-mcp-fixture"; },
  CloudSkillsPanel: () => { state.cloudPanel(); return "cloud-skills-fixture"; } }));
vi.mock("../cloud-github-section", () => ({ CloudGithubSection: () => { state.cloudPanel(); return "cloud-github-fixture"; } }));
vi.mock("../github-section", () => ({ GitHubSection: () => { state.localPanel(); return "local-github-fixture"; } }));
vi.mock("../providers-panel", () => ({ ProvidersPanel: () => { state.localPanel(); return "agents-fixture"; } }));
vi.mock("../../../shell/add-project-provider", () => ({
  useAddProject: () => ({ openProject: vi.fn(), openGithubProject: vi.fn(), quickStart: vi.fn() }),
}));
vi.mock("../../../shared/ui/open-settings-file-button", () => ({ OpenSettingsFileButton: () => null }));

import { SettingsPage } from "../settings-page";
import { NoProjectsView } from "../../../shell/no-projects-view";
import { TooltipProvider } from "../../../shared/ui/primitives/tooltip";

function settings() {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(SettingsPage)));
}
beforeEach(() => {
  vi.clearAllMocks();
  state.allowed = false;
  state.organization = { id: "org-fixture", isPersonal: false } as OrganizationSummary;
  state.section = "user:cloud-computer";
});
afterEach(() => vi.unstubAllEnvs());

describe("paused cloud entry points", () => {
  it.each(["user:cloud-computer", "user:cloud-mcp", "user:cloud-skills"])("keeps the saved %s selection inert and shows a calm notice", section => {
    state.section = section;
    const html = settings();
    expect(html).toContain("Cloud workspaces are paused");
    expect(html).not.toMatch(/cloud-(?:computer|mcp|skills)-fixture|Cloud Computer|Checking|Loading/);
    expect(html).toContain("agents-fixture");
    expect(state.cloudPanel).not.toHaveBeenCalled();
  });

  it("uses the device GitHub integration while cloud is paused", () => {
    state.section = "user:integrations";
    const html = settings();
    expect(html).toContain("local-github-fixture");
    expect(state.cloudPanel).not.toHaveBeenCalled();
  });

  it("keeps existing organization cloud settings available after unpause", () => {
    state.allowed = true;
    expect(settings()).toContain("cloud-computer-fixture");
    state.section = "user:integrations";
    expect(settings()).toContain("cloud-github-fixture");
    expect(state.cloudPanel).toHaveBeenCalledTimes(2);
  });

  it("replaces organization creation tiles with a pause notice, leaving Local creation available", () => {
    const paused = renderToStaticMarkup(createElement(NoProjectsView));
    expect(paused).toContain("Cloud workspaces are paused");
    expect(paused).not.toMatch(/Open GitHub project|Start from scratch|Open project/);
    state.organization = { id: "personal-fixture", isPersonal: true } as OrganizationSummary;
    const local = renderToStaticMarkup(createElement(NoProjectsView));
    expect(local).toContain("Open GitHub project");
    expect(local).toContain("Start from scratch");
  });

  it("routes organization-local agent controls to the device panel while paused", async () => {
    const { ProvidersPanel } = await vi.importActual<typeof import("../providers-panel")>("../providers-panel");
    const paused = ProvidersPanel({}) as ReactElement;
    expect((paused.type as { name: string }).name).toBe("LocalProvidersPanel");
    state.allowed = true;
    const active = ProvidersPanel({}) as ReactElement;
    expect((active.type as { name: string }).name).toBe("CloudProviderConnections");
  });

  it("keeps restored creation routes and the cloud lifecycle unmounted while paused", async () => {
    const { DispatcherPage } = await import("../../../shell/dispatcher/dispatcher-modal");
    const { OpenGithubProjectDialog } = await import("../../../shell/dialogs/open-github-project");
    const { CloudWorkspaceLifecycle } = await import("../../../state/cloud-workspace-lifecycle");
    const props = { active: true, onOpenProject: vi.fn(), onOpenGithubProject: vi.fn(), onQuickStart: vi.fn() };
    expect(renderToStaticMarkup(createElement(DispatcherPage, props))).toContain("Cloud workspaces are paused");
    expect(OpenGithubProjectDialog({ open: true, onOpenChange: vi.fn() })).toBeNull();
    expect(CloudWorkspaceLifecycle()).toBeNull();
    state.organization = null; // The confirmed org key is still pending.
    expect(renderToStaticMarkup(createElement(DispatcherPage, props))).toContain("Cloud workspaces are paused");
    state.allowed = true;
    expect(CloudWorkspaceLifecycle()).not.toBeNull();
  });
});
