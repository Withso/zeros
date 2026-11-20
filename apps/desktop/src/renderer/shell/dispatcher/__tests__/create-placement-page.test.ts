// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const s = vi.hoisted(() => ({
  unified: true,
  cloudFeature: true,
  settings: new Map<string, unknown>(),
  organization: { id: "11111111-1111-4111-8111-111111111111", name: "Withso", isPersonal: false } as { id: string; name: string; isPersonal: boolean },
  projects: [] as Array<{ id: string; name: string; repoRoot: string; repoSlug: string; isGitRepository?: boolean }>,
  cloudReason: null as string | null,
  dispatch: vi.fn(),
  composerKeys: [] as Array<string | null>,
}));

vi.mock("../../../config/release-channel", async (original) => ({
  ...(await original<typeof import("../../../config/release-channel")>()),
  isFeatureEnabled: (feature: string) =>
    feature === "unified-workspaces" ? s.unified : feature === "cloud-workspaces" ? s.cloudFeature : true,
}));
vi.mock("../../../platform/settings", () => ({
  getSetting: (key: string, fallback: unknown) => (s.settings.has(key) ? s.settings.get(key) : fallback),
  setSetting: (key: string, value: unknown) => s.settings.set(key, value),
}));
vi.mock("../../../state/use-organization-projects", () => ({
  useOrganizationProjects: () => ({ projects: s.projects }),
}));
vi.mock("../../../features/team/cloud-workspace-pause", () => ({
  useOrganizationCloudPaused: () => false,
  CloudWorkspacePausedNotice: () => null,
}));
vi.mock("../../../features/team/team-store", async (original) => ({
  ...(await original<typeof import("../../../features/team/team-store")>()),
  getActiveOrganizationIdSnapshot: () => (s.organization.isPersonal ? null : s.organization.id),
  getActiveOrganizationSnapshot: () => s.organization,
  useActiveOrganization: () => s.organization,
}));
vi.mock("../../../state/store", async (original) => ({
  ...(await original<typeof import("../../../state/store")>()),
  useWorkspaceDispatch: () => s.dispatch,
  useChats: () => [],
  useActiveChatId: () => null,
}));
vi.mock("../../../features/agent/agents-cache", () => ({
  useAgentsSnapshot: () => [],
  loadAgents: vi.fn(async () => []),
}));
vi.mock("../../../features/agent/sessions-hooks", () => ({ useAgentSessions: () => ({ listAgents: vi.fn() }) }));
vi.mock("../../../platform/bridge/use-bridge", () => ({ useBridgeStatus: () => "disconnected" }));
vi.mock("../../../platform/runtime", async (original) => ({
  ...(await original<typeof import("../../../platform/runtime")>()),
  useNativeRuntime: () => ({ ready: false, expectedElectron: false }),
}));
vi.mock("../create-from-source", () => ({ CreateFromSource: () => null, warmCreateSourceProject: () => {} }));
vi.mock("../cloud-computer-source", () => ({
  CloudComputerSourcePicker: () => null,
  computerSourceReadKey: () => "source",
  warmComputerSources: () => {},
}));
vi.mock("../dispatcher-composer", () => ({
  DispatcherComposer: ({ draftKey }: { draftKey: string | null }) => {
    s.composerKeys.push(draftKey);
    return createElement("div", { "data-composer": draftKey ?? "none" });
  },
}));
vi.mock("../cloud-create", () => ({
  useCloudCreate: (_a: boolean, _b: unknown, _c: unknown, _d: unknown, placement?: "local" | "cloud") => {
    const computerMode = placement === "cloud";
    const repository = { id: "repo-1", owner: "withso", name: "zeros", defaultBranch: "main" };
    return {
      reason: computerMode ? s.cloudReason : null,
      checking: false,
      organization: s.organization,
      repository: null,
      baseBranch: null,
      computerMode,
      computerOwner: s.organization.isPersonal ? null : JSON.stringify(["member", s.organization.id]),
      computerRepository: computerMode && !s.organization.isPersonal ? repository : null,
      rememberedRepositoryId: s.organization.isPersonal ? null : "repo-1",
      computerRepositories: s.organization.isPersonal ? [] : [repository],
      selectComputerRepository: vi.fn(),
      sourceOwner: null,
      computerBase: null,
      defaultBranch: "main",
      refreshComputer: vi.fn(),
      recoverComputerError: vi.fn(),
      isCurrentComputerSource: () => false,
      warm: () => {},
      warmAccess: () => {},
      warmRepositoryAccess: () => {},
      computerRequired: false,
      computerReason: null,
      canManageComputer: false,
      warmComputer: () => {},
    };
  },
}));

import { DispatcherPage } from "../dispatcher-modal";
import { TooltipProvider } from "../../../shared/ui/primitives/tooltip";
import { createComposerDrafts, createComposerDraftKey, createComposerDraftOwner } from "../../../state/create-composer-drafts";
import { CONTROL_PLANE_URL } from "../../../features/team/control-plane";

let container: HTMLDivElement;
let root: Root | null = null;
const noop = () => {};

function render() {
  act(() => {
    root?.render(
      createElement(TooltipProvider, null,
        createElement(DispatcherPage, { active: true, onOpenProject: noop, onOpenGithubProject: noop, onQuickStart: noop })),
    );
  });
}
const control = () => container.querySelector('[role="tablist"][aria-label="Where the workspace runs"]');
const tab = (name: string) => container.querySelector(`[role="tab"][aria-label="${name}"]`) as HTMLElement | null;
const press = (element: HTMLElement) => {
  act(() => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
};
const localDraft = createComposerDraftKey({ owner: "local", placement: "local", project: "/Users/me/zeros" });
const cloudDraft = () =>
  createComposerDraftKey({
    owner: createComposerDraftOwner({ backend: CONTROL_PLANE_URL, userId: "member", organizationId: ORG })!,
    placement: "cloud",
    project: "repo-1",
  });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  s.unified = true;
  s.cloudFeature = true;
  s.settings.clear();
  s.organization = { id: ORG, name: "Withso", isPersonal: false };
  s.projects = [
    { id: "local-zeros", name: "Zeros", repoRoot: "/Users/me/zeros", repoSlug: "zeros" },
    { id: "cloud-zeros", name: "zeros", repoRoot: `cloud://${ORG}/22222222-2222-4222-8222-222222222222`, repoSlug: "zeros" },
  ];
  s.cloudReason = null;
  s.dispatch.mockClear();
  s.composerKeys = [];
  for (const key of [localDraft, cloudDraft()]) createComposerDrafts.delete(key);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("Create placement control", () => {
  it("is a two-state This Mac / Cloud control at the end of the project row", () => {
    render();
    const list = control();
    expect(list).not.toBeNull();
    expect(list!.closest("[data-dispatcher-context]")).not.toBeNull();
    expect(tab("This Mac")?.getAttribute("aria-selected")).toBe("true");
    expect(tab("Cloud")?.getAttribute("aria-selected")).toBe("false");
  });

  it("is hidden where cloud is off, and absent without unified-workspaces", () => {
    s.cloudFeature = false;
    render();
    expect(control()).toBeNull();
    s.cloudFeature = true;
    s.unified = false;
    render();
    expect(control()).toBeNull();
  });

  it("starts in the cloud when this Mac has no projects and remembers the last choice", () => {
    s.projects = s.projects.filter((project) => project.repoRoot.startsWith("cloud://"));
    render();
    expect(tab("Cloud")?.getAttribute("aria-selected")).toBe("true");
    press(tab("This Mac")!);
    expect(s.settings.get("create:placement:v1")).toBe("local");
    render();
    expect(tab("This Mac")?.getAttribute("aria-selected")).toBe("true");
  });

  it("lists only local projects on This Mac", () => {
    render();
    const trigger = container.querySelector('[aria-label="Choose project"]');
    expect(trigger?.textContent).toContain("Zeros");
    expect(container.querySelector("[data-composer]")?.getAttribute("data-composer")).toBe(localDraft);
  });

  it("carries the unsent prompt across a flip and back", () => {
    render();
    createComposerDrafts.set(localDraft, { text: "ship it", json: null, attachments: [] });
    press(tab("Cloud")!);
    expect(createComposerDrafts.get(cloudDraft())?.draft.text).toBe("ship it");
    expect(createComposerDrafts.get(localDraft)).toBeUndefined();
    expect(container.querySelector("[data-composer]")?.getAttribute("data-composer")).toBe(cloudDraft());
    press(tab("This Mac")!);
    expect(createComposerDrafts.get(localDraft)?.draft.text).toBe("ship it");
  });

  it("explains a blocked cloud side in the tray under the composer, with nothing above it", () => {
    s.settings.set("create:placement:v1", "cloud");
    s.cloudReason = "Creating a cloud workspace requires Pro.";
    render();
    const tray = container.querySelector("[data-composer-tray]");
    expect(tray?.textContent).toContain("Creating a cloud workspace requires Pro.");
    const composer = tray!.querySelector("[data-composer]")!;
    const status = tray!.querySelector('[role="status"]')!;
    expect(composer.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const section = container.querySelector('section[aria-label="Workspace prompt"]')!;
    expect(section.previousElementSibling?.hasAttribute("data-dispatcher-context")).toBe(true);
  });

  it("keeps the personal home's cloud side selectable with the existing reason", () => {
    s.organization = { id: "local-personal", name: "Personal", isPersonal: true };
    s.settings.set("create:placement:v1", "cloud");
    s.cloudReason = "Select an organization with Cloud access.";
    render();
    expect(tab("Cloud")?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("[data-composer-tray]")?.textContent).toContain("Select an organization with Cloud access.");
    expect(container.querySelector("[data-composer]")?.getAttribute("data-composer")).toBe(
      createComposerDraftKey({ owner: "local", placement: "cloud", project: null }),
    );
  });
});
