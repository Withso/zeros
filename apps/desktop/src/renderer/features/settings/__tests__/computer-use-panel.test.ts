import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
        effective: state.selected === "managed" ? {} : {},
        sources:
          state.selected === "managed"
            ? { "computer_use.enabled": "managed" }
            : {},
      },
      refresh() {},
    };
  },
  useSettingsLayer: () => {
    state.layer();
    return { write: vi.fn(async () => ({})) };
  },
}));
vi.mock("../../../platform/runtime", () => ({
  nativeInvoke: state.invoke,
  nativeListen: vi.fn(async () => () => {}),
  useNativeRuntime: () => ({ ready: false }),
}));
vi.mock("../../../shared/ui/primitives/elements", () => ({
  toast: { error: vi.fn() },
}));

import { ComputerUsePanel } from "../computer-use-panel";

beforeEach(() => {
  state.organization = { id: "org-a", isPersonal: false };
  state.selected = "org-a";
  state.workspace = {
    path: "cloud://org-a/workspace",
    organizationId: "org-a",
    placement: "cloud",
  };
  vi.clearAllMocks();
});

describe("Computer use settings panel", () => {
  it("shows placement guidance for a cloud workspace without reading Local settings", () => {
    const html = renderToStaticMarkup(createElement(ComputerUsePanel));
    expect(html).toContain("Unavailable in cloud workspaces");
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("Add app");
    expect(state.read).not.toHaveBeenCalled();
    expect(state.layer).not.toHaveBeenCalled();
  });

  it("does not flash Local controls while the organization is loading", () => {
    state.organization = null;
    state.workspace = {
      path: "/workspace",
      organizationId: "org-a",
      placement: "local",
    };
    const html = renderToStaticMarkup(createElement(ComputerUsePanel));
    expect(html).not.toContain('role="switch"');
    expect(state.read).not.toHaveBeenCalled();
  });

  it.each(["local", undefined] as const)(
    "offers device controls for an organization-local workspace (placement: %s)",
    (placement) => {
      state.workspace = {
        path: "/workspace",
        organizationId: "org-a",
        placement,
      };
      const html = renderToStaticMarkup(createElement(ComputerUsePanel));
      expect(html).toContain('id="computer-use-enabled"');
      expect(html).not.toContain("Unavailable in cloud workspaces");
      expect(state.read).toHaveBeenCalledOnce();
      expect(state.layer).toHaveBeenCalledOnce();
    },
  );

  it("keeps computer use off until enabled, with Codex on its built-in default", () => {
    state.organization = { id: "personal", isPersonal: true };
    state.selected = "";
    const html = renderToStaticMarkup(createElement(ComputerUsePanel));
    expect(html).toMatch(
      /aria-checked="false"[^>]*id="computer-use-enabled"/,
    );
    expect(html).toMatch(
      /aria-checked="true"[^>]*id="computer-use-codex-native"/,
    );
    expect(html).toMatch(
      /aria-checked="true"[^>]*id="computer-use-show-agent-cursor"/,
    );
    // The shipped blocked apps are named without waiting on Launch Services.
    expect(html).toContain("Keychain Access");
    expect(html).toContain("com.apple.systempreferences");
    expect(html).toContain("Add app");
    // No native bridge answered, so the permission walkthrough stays hidden.
    expect(html).not.toContain("Grant access");
  });

  it("marks managed rows instead of offering an override", () => {
    state.organization = { id: "personal", isPersonal: true };
    state.selected = "managed";
    const html = renderToStaticMarkup(createElement(ComputerUsePanel));
    expect(html).toContain("Managed");
    expect(html).toMatch(
      /disabled=""[^>]*id="computer-use-enabled"|id="computer-use-enabled"[^>]*disabled=""/,
    );
  });
});
