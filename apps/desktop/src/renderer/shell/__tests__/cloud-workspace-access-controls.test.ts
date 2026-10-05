import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
const state = vi.hoisted(() => ({
  internal: true,
  native: true,
  enabledReads: [] as boolean[],
}));
vi.mock("../../features/settings/internal-features", () => ({
  useInternalFeatureActive: (key: string) =>
    state.internal && key === "cloudComputerV2",
}));
vi.mock("../../platform/runtime", () => ({
  useNativeRuntime: () => ({ ready: state.native }),
  nativeInvoke: vi.fn(),
}));
vi.mock("../../features/team/team-store", () => ({
  getOrganizationStoreGeneration: () => 1,
}));
vi.mock("../../state/use-cached-read", () => ({
  useCachedRead: (
    _cache: unknown,
    key: string | null,
    _fetch: unknown,
    options: { enabled?: boolean },
  ) => {
    state.enabledReads.push(!!options.enabled && !!key);
    return {
      data:
        key === "1"
          ? { authorityId: "scope", deviceId: null, keyVersion: null }
          : [],
      refresh: vi.fn(),
    };
  },
}));
vi.mock("../../shared/ui", () => ({
  Button: ({
    children,
    disabled,
  }: {
    children: ReactNode;
    disabled?: boolean;
  }) => createElement("button", { disabled }, children),
  Input: ({ id, ...props }: Record<string, unknown>) =>
    createElement("input", { ...props, id }),
}));
import { CloudWorkspaceAccessControls } from "../conversation/cloud-workspace-access-controls";

const workspace = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: "11111111-1111-4111-8111-111111111111",
  status: "ready",
  generation: { number: 1 },
  capabilities: {
    canWrite: true,
    canManage: true,
    canStart: true,
    canEdit: true,
  },
} as CloudWorkspaceDocument;
const render = (
  overrides: Partial<CloudWorkspaceDocument> = {},
  active = true,
) =>
  renderToStaticMarkup(
    createElement(CloudWorkspaceAccessControls, {
      workspace: { ...workspace, ...overrides },
      active,
    }),
  );
beforeEach(() => {
  state.internal = true;
  state.native = true;
  state.enabledReads = [];
});
describe("staff native access controls", () => {
  it("offers Terminal, a copied command and explicit loopback forwarding to editors", () => {
    const html = render();
    expect(html).toContain("Open Terminal");
    expect(html).toContain("Copy SSH command");
    expect(html).toContain("Forward port");
    expect(html).toContain("127.0.0.1");
    expect(html).not.toMatch(/Cursor|VS Code/);
  });
  it("fails closed for missing edit authority, prompters and viewers", () => {
    for (const canEdit of [undefined, false]) {
      const html = render({
        capabilities: { ...workspace.capabilities, canEdit },
      });
      expect(html).toContain('<button disabled="">Open Terminal</button>');
      expect(html).toContain("Editing access is required");
    }
  });
  it("does not read or expose an internal surface while gated off or hidden", () => {
    state.internal = false;
    expect(render()).toBe("");
    expect(state.enabledReads.every((value) => !value)).toBe(true);
    state.internal = true;
    state.enabledReads = [];
    expect(render({}, false)).toBe("");
    expect(state.enabledReads.every((value) => !value)).toBe(true);
  });
  it("requires a running workspace and the desktop native runtime", () => {
    expect(render({ status: "stopped" })).toContain(
      '<button disabled="">Open Terminal</button>',
    );
    state.native = false;
    expect(render()).toContain("Use the Mac app");
    expect(render()).toContain('<button disabled="">Forward port</button>');
  });
});
