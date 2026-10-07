import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import type { Me, OrganizationSummary } from "../../features/team/control-plane";
import type { CloudReplicaSnapshot } from "../../state/cloud-replica-cache";

const state = vi.hoisted(() => ({ userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as string | null, cloudEntitled: true, native: true, identityError: null as Error | null,
  snapshot: { replica: null, divergences: [] } as CloudReplicaSnapshot, reads: vi.fn(),
  identities: {}, replicas: {}, epoch: 0 }));
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
  useTeams: () => ({ me: accountSnapshot() }), getTeamStoreState: () => ({ me: accountSnapshot() }),
  getOrganizationStoreGeneration: () => state.epoch,
}));
vi.mock("../../platform/runtime", async importOriginal => ({ ...await importOriginal<typeof import("../../platform/runtime")>(), useNativeRuntime: () => ({ ready: state.native }) }));
vi.mock("../../state/use-cached-read", () => ({ useCachedRead: (cache: unknown, key: string | null, _read: unknown, options: unknown) => {
  state.reads(key, options);
  return { data: cache === state.identities ? { accountUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } : state.snapshot,
    error: cache === state.identities ? state.identityError : null, refresh: vi.fn() };
} }));
vi.mock("../../state/cloud-replica-cache", () => ({
  cloudReplicaIdentityCache: state.identities, cloudReplicaCache: state.replicas, CLOUD_REPLICA_FRESHNESS_MS: 10_000,
  cloudReplicaIdentityKey: (account: string) => JSON.stringify([account, state.epoch]),
  cloudReplicaScopeKey: (scope: unknown) => JSON.stringify(scope), readCloudReplicaIdentityKey: vi.fn(), readCloudReplicaScopeKey: vi.fn(),
  warmCloudWorkspaceReplicas: vi.fn(),
}));
vi.mock("../../platform/cloud-replicas", () => ({ createCloudReplica: vi.fn(), changeCloudReplica: vi.fn(), pickCloudReplicaFolder: vi.fn() }));
vi.mock("../../platform/bridge/active-bridge", () => ({ onActiveBridgeConnected: vi.fn(() => () => {}) }));
vi.mock("../../shared/ui", () => ({ Button: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => createElement("button", { disabled }, children) }));
import { CloudWorkspaceSyncControls } from "../conversation/cloud-workspace-sync-controls";
import { TooltipProvider } from "../../shared/ui/primitives";

const workspace = { id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111",
  placement: "cloud", status: "ready", capabilities: { canEdit: true }, deletedAt: null } as CloudWorkspaceDocument;
const replica = { accountUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  workspaceId: workspace.id, organizationId: workspace.organizationId, replicaId: "33333333-3333-4333-8333-333333333333",
  rootPath: "/Users/test/copy", observedState: "in_sync", desiredState: "active", ignorePolicy: { version: 1, excludePrefixes: [] }, lastErrorCode: null } as const;
function render(overrides: Partial<CloudWorkspaceDocument> = {}, active = true) {
  return renderToStaticMarkup(createElement(TooltipProvider, { children: createElement(CloudWorkspaceSyncControls, { workspace: { ...workspace, ...overrides }, active }) }));
}
beforeEach(() => { state.userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; state.cloudEntitled = true; state.native = true; state.identityError = null; state.snapshot = { replica: null, divergences: [] }; vi.clearAllMocks(); });

describe("receive-only Mac sync controls", () => {
  it.each(["signed out", "target entitlement revoked"])("keeps replica scopes inert when %s despite another entitled organization", reason => {
    if (reason === "signed out") state.userId = null;
    else state.cloudEntitled = false;
    expect(render()).toBe("");
    expect(state.reads.mock.calls.every(([key]) => key === null)).toBe(true);
  });
  it("never attaches cloud replica scopes to a Local placement", () => {
    expect(render({ placement: "local" } as never)).toBe("");
    expect(state.reads.mock.calls.every(([key]) => key === null)).toBe(true);
  });
  it.each([undefined, false])("fails closed when canEdit is %s, including read-only warming", canEdit => {
    const html = render({ capabilities: { ...workspace.capabilities, canEdit } });
    expect(html).toContain("edit access"); expect(html).not.toContain("Choose folder");
    expect(state.reads.mock.calls.every(([key]) => key === null)).toBe(true);
  });
  it("offers the real sync toggle without generic descriptions or Refresh", () => {
    const html = render();
    expect(html).toContain('aria-label="Sync to a local directory"');
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain("Receive-only"); expect(html).not.toContain("Excluded:");
    expect(html).not.toContain("Refresh sync status");
  });
  it("shows folder/status and independent pause/remove actions without recreating the replica", () => {
    state.snapshot.replica = replica as never;
    const html = render();
    expect(html).toContain("In sync"); expect(html).toContain(replica.rootPath);
    expect(html).toContain('aria-checked="true"'); expect(html).not.toContain("Choose folder");
    state.snapshot.replica = { ...replica, desiredState: "paused", observedState: "paused" } as never;
    expect(render()).toContain('aria-checked="false"');
  });
  it("shows local divergence paths and offers an explicit cloud replacement", () => {
    state.snapshot = { replica: { ...replica, observedState: "diverged" } as never,
      divergences: [{ path: "src/local.ts", detectedAt: 1 }] };
    const html = render();
    expect(html).toContain("src/local.ts"); expect(html).toContain("Use cloud version"); expect(html).toContain("Local changes are preserved");
  });
  it("shows safe detachment and keeps files visible after access or device revocation", () => {
    state.snapshot.replica = { ...replica, observedState: "detached", lastErrorCode: "device_authority_revoked" } as never;
    const html = render();
    expect(html).toContain("Detached"); expect(html).toContain("downloaded files"); expect(html).not.toContain(">Resume<");
  });
  it("does not read or render a hidden surface and retains confirmed data after connection failure", () => {
    expect(render({}, false)).toBe("");
    expect(state.reads.mock.calls.every(([, options]) => options.enabled === false)).toBe(true);
    state.identityError = new Error("offline"); state.snapshot.replica = replica as never;
    const html = render();
    expect(html).toContain("In sync"); expect(html).toContain("last confirmed");
  });
  it("requires a running workspace for a new folder and the native Mac host", () => {
    expect(render({ status: "stopped" })).toContain("Start the workspace");
    state.native = false; expect(render()).toContain("Mac app");
    expect(render()).not.toContain("Choose folder");
  });
});
