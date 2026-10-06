import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudRuntimeUpgradeAvailability, CloudRuntimeUpgradeResponse } from "@zeros/protocol/cloud-runtime-lifecycle";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";

const state = vi.hoisted(() => ({ account: 1, catalog: 1, workspace: null as CloudWorkspaceDocument | null,
  read: vi.fn(), upgrade: vi.fn(), changed: null as (() => void) | null }));
vi.mock("../../platform/cloud-workspaces", () => ({ getCloudRuntimeUpgradeAvailability: state.read, upgradeCloudWorkspaceRuntime: state.upgrade }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => state.account }));
vi.mock("../cloud-workspace-catalog", () => ({ cloudCatalogGeneration: () => state.catalog, cloudWorkspaceDocument: () => state.workspace,
  subscribeCloudWorkspaces: (changed: () => void) => { state.changed = changed; return () => {}; } }));
vi.mock("../../features/team/control-plane", () => ({ ControlPlaneError: class extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
} }));
import { ControlPlaneError } from "../../features/team/control-plane";
import { cloudRuntimeUpgradeAvailability, cloudRuntimeUpgradeAvailabilityKey, loadCloudRuntimeUpgradeAvailability,
  requestCloudRuntimeUpgrade, settleCloudRuntimeUpgrade, requestCloudRuntimeUpgradeDetails, subscribeCloudRuntimeUpgradeDetails,
  cloudRuntimeUpgradeOutcome } from "../cloud-runtime-upgrade";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const availability: CloudRuntimeUpgradeAvailability = { ...target, generation: 1,
  currentRuntimeId: `r1-${"a".repeat(64)}`, latestRuntimeId: `r1-${"b".repeat(64)}`,
  updateAvailable: true, unavailableReason: null, transition: null };
const receipt = (operationId: string): CloudRuntimeUpgradeResponse => ({ operationId, sourceGeneration: 1,
  generation: 2, runtimeId: availability.latestRuntimeId!, transitionId: "33333333-3333-4333-8333-333333333333", unchanged: false });
beforeEach(() => {
  state.account++; state.catalog++; state.read.mockReset(); state.upgrade.mockReset(); cloudRuntimeUpgradeAvailability.clear();
  state.workspace = { generation: { number: 1 }, deletedAt: null, status: "ready" } as CloudWorkspaceDocument;
  state.read.mockResolvedValue(availability);
  state.upgrade.mockImplementation(async (_target, input) => receipt(input.operationId));
});
afterEach(() => cloudRuntimeUpgradeAvailability.clear());
const key = () => cloudRuntimeUpgradeAvailabilityKey(target, state.workspace!.generation.number);

describe("cloud runtime upgrade ownership and retries", () => {
  it("ends progress when another device has already completed a later qualified runtime update", () => {
    const accepted = receipt("44444444-4444-4444-8444-444444444444");
    const current = { ...availability, generation: 3, currentRuntimeId: `r1-${"c".repeat(64)}`,
      transition: { id: "55555555-5555-4555-8555-555555555555", generation: 3, runtimeId: `r1-${"c".repeat(64)}`,
        state: "succeeded" as const, error: null } };
    state.workspace!.generation.number = 3;
    expect(cloudRuntimeUpgradeOutcome(state.workspace!, current, accepted)).toBe("superseded");
    state.workspace!.status = "setting_up";
    expect(cloudRuntimeUpgradeOutcome(state.workspace!, current, accepted)).toBeNull();
  });
  it("waits for the exact ready generation and recognizes checkpoint-preserving rollback", () => {
    const accepted = receipt("44444444-4444-4444-8444-444444444444");
    const current = { ...availability, generation: 2, currentRuntimeId: accepted.runtimeId,
      transition: { id: accepted.transitionId!, generation: 2, runtimeId: accepted.runtimeId, state: "succeeded" as const, error: null } };
    expect(cloudRuntimeUpgradeOutcome(state.workspace!, current, accepted)).toBeNull();
    state.workspace!.generation.number = 2;
    expect(cloudRuntimeUpgradeOutcome(state.workspace!, current, accepted)).toBe("updated");
    expect(cloudRuntimeUpgradeOutcome(state.workspace!, { ...current, transition: { ...current.transition, state: "rolling_back" } }, accepted)).toBe("failed");
  });
  it("shares availability reads and retains the confirmed exact-key value during refresh", async () => {
    const owner = key();
    const first = cloudRuntimeUpgradeAvailability.load(owner, () => loadCloudRuntimeUpgradeAvailability(owner));
    const second = cloudRuntimeUpgradeAvailability.load(owner, () => loadCloudRuntimeUpgradeAvailability(owner));
    expect(await first).toBe(await second);
    expect(state.read).toHaveBeenCalledOnce();
    let finish!: (value: CloudRuntimeUpgradeAvailability) => void;
    state.read.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const refreshing = cloudRuntimeUpgradeAvailability.load(owner, () => loadCloudRuntimeUpgradeAvailability(owner), { force: true });
    expect(cloudRuntimeUpgradeAvailability.peekSnapshot(owner).data).toBe(availability);
    finish({ ...availability, unavailableReason: "cloud_workspace_busy" });
    await refreshing;
    state.workspace!.generation.number = 2;
    expect(cloudRuntimeUpgradeAvailability.peekSnapshot(key()).data).toBeUndefined();
  });
  it.each(["account", "catalog", "removed", "generation"])("rejects a late availability read after %s changes", async boundary => {
    let finish!: (value: CloudRuntimeUpgradeAvailability) => void;
    state.read.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const owner = key();
    const reading = cloudRuntimeUpgradeAvailability.load(owner, () => loadCloudRuntimeUpgradeAvailability(owner));
    const rejected = expect(reading).rejects.toThrow(/changed|removed/);
    if (boundary === "account") state.account++;
    if (boundary === "catalog") state.catalog++;
    if (boundary === "removed") state.workspace = null;
    if (boundary === "generation") state.workspace!.generation.number++;
    finish(availability); await rejected;
    expect(cloudRuntimeUpgradeAvailability.peekSnapshot(owner).data).toBeUndefined();
  });
  it("rejects availability for a newer generation before the matching workspace document arrives", async () => {
    state.read.mockResolvedValueOnce({ ...availability, generation: 2 });
    await expect(loadCloudRuntimeUpgradeAvailability(key())).rejects.toThrow(/generation changed/i);
  });
  it("prunes confirmed runtime details when their workspace is removed", async () => {
    const owner = key();
    await cloudRuntimeUpgradeAvailability.load(owner, () => loadCloudRuntimeUpgradeAvailability(owner));
    state.workspace = null;
    state.changed?.();
    expect(cloudRuntimeUpgradeAvailability.peekSnapshot(owner).data).toBeUndefined();
  });
  it("shares one in-flight operation across duplicate confirmations", async () => {
    let finish!: (value: CloudRuntimeUpgradeResponse) => void;
    state.upgrade.mockImplementationOnce((_target, input) => new Promise(resolve => { finish = value => resolve({ ...value, operationId: input.operationId }); }));
    const first = requestCloudRuntimeUpgrade(target, 1), second = requestCloudRuntimeUpgrade(target, 1);
    finish(receipt("44444444-4444-4444-8444-444444444444"));
    expect(await first).toEqual(await second);
    expect(state.upgrade).toHaveBeenCalledOnce();
  });
  it("replays a lost response with the original operation and generation even if the server advanced", async () => {
    state.upgrade.mockRejectedValueOnce(new Error("Connection interrupted"));
    await expect(requestCloudRuntimeUpgrade(target, 1)).rejects.toThrow("Connection interrupted");
    state.workspace!.generation.number = 2;
    await requestCloudRuntimeUpgrade(target, 2);
    expect(state.upgrade.mock.calls[1]).toEqual(state.upgrade.mock.calls[0]);
    expect(state.upgrade.mock.calls[1][1].expectedGeneration).toBe(1);
  });
  it("uses a fresh operation after a definitive rejection or a confirmed outcome", async () => {
    state.upgrade.mockRejectedValueOnce(new ControlPlaneError(409, "cloud_workspace_busy", "Stop running work"));
    await expect(requestCloudRuntimeUpgrade(target, 1)).rejects.toThrow("Stop running work");
    const accepted = await requestCloudRuntimeUpgrade(target, 1);
    expect(state.upgrade.mock.calls[1][1].operationId).not.toBe(state.upgrade.mock.calls[0][1].operationId);
    settleCloudRuntimeUpgrade(target, accepted);
    await requestCloudRuntimeUpgrade(target, 1);
    expect(state.upgrade.mock.calls[2][1].operationId).not.toBe(accepted.operationId);
  });
  it("settles a confirmed no-op even when its initiating details panel closes", async () => {
    state.upgrade.mockImplementationOnce(async (_target, input) => ({ ...receipt(input.operationId),
      generation: 1, runtimeId: availability.currentRuntimeId!, transitionId: null, unchanged: true }));
    const unchanged = await requestCloudRuntimeUpgrade(target, 1);
    await requestCloudRuntimeUpgrade(target, 1);
    expect(state.upgrade).toHaveBeenCalledTimes(2);
    expect(state.upgrade.mock.calls[1][1].operationId).not.toBe(unchanged.operationId);
  });
  it("routes an explicit composer intent to the exact workspace and account without upgrading it", () => {
    const opened = vi.fn();
    const unsubscribe = subscribeCloudRuntimeUpgradeDetails(opened);
    requestCloudRuntimeUpgradeDetails(`cloud://${target.organizationId}/${target.workspaceId}`);
    expect(opened).toHaveBeenCalledWith({ ...target, account: state.account, catalog: state.catalog });
    expect(state.upgrade).not.toHaveBeenCalled();
    requestCloudRuntimeUpgradeDetails("/local/workspace");
    expect(opened).toHaveBeenCalledOnce();
    unsubscribe();
    requestCloudRuntimeUpgradeDetails(`cloud://${target.organizationId}/${target.workspaceId}`);
    expect(opened).toHaveBeenCalledOnce();
  });
  it.each(["account", "removed"])("fences an accepted action after its %s changes", async boundary => {
    let finish!: (value: CloudRuntimeUpgradeResponse) => void;
    state.upgrade.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const updating = requestCloudRuntimeUpgrade(target, 1);
    const rejected = expect(updating).rejects.toThrow(/changed|removed/);
    if (boundary === "account") state.account++;
    else state.workspace = null;
    finish(receipt("44444444-4444-4444-8444-444444444444")); await rejected;
  });
});
