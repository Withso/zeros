import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudRuntimeUpgradeAvailability } from "@zeros/protocol/cloud-runtime-lifecycle";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";

const state = vi.hoisted(() => ({ account: 1, catalog: 1, workspace: null as CloudWorkspaceDocument | null,
  read: vi.fn(), changed: null as (() => void) | null }));
vi.mock("../../platform/cloud-workspaces", () => ({ getCloudRuntimeUpgradeAvailability: state.read }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => state.account }));
vi.mock("../cloud-workspace-catalog", () => ({ cloudCatalogGeneration: () => state.catalog, cloudWorkspaceDocument: () => state.workspace,
  subscribeCloudWorkspaces: (changed: () => void) => { state.changed = changed; return () => {}; } }));
import { cloudRuntimeUpgradeAvailability, cloudRuntimeUpgradeAvailabilityKey, loadCloudRuntimeUpgradeAvailability,
  requestCloudRuntimeUpgradeDetails, subscribeCloudRuntimeUpgradeDetails } from "../cloud-runtime-upgrade";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const availability: CloudRuntimeUpgradeAvailability = { ...target, generation: 1,
  currentRuntimeId: `r1-${"a".repeat(64)}`, latestRuntimeId: `r1-${"b".repeat(64)}`,
  updateAvailable: true, unavailableReason: null, transition: null };
beforeEach(() => {
  state.account++; state.catalog++; state.read.mockReset(); cloudRuntimeUpgradeAvailability.clear();
  state.workspace = { generation: { number: 1 }, deletedAt: null, status: "ready" } as CloudWorkspaceDocument;
  state.read.mockResolvedValue(availability);
});
afterEach(() => cloudRuntimeUpgradeAvailability.clear());
const key = () => cloudRuntimeUpgradeAvailabilityKey(target, state.workspace!.generation.number);

describe("cloud runtime upgrade ownership and retries", () => {
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
  it("routes an explicit composer intent to the exact workspace and account without upgrading it", () => {
    const opened = vi.fn();
    const unsubscribe = subscribeCloudRuntimeUpgradeDetails(opened);
    requestCloudRuntimeUpgradeDetails(`cloud://${target.organizationId}/${target.workspaceId}`);
    expect(opened).toHaveBeenCalledWith({ ...target, account: state.account, catalog: state.catalog });
    expect(state.read).not.toHaveBeenCalled();
    requestCloudRuntimeUpgradeDetails("/local/workspace");
    expect(opened).toHaveBeenCalledOnce();
    unsubscribe();
    requestCloudRuntimeUpgradeDetails(`cloud://${target.organizationId}/${target.workspaceId}`);
    expect(opened).toHaveBeenCalledOnce();
  });
});
