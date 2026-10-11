import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeRegistryAgent } from "../../../platform/bridge/messages";
import type { CloudWorkspaceDocument } from "../../../platform/cloud-workspaces";

const api = vi.hoisted(() => ({ request: vi.fn(), grants: vi.fn(), availability: vi.fn() }));
vi.mock("../../../platform/bridge/active-bridge", () => ({ getActiveBridge: () => ({ request: api.request }) }));
vi.mock("../../../platform/cloud-workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../platform/cloud-workspaces")>()),
  cloudAgentDelegations: api.grants,
  cloudAgentBootAvailability: api.availability,
}));
import { acceptCloudWorkspaceDocument, clearCloudWorkspaceCatalog } from "../../../state/cloud-workspace-catalog";
import { clearCloudAgentRegistry, warmCloudAgentRegistry, workspaceAgentsSnapshot } from "../workspace-agent-registry";
import { isSelectableAgent } from "../agent-runnable";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const organizationId = "11111111-1111-4111-8111-111111111111";
const workspace = `cloud://${organizationId}/${workspaceId}`;
const binding: NonNullable<CloudWorkspaceDocument["agentCredentials"]> = {
  mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", bootId: "44444444-4444-4444-8444-444444444444",
  writerEpoch: "55555555-5555-4555-8555-555555555555", fundingOwnerUserId: "66666666-6666-4666-8666-666666666666",
  fundingOwnerEpoch: 1, generation: 2, engineInstanceId: "77777777-7777-4777-8777-777777777777", status: "current",
};
const agents = ["claude", "cursor"].map(id => ({ id, name: id, version: "1", description: "Provider",
  distribution: {}, installed: true, authenticated: true })) as BridgeRegistryAgent[];
const ready = () => ({ version: 1, mode: "boot-owner-v1", status: "ready", scope: {
  generation: binding.generation, bootId: binding.bootId, writerEpoch: binding.writerEpoch,
  fundingOwnerUserId: binding.fundingOwnerUserId, fundingOwnerEpoch: binding.fundingOwnerEpoch,
}, providers: [{ provider: "cursor", status: "ready", kind: "cursor-api-key", models: ["grok-4.7"] }] });
const selectable = () => (workspaceAgentsSnapshot(workspace) ?? []).filter(isSelectableAgent).map(agent => agent.id);
function doc(version: number, credentials?: CloudWorkspaceDocument["agentCredentials"]): CloudWorkspaceDocument {
  return {
    id: workspaceId, organizationId, teamId: organizationId, name: "Cloud fixture", placement: "cloud", createdBy: organizationId,
    status: "ready", version, error: null, createdAt: "2026-09-26T00:00:00Z", updatedAt: `2026-09-26T00:00:0${version}Z`, deletedAt: null,
    capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
    repository: { forge: "github.com", owner: "example", name: "fixture", revision: "refs/heads/main" },
    generation: { number: credentials?.generation ?? 1, architecture: "x86_64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "running", lastObservedAt: null },
    ...(credentials ? { agentCredentials: credentials } : {}),
  };
}
beforeEach(() => {
  clearCloudAgentRegistry();
  clearCloudWorkspaceCatalog();
  vi.clearAllMocks();
  api.request.mockResolvedValue({ type: "AGENT_AGENTS_LIST", agents });
  api.availability.mockResolvedValue(ready());
  api.grants.mockResolvedValue([{ kind: "claude-api-key", models: ["claude-sonnet-4-6"], runtimeQualified: true }]);
});

describe("agent discovery follows actual catalog detail publication", () => {
  it("does not publish delayed personal grants after a detail read activates owner-funded mode", async () => {
    acceptCloudWorkspaceDocument(doc(1));
    let finish!: (value: unknown) => void;
    api.grants.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = warmCloudAgentRegistry(workspace);
    await vi.waitFor(() => expect(api.grants).toHaveBeenCalledOnce());
    acceptCloudWorkspaceDocument(doc(2, binding));
    finish([{ kind: "claude-api-key", models: ["claude-sonnet-4-6"], runtimeQualified: true }]);
    await pending.catch(() => {});
    expect(selectable()).not.toContain("claude");
  });

  it("does not publish an old ready response after the same binding reports an owner change", async () => {
    acceptCloudWorkspaceDocument(doc(1, binding));
    let finish!: (value: unknown) => void;
    api.availability.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = warmCloudAgentRegistry(workspace);
    await vi.waitFor(() => expect(api.availability).toHaveBeenCalledOnce());
    acceptCloudWorkspaceDocument(doc(2, { ...binding, status: "owner-changed" }));
    finish(ready());
    await pending.catch(() => {});
    expect(selectable()).toEqual([]);
  });

  it.each(["generation", "owner"] as const)("does not reuse the previous confirmed picker after a %s replacement", async change => {
    acceptCloudWorkspaceDocument(doc(1, binding));
    await warmCloudAgentRegistry(workspace);
    expect(selectable()).toEqual(["cursor"]);
    const next = change === "owner" ? { ...binding, status: "owner-changed" as const }
      : { ...binding, generation: 3, bootId: "88888888-8888-4888-8888-888888888888", writerEpoch: "99999999-9999-4999-8999-999999999999" };
    acceptCloudWorkspaceDocument(doc(2, next));
    // Same-workspace cache freshness must not carry run choices across boot authority.
    expect(selectable()).toEqual([]);
  });

  it("keeps the confirmed picker across a catalog update that leaves its authority unchanged", async () => {
    acceptCloudWorkspaceDocument(doc(1, binding));
    await warmCloudAgentRegistry(workspace);
    const confirmed = workspaceAgentsSnapshot(workspace);
    acceptCloudWorkspaceDocument({ ...doc(2, binding), name: "Renamed fixture" });
    expect(workspaceAgentsSnapshot(workspace)).toBe(confirmed);
    expect(selectable()).toEqual(["cursor"]);
    await warmCloudAgentRegistry(workspace);
    expect(api.availability).toHaveBeenCalledOnce();
  });
});
