import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import type { Me, OrganizationSummary } from "../../features/team/control-plane";
const state = vi.hoisted(() => ({
  userId: "nonstaff-member" as string | null,
  cloudEntitled: true,
  native: true,
  enabledReads: [] as boolean[],
}));
function accountSnapshot(): Me | null {
  if (!state.userId) return null;
  const organizations = [
    { id: "11111111-1111-4111-8111-111111111111", isPersonal: false, role: "member",
      workspaceCapabilities: { local: true, cloud: state.cloudEntitled } },
    { id: "99999999-9999-4999-8999-999999999999", isPersonal: false, role: "member",
      workspaceCapabilities: { local: true, cloud: true } },
  ] as OrganizationSummary[];
  return {
    user: { id: state.userId, email: "fixture@example.test", displayName: null, staffRole: null },
    organizations, teams: organizations,
  };
}

vi.mock("../../platform/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("../../platform/runtime")>(),
  useNativeRuntime: () => ({ ready: state.native }),
  nativeInvoke: vi.fn(),
}));
vi.mock("../../features/team/team-store", () => ({
  getOrganizationStoreGeneration: () => 1,
  getTeamStoreState: () => ({ me: accountSnapshot() }),
  useTeams: () => ({ me: accountSnapshot() }),
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
          : key?.startsWith('["1"') ? undefined : [],
      refresh: vi.fn(),
    };
  },
}));
vi.mock("../../state/use-cloud-workspace-detected-ports", () => ({ useCloudWorkspaceDetectedPorts: () => ({ data: undefined }) }));
import { CloudWorkspaceAccessControls, CloudWorkspaceAccessContent, validCloudWorkspacePort } from "../conversation/cloud-workspace-access-controls";
import { TooltipProvider } from "../../shared/ui/primitives";

const workspace = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: "11111111-1111-4111-8111-111111111111",
  status: "ready",
  placement: "cloud",
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
  mode: "ssh" | "ports" = "ssh",
) =>
  renderToStaticMarkup(
    createElement(TooltipProvider, { children: createElement(CloudWorkspaceAccessControls, {
      workspace: { ...workspace, ...overrides },
      active,
      mode,
    }) }),
  );
beforeEach(() => {
  state.userId = "nonstaff-member";
  state.cloudEntitled = true;
  state.native = true;
  state.enabledReads = [];
});
describe("authorized native access controls", () => {
  it("admits a nonstaff Cloud member without a preference and uses the qualified Terminal fallback", () => {
    const html = render();
    expect(html).toContain("Open in Terminal");
    expect(html).toContain('aria-label="SSH options"');
    expect(html).not.toContain("Workspace port");
    expect(html).not.toContain("SSH commands are single-use");
    expect(html).not.toMatch(/Cursor|VS Code/);
  });
  it("fails closed for missing edit authority, prompters and viewers", () => {
    for (const canEdit of [undefined, false]) {
      const html = render({
        capabilities: { ...workspace.capabilities, canEdit },
      });
      expect(html).toMatch(/<button(?=[^>]*aria-label="Open via SSH in Terminal")(?=[^>]*disabled="")[^>]*>/);
      expect(html).toContain("Editing access is required");
    }
  });
  it("does not read or expose a Cloud surface when its target entitlement is revoked or hidden", () => {
    state.cloudEntitled = false;
    expect(render()).toBe("");
    expect(state.enabledReads.every((value) => !value)).toBe(true);
    state.cloudEntitled = true;
    state.enabledReads = [];
    expect(render({}, false)).toBe("");
    expect(state.enabledReads.every((value) => !value)).toBe(true);
  });
  it("does not expose SSH or port reads after sign-out despite retained edit capabilities", () => {
    state.userId = null;
    expect(render()).toBe("");
    expect(render({}, true, "ports")).toBe("");
    expect(state.enabledReads).toEqual([]);
  });
  it("requires a running workspace and the desktop native runtime", () => {
    expect(render({ status: "stopped" })).toMatch(/<button(?=[^>]*aria-label="Open via SSH in Terminal")(?=[^>]*disabled="")[^>]*>/);
    state.native = false;
    expect(render()).toContain("Use the Mac app");
    expect(render({}, true, "ports")).toContain('aria-label="Add port" disabled=""');
  });
  it("never offers execution access to a retired runtime with a retained ready status", () => {
    const html = render({ capabilities: { ...workspace.capabilities,
      startUnavailableReason: "cloud_workspace_v2_required" } });
    expect(html).toMatch(/<button(?=[^>]*aria-label="Open via SSH in Terminal")(?=[^>]*disabled="")[^>]*>/);
    expect(html).toContain("This workspace uses a retired cloud runtime — create a new workspace.");
  });
  it("shows forwarding off and auto on as unavailable until the native preference contract responds", () => {
    const html = render({}, true, "ports");
    expect(html).toContain("Forward to localhost");
    expect(html).toContain("Auto-forwarding");
    expect(html).not.toContain("Preview URL");
    expect(html).not.toContain(">Workspace port");
    expect(html).toContain("Detected ports unavailable");
  });
  it("does not attach cloud controls or reads to a Local placement", () => {
    expect(render({ placement: "local" } as never)).toBe("");
    expect(state.enabledReads).toEqual([]);
  });
  it.each([["1024", true], ["65535", true], ["1023", false], ["65536", false], ["12.5", false], ["", false]])("validates manual port %s", (port, valid) => {
    expect(validCloudWorkspacePort(port as string)).toBe(valid);
  });
  it("distinguishes detected listeners from forwarded ports and filters old generation services", () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, { children: createElement(CloudWorkspaceAccessContent, {
      workspace, mode: "ports", native: true, context: { authorityId: "scope", deviceId: null, keyVersion: null }, readError: false,
      forwarding: { forwardingEnabled: true, autoForwardEnabled: true }, onForwardingChange: async () => {},
      detectedPorts: [{ port: 3000, processLabel: "Web server" }],
      rows: [{ accessId: "forward", kind: "tunnel", generation: 1, localPort: 4173, remotePort: 4173, closing: false, expiresAt: "2026-10-03T00:00:00Z" },
        { accessId: "old", kind: "tunnel", generation: 2, localPort: 9999, remotePort: 9999, closing: false, expiresAt: "2026-10-03T00:00:00Z" }],
    }) }));
    expect(html).toContain("Web server");
    expect(html).toContain('aria-label="Copy localhost:4173"');
    expect(html).toContain('aria-label="Stop forwarding port 4173"');
    expect(html).not.toContain("9999");
  });
});
