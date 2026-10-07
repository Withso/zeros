import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import type { Me, OrganizationSummary } from "../../features/team/control-plane";
import type { CloudWorkspaceCollaborators } from "../../platform/cloud-workspace-collaboration";
import { TooltipProvider } from "../../shared/ui/primitives/tooltip";

const state = vi.hoisted(() => ({
  userId: "33333333-3333-4333-8333-333333333333" as string | null, cloudEntitled: true, data: undefined as CloudWorkspaceCollaborators | undefined, error: null as Error | null, refreshing: false,
  read: vi.fn(), load: vi.fn(), fetch: vi.fn(), mutate: vi.fn(), warm: vi.fn(),
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
vi.mock("../../features/team/team-store", () => ({
  getOrganizationStoreGeneration: () => 0,
  getTeamStoreState: () => ({ me: accountSnapshot() }), useTeams: () => ({ me: accountSnapshot() }),
}));
vi.mock("../../state/use-cached-read", () => ({ useCachedRead: (...args: unknown[]) => {
  state.read(...args); return { data: state.data, error: state.error, refreshing: state.refreshing };
} }));
vi.mock("../../state/cloud-workspace-collaboration-cache", () => ({
  CLOUD_COLLABORATION_MAX_AGE_MS: 10_000,
  cloudWorkspaceCollaboration: { snapshots: {}, fetch: state.fetch, load: state.load, mutate: state.mutate },
  cloudWorkspaceCollaborationOwner: (target: object) => ({ ...target, accountId: "33333333-3333-4333-8333-333333333333" }),
  cloudWorkspaceCollaborationKey: (owner: object) => JSON.stringify(owner), warmCloudWorkspaceCollaboration: state.warm,
}));
vi.mock("../../state/cloud-workspace-catalog", () => ({ refreshCloudWorkspace: vi.fn(), cloudCatalogGeneration: () => 0, cloudWorkspaceDetails: {} }));
vi.mock("../conversation/cloud-workspace-popover", () => ({ CloudWorkspacePopover: ({ workspace, active, children }: { workspace: CloudWorkspaceDocument; active: boolean; children: (active: boolean) => ReactNode }) =>
  active && workspace.placement === "cloud" && cloudWorkspaceAccountAccess(accountSnapshot(), workspace.organizationId) ? children(true) : null }));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../../shared/ui", () => ({
  Button: ({ children, disabled, "aria-label": label }: { children: ReactNode; disabled?: boolean; "aria-label"?: string }) => createElement("button", { disabled, "aria-label": label }, children),
  Input: (props: { "aria-label": string; disabled?: boolean; value?: string }) => createElement("input", { ...props, onChange: () => {} }),
}));
vi.mock("../../shared/ui/primitives/select", () => ({
  Select: ({ children, disabled, value }: { children: ReactNode; disabled?: boolean; value?: string }) => createElement("div", { "data-value": value, "data-disabled": disabled }, children),
  SelectTrigger: ({ children, "aria-label": label }: { children: ReactNode; "aria-label": string }) => createElement("button", { "aria-label": label }, children),
  SelectValue: () => null, SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ children, disabled, value }: { children: ReactNode; disabled?: boolean; value: string }) => createElement("option", { value, disabled }, children),
}));
import { cloudWorkspaceAccountAccess } from "../../features/team/cloud-workspace-account-access";
import { CloudWorkspaceSharePopover, CloudWorkspaceSharingManager } from "../conversation/cloud-workspace-sharing-controls";

let workspace: CloudWorkspaceDocument;
const userId = "44444444-4444-4444-8444-444444444444";
const render = (manager = false, active = true) => renderToStaticMarkup(createElement(TooltipProvider, null,
  createElement(manager ? CloudWorkspaceSharingManager : CloudWorkspaceSharePopover, { workspace, active })));
beforeEach(() => {
  vi.clearAllMocks(); state.userId = "33333333-3333-4333-8333-333333333333"; state.cloudEntitled = true; state.error = null; state.refreshing = false;
  workspace = {
    id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111", teamId: "team",
    createdBy: "33333333-3333-4333-8333-333333333333", ownerUserId: "33333333-3333-4333-8333-333333333333",
    actorRole: "owner", sharingMode: "organization", accessRevision: 2, placement: "cloud", name: "Sharing fixture", status: "ready", version: 1,
    error: null, createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z", deletedAt: null,
    capabilities: { canWrite: true, canEdit: true, canManage: true, canStart: false, startUnavailableReason: null },
    repository: { forge: "github.com", owner: "example", name: "fixture", revision: "main" },
    generation: { number: 1, architecture: "linux/amd64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "ready", lastObservedAt: null },
  };
  state.data = {
    workspaceId: workspace.id, organizationId: workspace.organizationId, accessRevision: 2, writers: { limit: 10, used: 1, available: 9 },
    guests: [], invitations: [], members: [{ userId: workspace.createdBy, role: "owner" }, { userId, role: "viewer", displayName: "Fixture viewer" }],
    guestCursor: null, invitationCursor: null, memberCursor: null,
  };
});

describe("staff sharing controls", () => {
  it("keeps Share compact with one people list, general access last and no empty sections", () => {
    const html = render();
    expect(html).toContain(">Share</h2>");
    expect(html).toContain("People with access");
    expect(html).toContain("General access");
    expect(html.indexOf("Collaborator email")).toBeLessThan(html.indexOf("People with access"));
    expect(html.indexOf("Fixture viewer")).toBeLessThan(html.indexOf("General access"));
    expect(html.indexOf("General access")).toBeLessThan(html.indexOf("1 / 10 writer slots used"));
    for (const removed of ["Refresh collaborators", "Private keeps the owner", "No guest access.", "No pending invitations."])
      expect(html).not.toContain(removed);
  });
  it("merges guest and pending invitation rows without losing roles, expiry or revoke actions", () => {
    state.data!.guests = [{ id: userId, userId, role: "prompter", displayName: "Fixture prompter", revision: 1, expiresAt: "2026-11-01T00:00:00Z" }];
    state.data!.invitations = [{ id: "77777777-7777-4777-8777-777777777777", role: "developer", expiresAt: "2026-11-01T00:00:00Z", deliveryState: "dead" }];
    const html = render(true);
    expect(html.match(/People with access/g)).toHaveLength(1);
    expect(html).toContain("Fixture prompter"); expect(html).toContain("Expires");
    expect(html).toContain("Remove guest access for Fixture prompter");
    expect(html).toContain("Cancel invitation"); expect(html).toContain("Delivery failed");
    expect(html).not.toContain("Fixture viewer");
    expect(html).not.toContain(">Guests</h3>"); expect(html).not.toContain(">Pending invitations</h3>");
  });
  it("gates discovery, forms and reads on account access and active visibility", () => {
    state.cloudEntitled = false;
    expect(render()).toBe(""); expect(render(true)).toBe("");
    expect(state.read.mock.calls.at(-1)![3]).toMatchObject({ enabled: false });
    state.cloudEntitled = true;
    expect(render(false, false)).toBe(""); expect(render(true, false)).toBe("");
    expect(state.read.mock.calls.at(-1)![1]).toBeNull();
    expect(state.fetch).not.toHaveBeenCalled(); expect(state.load).not.toHaveBeenCalled();
  });
  it("keeps sharing forms and reads inert after sign-out even with retained owner capabilities", () => {
    state.userId = null;
    expect(render()).toBe(""); expect(render(true)).toBe("");
    expect(state.read.mock.calls.at(-1)![1]).toBeNull();
    expect(state.read.mock.calls.at(-1)![3]).toMatchObject({ enabled: false });
    expect(state.fetch).not.toHaveBeenCalled(); expect(state.load).not.toHaveBeenCalled();
  });
  it.each(["viewer", "prompter", "developer"] as const)("shows %s authority without manager controls, even for staff with an admin-like coarse flag", role => {
    workspace.actorRole = role;
    // Internal staff eligibility is already true, and the coarse flag alone
    // cannot substitute for the server's precise role projection.
    workspace.capabilities.canManage = true;
    expect(render()).toContain(role[0].toUpperCase() + role.slice(1));
    expect(render()).not.toContain("Manage sharing");
    expect(render(true)).toBe("");
    expect(state.read.mock.calls.at(-1)![3]).toMatchObject({ enabled: false });
  });
  it("fails closed when an older document lacks the actor role or revision", () => {
    workspace.actorRole = undefined;
    expect(render()).toContain("permissions are unavailable");
    expect(render()).not.toContain("Manage sharing");
    workspace.actorRole = "owner"; workspace.accessRevision = undefined;
    expect(render()).not.toContain("Manage sharing");
  });
  it("offers owner/manager controls and protects the owner assignment", () => {
    for (const role of ["owner", "manager"] as const) {
      workspace.actorRole = role;
      expect(render()).toContain("Collaborator email");
      const html = render(true);
      expect(html).toContain("Collaborator email"); expect(html).toContain("Fixture viewer");
      expect(html).toContain("Role for Fixture viewer");
      expect(html).not.toContain(`Role for ${userId}`);
      expect(html).not.toContain("Role for You");
      expect(html).not.toContain("Remove assignment for You");
    }
  });
  it("offers explicit collaboration enablement while preserving private scope", () => {
    workspace.sharingMode = "private";
    expect(render(true)).toContain("Enable collaboration");
    state.data!.accessRevision = 3;
    expect(render(true)).toContain('<button disabled="">Enable collaboration</button>');
    workspace.sharingMode = "organization";
    expect(render(true)).not.toContain("Enable collaboration");
  });
  it("respects full writer slots and the invited prompter role without offering unsupported assignments", () => {
    state.data!.writers = { limit: 10, used: 10, available: 0 };
    state.data!.guests = [{ id: userId, userId, role: "prompter", displayName: "Fixture prompter", revision: 1, expiresAt: "2026-11-01T00:00:00Z" }];
    const html = render(true);
    expect(html).toContain("10 / 10 writer slots used"); expect(html).toContain("All writer slots are in use");
    expect(html).toContain('<option value="developer" disabled="">Developer</option>');
    expect(html).toContain('<option value="prompter" disabled="">Prompter</option>');
    expect(html).toContain("Remove guest access for Fixture prompter");
    expect(html).not.toContain("Fixture viewer");
    expect(html).not.toContain('<option value="manager"');
  });
  it("keeps legacy organization-funded assignments read-only and preserves guest invitation controls", () => {
    state.data!.writers = null;
    const html = render(true);
    expect(html).toContain("Assigned roles"); expect(html).toContain("Collaborator email");
    expect(html).not.toContain("writer slots used");
    expect(html).not.toContain("Organization members retain viewer access");
    expect(html).not.toContain(`Role for ${userId}`); expect(html).not.toContain("Remove assignment for");
  });
  it("exposes each independent cursor and disables writes until sharing metadata matches", () => {
    state.data!.guestCursor = userId; state.data!.memberCursor = userId; state.data!.invitationCursor = userId;
    state.data!.accessRevision = 3;
    const html = render(true);
    expect(html).toContain("More members"); expect(html).toContain("More guests"); expect(html).toContain("More invitations");
    expect(html).toContain("Sharing changed. Reload"); expect(html).toContain("Reload sharing"); expect(html).toContain('data-disabled="true"');
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it("keeps a denied read actionable without retaining collaborator forms", () => {
    state.data = undefined; state.error = new Error("Workspace management required");
    const html = render(true);
    expect(html).toContain('role="alert"'); expect(html).toContain("Reload sharing");
    expect(html).not.toContain("Collaborator email");
  });
  it("retains confirmed rows but pauses pagination during revalidation", () => {
    state.refreshing = true; state.data!.memberCursor = userId;
    const html = render(true);
    expect(html).toContain("Fixture viewer");
    expect(html).toContain('<button disabled="">More members</button>');
  });
});
