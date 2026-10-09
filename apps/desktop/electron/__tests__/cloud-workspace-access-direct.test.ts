import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudActorConnectionGrant } from "@zeros/protocol/cloud-runtime-connection";
import { CloudWorkspaceAccessBroker, type CloudWorkspaceAccessBrokerApi } from "../cloud-workspace-access-broker";
import { CloudWorkspaceAccessClientError } from "../cloud-workspace-access-client";

const ids = Array.from({ length: 9 }, (_, i) => `${String(i + 1).padStart(8, "0")}-1111-4111-8111-111111111111`);
const now = 1_800_000_000_000, target = { organizationId: ids[0], workspaceId: ids[1] };
const bootScope = { ...target, generation: 2, engineInstanceId: ids[2], bootId: ids[3], writerEpoch: ids[4],
  fundingOwnerUserId: ids[5], fundingOwnerEpoch: 1 };
const firstToken = `zwa_${"a".repeat(43)}`, nextToken = `zwa_${"b".repeat(43)}`;
const bridgeUrl = "wss://api.zeros.test/v1/cloud-workspaces/bridge", directUrl = "wss://fixture-node-47891.on.boat.dev/ws";
function admission(): CloudActorConnectionGrant { return { version: 2, audience: "zeros-cloud-workspace-engine-client-admission-v2",
  ...target, generation: 2, engineInstanceId: ids[2], authorityEpoch: 3, remotePort: 47891,
  grantToken: firstToken, bridgeUrl, expiresAt: new Date(now + 120_000).toISOString(), bootScope,
  directProvider: { version: 1, provider: "boat", url: directUrl } }; }
function relay(): CloudActorConnectionGrant { const { directProvider: _direct, ...grant } = admission(); return { ...grant, grantToken: nextToken }; }
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function setup() {
  const issueEngineAdmission = vi.fn<CloudWorkspaceAccessBrokerApi["issueEngineAdmission"]>(async () => admission());
  const revokeEngineAdmission = vi.fn(async () => {}), forbidden = vi.fn(async () => { throw new Error("Unexpected SSH/legacy fallback"); });
  const api: CloudWorkspaceAccessBrokerApi = { issueEngineAdmission, revokeEngineAdmission,
    issueSsh: forbidden, issueTunnel: forbidden, activateTunnel: forbidden, issuePreview: forbidden, revoke: forbidden };
  let account = "account-A/session-A";
  const broker = new CloudWorkspaceAccessBroker({ api, now: () => now, randomId: () => ids[6],
    getAccountSessionKey: () => account, getAccessToken: async () => "synthetic-account-token" });
  cleanups.push(() => broker.dispose());
  return { broker, issueEngineAdmission, revokeEngineAdmission, forbidden, replaceAccount: () => { account = "account-B/session-B"; } };
}
describe("Electron direct provider connection ownership", () => {
  it("opts into the verified direct endpoint and publishes only its exact boot-bound target", async () => {
    const f = setup(), connection = await f.broker.openRuntime(target);
    expect(f.issueEngineAdmission).toHaveBeenCalledExactlyOnceWith("synthetic-account-token", { ...target, directProviderVersion: 1 });
    expect(connection).toEqual({ kind: "cloud", channel: "direct-provider-websocket", runtimeId: ids[6], ...target,
      generation: 2, engineInstanceId: ids[2], authorityEpoch: 3, connectionSequence: 1, url: directUrl,
      cloudToken: firstToken, expiresAt: now + 120_000, bootScope, remotePort: 47891 });
    expect(f.forbidden).not.toHaveBeenCalled();
  });
  it("retains immutable boot identity inside the published native handle", async () => {
    const f = setup(), connection = await f.broker.openRuntime(target);
    if (connection.channel === "electron-ssh-tunnel") throw new Error("Expected boot-bound actor transport");
    expect(Object.isFrozen(connection)).toBe(true); expect(Object.isFrozen(connection.bootScope)).toBe(true);
  });
  it("mints a fresh same-boot CP fallback without reusing the one-use grant or an inline URL", async () => {
    const f = setup(), first = await f.broker.openRuntime(target); f.issueEngineAdmission.mockResolvedValueOnce(relay());
    const next = await f.broker.refreshRuntime(first);
    expect(f.issueEngineAdmission).toHaveBeenLastCalledWith("synthetic-account-token", { ...target,
      directProviderVersion: 1, connectionChannel: "control-plane-websocket" });
    expect(next).toMatchObject({ channel: "control-plane-websocket", runtimeId: first.runtimeId, connectionSequence: 2,
      url: bridgeUrl, cloudToken: nextToken, bootScope });
    expect(next.cloudToken).not.toBe(first.cloudToken); expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.revokeEngineAdmission).toHaveBeenCalledExactlyOnceWith("synthetic-account-token", { ...target, grantToken: firstToken });
  });
  it("reconciles a lost fallback IPC response and joins concurrent requests without reminting", async () => {
    const f = setup(), first = await f.broker.openRuntime(target); f.issueEngineAdmission.mockResolvedValueOnce(relay());
    const [a, b] = await Promise.all([f.broker.refreshRuntime(first), f.broker.refreshRuntime(first)]);
    expect(a).toEqual(b); expect(await f.broker.refreshRuntime(first)).toEqual(a);
    expect(f.issueEngineAdmission).toHaveBeenCalledTimes(2); expect(f.revokeEngineAdmission).toHaveBeenCalledOnce();
  });
  it.each(["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch"] as const)(
    "refuses a fallback for a different %s and revokes the unpublished grant", async field => {
      const f = setup(), first = await f.broker.openRuntime(target), fresh = relay();
      const scope = { ...fresh.bootScope!, [field]: field === "generation" || field === "fundingOwnerEpoch" ? 4 : ids[8] };
      f.issueEngineAdmission.mockResolvedValueOnce({ ...fresh, bootScope: scope });
      await expect(f.broker.refreshRuntime(first)).rejects.toBeInstanceOf(CloudWorkspaceAccessClientError);
      expect(f.revokeEngineAdmission).toHaveBeenCalledWith("synthetic-account-token", { ...target, grantToken: nextToken });
      expect(f.forbidden).not.toHaveBeenCalled();
    });
  it("does not silently drop a negotiated boot binding on fallback", async () => {
    const f = setup(), first = await f.broker.openRuntime(target), { bootScope: _boot, ...fresh } = relay();
    f.issueEngineAdmission.mockResolvedValueOnce(fresh);
    await expect(f.broker.refreshRuntime(first)).rejects.toMatchObject({ code: "cloud_workspace_access_superseded" });
    expect(f.revokeEngineAdmission).toHaveBeenCalledWith("synthetic-account-token", { ...target, grantToken: nextToken });
    expect(f.forbidden).not.toHaveBeenCalled();
  });
  it("refuses invalid direct endpoints instead of selecting the old relay implicitly", async () => {
    const f = setup(); f.issueEngineAdmission.mockResolvedValueOnce({ ...admission(), directProvider: {
      version: 1, provider: "boat", url: "wss://unverified.example/ws" } });
    await expect(f.broker.openRuntime(target)).rejects.toMatchObject({ code: "bad_response" });
    expect(f.issueEngineAdmission).toHaveBeenCalledOnce(); expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.revokeEngineAdmission).toHaveBeenCalledWith("synthetic-account-token", { ...target, grantToken: firstToken });
  });
  it("refuses expired grants before publishing a direct descriptor", async () => {
    const f = setup(); f.issueEngineAdmission.mockResolvedValueOnce({ ...admission(), expiresAt: new Date(now + 4000).toISOString() });
    await expect(f.broker.openRuntime(target)).rejects.toMatchObject({ code: "bad_response" });
    expect(f.revokeEngineAdmission).toHaveBeenCalledWith("synthetic-account-token", { ...target, grantToken: firstToken });
  });
  it("keeps authority denial terminal with no SSH or grant fallback", async () => {
    const f = setup(), first = await f.broker.openRuntime(target);
    f.issueEngineAdmission.mockRejectedValueOnce(new CloudWorkspaceAccessClientError(403, "cloud_actor_authority_rejected", "Synthetic closed authority"));
    await expect(f.broker.refreshRuntime(first)).rejects.toMatchObject({ code: "cloud_actor_authority_rejected" });
    expect(f.issueEngineAdmission).toHaveBeenCalledTimes(2); expect(f.forbidden).not.toHaveBeenCalled();
  });
  it("retires an unpublished fallback returned after close and keeps the old runtime closed", async () => {
    const f = setup(), first = await f.broker.openRuntime(target); let deliver!: (value: CloudActorConnectionGrant) => void;
    f.issueEngineAdmission.mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }));
    const pending = f.broker.refreshRuntime(first), refused = expect(pending).rejects.toMatchObject({ code: "cloud_workspace_access_superseded" });
    await vi.waitFor(() => expect(deliver).toBeTypeOf("function")); await f.broker.closeRuntime(first.runtimeId);
    deliver(relay()); await refused;
    expect(f.revokeEngineAdmission).toHaveBeenCalledWith("synthetic-account-token", { ...target, grantToken: nextToken });
  });
  it("keeps a retired account handle inert before issuing another provider grant", async () => {
    const f = setup(), first = await f.broker.openRuntime(target); f.replaceAccount();
    await expect(f.broker.refreshRuntime(first)).rejects.toMatchObject({ code: "cloud_workspace_access_superseded" });
    expect(f.issueEngineAdmission).toHaveBeenCalledOnce(); expect(f.forbidden).not.toHaveBeenCalled();
  });
  it("preserves the legacy actor relay when direct metadata is absent", async () => {
    const f = setup(), { bootScope: _boot, directProvider: _direct, ...legacy } = admission(); f.issueEngineAdmission.mockResolvedValueOnce(legacy);
    await expect(f.broker.openRuntime(target)).resolves.toMatchObject({ channel: "control-plane-websocket", url: bridgeUrl, cloudToken: firstToken });
    expect(f.forbidden).not.toHaveBeenCalled();
  });
});
