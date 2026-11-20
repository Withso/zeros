import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerUseStatus } from "@zeros/protocol/computer-use-tools";
import type { Workspace } from "../../../platform/git";

const state = vi.hoisted(() => ({
  organization: { id: "org-a", isPersonal: false } as {
    id: string;
    isPersonal: boolean;
  } | null,
  selected: "org-a" as string,
  workspace: null as Pick<
    Workspace,
    "path" | "organizationId" | "placement"
  > | null,
  read: vi.fn(),
  layer: vi.fn(),
  invoke: vi.fn(async () => null),
  effective: null as Record<string, unknown> | null,
  sources: null as Record<string, string> | null,
  features: {} as Record<string, boolean>,
  status: null as ComputerUseStatus | null,
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
    return {
      resolved: {
        effective: state.effective ?? {},
        sources: state.sources ?? {},
      },
      refresh() {},
    };
  },
  useSettingsLayer: () => {
    state.layer();
    return { write: vi.fn(async () => ({})) };
  },
}));
vi.mock("../agent-control-rollout", () => ({
  useAgentControlFeatureActive: (feature: string) => state.features[feature] ?? true,
}));
vi.mock("../computer-use-status", () => ({
  useComputerUseStatus: () => state.status,
  refreshComputerUseStatus: vi.fn(async () => state.status),
  requestComputerUsePermissions: vi.fn(async () => state.status),
}));
vi.mock("../../../platform/runtime", () => ({
  nativeInvoke: state.invoke,
  nativeListen: vi.fn(async () => () => {}),
  useNativeRuntime: () => ({ ready: false }),
}));
vi.mock("../../../shared/ui/primitives/elements", () => ({
  toast: { error: vi.fn() },
}));

import {
  ComputerPermissionRows,
  ComputerUseSettingsSection,
} from "../computer-use-panel";

beforeEach(() => {
  state.organization = { id: "org-a", isPersonal: false };
  state.selected = "org-a";
  state.workspace = { path: "cloud://org-a/workspace", organizationId: "org-a", placement: "cloud" };
  state.effective = null;
  state.sources = null;
  state.features = {};
  state.status = null;
  vi.clearAllMocks();
});

const page = () =>
  renderToStaticMarkup(createElement(ComputerUseSettingsSection, { device: true }));

describe("Computer use as its own unified Settings page", () => {
  it("shows this Mac's controls under an organization, whatever workspace is open", () => {
    const html = page();
    expect(html).toContain('id="computer-use-enabled"');
    expect(html).not.toContain("Unavailable in cloud workspaces");
    expect(state.read).toHaveBeenCalled();
  });

  it("does not repeat the page title as a group title", () => {
    expect(page()).not.toMatch(/<h2[^>]*>Computer use<\/h2>/);
  });

  it("does not wait for the organization snapshot", () => {
    state.organization = null;
    expect(page()).toContain('id="computer-use-enabled"');
  });

  it("keeps the old rail's organization-conditional state", () => {
    expect(renderToStaticMarkup(createElement(ComputerUseSettingsSection, {}))).toContain("Unavailable in cloud workspaces");
    state.status = { available: true, accessibility: false, screenRecording: false } as never;
    expect(renderToStaticMarkup(createElement(ComputerPermissionRows, {}))).toBe("");
    expect(renderToStaticMarkup(createElement(ComputerPermissionRows, { device: true }))).not.toBe("");
  });
});
