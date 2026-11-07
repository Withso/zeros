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

const LOCAL_WORKSPACE = {
  path: "/workspace",
  organizationId: "org-a",
  placement: "local" as const,
};

beforeEach(() => {
  state.organization = { id: "org-a", isPersonal: false };
  state.selected = "org-a";
  state.workspace = {
    path: "cloud://org-a/workspace",
    organizationId: "org-a",
    placement: "cloud",
  };
  state.effective = null;
  state.sources = null;
  state.features = {};
  state.status = null;
  vi.clearAllMocks();
});

function asLocalOwner(): void {
  state.organization = { id: "personal", isPersonal: true };
  state.selected = "";
}

const section = () => renderToStaticMarkup(createElement(ComputerUseSettingsSection));
const permissions = () => renderToStaticMarkup(createElement(ComputerPermissionRows));

/** The opening tag of the control with this id, attributes in any order. */
function tag(html: string, id: string): string {
  const found = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0];
  if (!found) throw new Error(`no control #${id}`);
  return found;
}

describe("Computer use in Settings → General", () => {
  it("lets agents use any unblocked app, with one agent cursor switch", () => {
    asLocalOwner();
    const html = section();
    expect(html).toContain("Agents can use any app except blocked apps.");
    expect(tag(html, "computer-use-enabled")).toContain('aria-checked="true"');
    expect(tag(html, "computer-use-show-agent-cursor")).toContain('aria-checked="true"');
    expect(html).toContain("In apps and the browser.");
    // The shipped blocked apps are named without waiting on Launch Services.
    expect(html).toContain("Keychain Access");
    expect(html).toContain("com.apple.systempreferences");
    expect(html).toContain("Add app");
    // Retired rows stay gone.
    expect(html).not.toContain("Ask before using a new app");
    expect(html).not.toContain("built-in computer use");
    expect(html).not.toContain("Grant access");
  });

  it("marks managed rows instead of offering an override", () => {
    asLocalOwner();
    state.sources = { "computer_use.enabled": "managed" };
    const html = section();
    expect(html).toContain("Managed");
    expect(tag(html, "computer-use-enabled")).toContain('disabled=""');
    expect(tag(html, "computer-use-show-agent-cursor")).not.toContain('disabled=""');
  });

  it("says when this copy of Zeros cannot use the Mac", () => {
    asLocalOwner();
    state.status = { version: 1, available: false, accessibility: false, screenRecording: false };
    expect(section()).toContain("Computer use unavailable");
  });

  it("keeps the cursor switch for the browser while computer use is closed", () => {
    asLocalOwner();
    state.features = { computerUse: false };
    const html = section();
    expect(html).not.toContain('id="computer-use-enabled"');
    expect(html).not.toContain("Blocked apps");
    expect(html).toContain('id="computer-use-show-agent-cursor"');
    state.features = { computerUse: false, zerosBrowser: false };
    expect(section()).toBe("");
  });

  it("shows placement guidance for a cloud workspace without reading Local settings", () => {
    const html = section();
    expect(html).toContain("Unavailable in cloud workspaces");
    expect(html).not.toContain('role="switch"');
    expect(state.read).not.toHaveBeenCalled();
    expect(state.layer).not.toHaveBeenCalled();
    state.status = { version: 1, available: true, accessibility: true, screenRecording: true };
    expect(permissions()).toBe("");
  });

  it("does not flash Local controls while the organization is loading", () => {
    state.organization = null;
    state.workspace = LOCAL_WORKSPACE;
    expect(section()).not.toContain('role="switch"');
    expect(state.read).not.toHaveBeenCalled();
  });

  it.each(["local", undefined] as const)(
    "offers this Mac's controls in an organization-local workspace (placement: %s)",
    (placement) => {
      state.workspace = { ...LOCAL_WORKSPACE, placement };
      const html = section();
      expect(html).toContain('id="computer-use-enabled"');
      expect(html).not.toContain("Unavailable in cloud workspaces");
    },
  );
});

describe("Computer use grants in Settings → General → Privacy", () => {
  it("shows each grant like Full Disk Access beside it", () => {
    asLocalOwner();
    state.status = { version: 1, available: true, accessibility: true, screenRecording: false };
    const html = permissions();
    expect(html).toContain("Accessibility");
    expect(html).toContain("Screen Recording");
    expect(html.match(/For computer use\./g)).toHaveLength(2);
    // Granted: the status and the pane; missing: a request.
    expect(html).toMatch(/aria-label="Accessibility status"[^>]*>Granted</);
    expect(html).toMatch(/aria-label="Screen Recording status"[^>]*><\/span>/);
    expect(html).toContain("Open System Settings");
    expect(html).toContain("Grant access");
  });

  it("stays out until macOS can grant them", () => {
    asLocalOwner();
    expect(permissions()).toBe("");
    state.status = { version: 1, available: false, accessibility: false, screenRecording: false };
    expect(permissions()).toBe("");
    state.status = { version: 1, available: true, accessibility: false, screenRecording: false };
    state.features = { computerUse: false };
    expect(permissions()).toBe("");
  });
});
