import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import type { CloudReplicaSnapshot } from "../../state/cloud-replica-cache";

const state = vi.hoisted(() => ({ internal: true, native: true, identityError: null as Error | null,
  snapshot: { replica: null, divergences: [] } as CloudReplicaSnapshot, reads: vi.fn(), gate: vi.fn(),
  identities: {}, replicas: {}, epoch: 0 }));
vi.mock("../../features/settings/internal-features", () => ({ useInternalFeatureActive: (key: string) => { state.gate(key); return state.internal; } }));
vi.mock("../../features/team/team-store", () => ({ useTeams: () => ({ me: { user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } } }),
  getOrganizationStoreGeneration: () => state.epoch }));
vi.mock("../../platform/runtime", () => ({ useNativeRuntime: () => ({ ready: state.native }) }));
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

const workspace = { id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111",
  status: "ready", capabilities: { canEdit: true }, deletedAt: null } as CloudWorkspaceDocument;
const replica = { accountUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  workspaceId: workspace.id, organizationId: workspace.organizationId, replicaId: "33333333-3333-4333-8333-333333333333",
  rootPath: "/Users/test/copy", observedState: "in_sync", desiredState: "active", ignorePolicy: { version: 1, excludePrefixes: [] }, lastErrorCode: null } as const;
function render(overrides: Partial<CloudWorkspaceDocument> = {}, active = true) {
  return renderToStaticMarkup(createElement(CloudWorkspaceSyncControls, { workspace: { ...workspace, ...overrides }, active }));
}
beforeEach(() => { state.internal = true; state.native = true; state.identityError = null; state.snapshot = { replica: null, divergences: [] }; vi.clearAllMocks(); });

describe("receive-only Mac sync controls", () => {
  it("uses the single Cloud v2 internal gate and stays absent for ordinary accounts", () => {
    state.internal = false;
    expect(render()).toBe(""); expect(state.gate).toHaveBeenCalledWith("cloudComputerV2");
    expect(state.reads.mock.calls.every(([key]) => key === null)).toBe(true);
  });
  it.each([undefined, false])("fails closed when canEdit is %s, including read-only warming", canEdit => {
    const html = render({ capabilities: { ...workspace.capabilities, canEdit } });
    expect(html).toContain("edit access"); expect(html).not.toContain("Choose folder");
    expect(state.reads.mock.calls.every(([key]) => key === null)).toBe(true);
  });
  it("explains the primary, receive-only copy and exclusions before folder selection", () => {
    const html = render();
    expect(html).toContain("Local edits stay on this Mac"); expect(html).toContain("primary");
    expect(html).toContain(".git"); expect(html).toContain("node_modules"); expect(html).toContain(".env");
    expect(html).toContain("Choose folder");
  });
  it("shows folder/status and independent pause/remove actions without recreating the replica", () => {
    state.snapshot.replica = replica as never;
    const html = render();
    expect(html).toContain("In sync"); expect(html).toContain(replica.rootPath);
    expect(html).toContain("Pause"); expect(html).toContain("Remove"); expect(html).not.toContain("Choose folder");
    state.snapshot.replica = { ...replica, desiredState: "paused", observedState: "paused" } as never;
    expect(render()).toContain("Resume");
  });
  it("shows local divergence paths and offers an explicit cloud replacement", () => {
    state.snapshot = { replica: { ...replica, observedState: "diverged" } as never,
      divergences: [{ path: "src/local.ts", detectedAt: 1 }] };
    const html = render();
    expect(html).toContain("src/local.ts"); expect(html).toContain("Use cloud version"); expect(html).toContain("never uploaded");
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
