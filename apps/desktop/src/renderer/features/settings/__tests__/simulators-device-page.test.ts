import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";
import type { SimulatorHubState } from "../../simulators/simulator-hub-store";

vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useLayoutEffect: () => {} }));

const state = vi.hoisted(() => ({
  organization: { id: "org-a", isPersonal: false } as {
    id: string;
    isPersonal: boolean;
  } | null,
  selected: "org-a" as string,
  workspace: null as Pick<Workspace, "path" | "organizationId" | "placement"> | null,
  effective: {} as Record<string, unknown>,
  sources: {} as Record<string, unknown>,
  hub: { snapshot: null, error: null, loading: false } as SimulatorHubState,
  read: vi.fn(),
  layer: vi.fn(),
  hubRead: vi.fn(),
}));
vi.mock("../../team/team-store", () => ({
  useActiveOrganization: () => state.organization,
  getActiveOrganizationIdSnapshot: () => state.selected,
}));
vi.mock("../../../state/use-active-workspace", () => ({
  useActiveWorkspace: () => ({ workspace: state.workspace }),
}));
vi.mock("../use-settings", () => ({
  useResolvedSettings: () => {
    state.read();
    return { resolved: { effective: state.effective, sources: state.sources }, refresh() {} };
  },
  useSettingsLayer: () => {
    state.layer();
    return { write: vi.fn(async () => ({})) };
  },
}));
vi.mock("../../simulators/simulator-hub-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../simulators/simulator-hub-store")>()),
  useSimulatorHub: () => {
    state.hubRead();
    return state.hub;
  },
}));
vi.mock("../../../platform/runtime", () => ({
  nativeInvoke: vi.fn(async () => null),
  nativeListen: vi.fn(async () => () => {}),
  useNativeRuntime: () => ({ ready: false }),
}));
vi.mock("../../../platform/app", () => ({ shellOpenUrl: vi.fn() }));
vi.mock("../../../shared/ui/primitives/elements", () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
}));

import { SimulatorsPanel } from "../simulators-panel";

beforeEach(() => {
  state.organization = { id: "org-a", isPersonal: false };
  state.selected = "org-a";
  state.workspace = { path: "cloud://org-a/workspace", organizationId: "org-a", placement: "cloud" };
  vi.clearAllMocks();
});

describe("Simulators as a unified device page", () => {
  it("shows this Mac's controls under an organization with a cloud workspace open", () => {
    const html = renderToStaticMarkup(createElement(SimulatorsPanel, { unified: true }));
    expect(html).not.toContain("Unavailable in cloud workspaces");
    expect(state.read).toHaveBeenCalled();
  });
  it("keeps the organization state in the old rail", () => {
    expect(renderToStaticMarkup(createElement(SimulatorsPanel, {}))).toContain("Unavailable in cloud workspaces");
  });
});
