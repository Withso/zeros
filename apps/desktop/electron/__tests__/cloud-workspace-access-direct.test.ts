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
  const revokeEngineAdmission = vi.fn<CloudWorkspaceAccessBrokerApi["revokeEngineAdmission"]>(async () => {}), forbidden = vi.fn(async () => { throw new Error("Unexpected SSH/legacy fallback"); });
  const api: CloudWorkspaceAccessBrokerApi = { issueEngineAdmission, revokeEngineAdmission,
    issueSsh: forbidden, issueTunnel: forbidden, activateTunnel: forbidden, issuePreview: forbidden, revoke: forbidden };
  let account = "account-A/session-A";
  let clock = now, handle = 6;
  const broker = new CloudWorkspaceAccessBroker({ api, now: () => clock, randomId: () => ids[handle++ % ids.length]!,
    getAccountSessionKey: () => account, getAccessToken: async () => "synthetic-account-token" });
  cleanups.push(() => broker.dispose());
  return { broker, issueEngineAdmission, revokeEngineAdmission, forbidden,
    advance: (ms: number) => { clock += ms; }, replaceAccount: () => { account = "account-B/session-B"; } };
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
  it("retires an acknowledged old admission before returning the break-first refresh", async () => {
    const f = setup(), first = await f.broker.openRuntime(target);
    await f.broker.publishRuntimeConnection({ ...first, connected: true });
    f.issueEngineAdmission.mockResolvedValueOnce(relay());
    const next = await f.broker.refreshRuntime(first);
    expect(f.revokeEngineAdmission).toHaveBeenCalledExactlyOnceWith("synthetic-account-token", { ...target, grantToken: firstToken });
    expect(() => f.broker.assertRuntime(first)).toThrow();
    expect(() => f.broker.assertRuntime(next)).not.toThrow();
    await f.broker.publishRuntimeConnection({ ...next, connected: true });
    expect(f.revokeEngineAdmission).toHaveBeenCalledOnce();
  });
  it.each(["runtimeId", "organizationId", "workspaceId", "generation", "authorityEpoch", "engineInstanceId", "connectionSequence"] as const)(
    "ignores a foreign %s route-health publication without caching or retiring an admission", async field => {
      const f = setup(), first = await f.broker.openRuntime(target);
      f.issueEngineAdmission.mockResolvedValueOnce(relay());
      const fallback = await f.broker.refreshRuntime(first);
      const foreign = { ...fallback, [field]: typeof fallback[field] === "number" ? Number(fallback[field]) + 1 : ids[8], connected: true };
      await expect(f.broker.publishRuntimeConnection(foreign)).resolves.toBeUndefined();
      expect(() => f.broker.assertRuntime(fallback)).not.toThrow();
      expect(f.revokeEngineAdmission).toHaveBeenCalledOnce();
      await f.broker.closeRuntime(first.runtimeId);
      f.issueEngineAdmission.mockResolvedValueOnce({ ...admission(), grantToken: `zwa_${"c".repeat(43)}` });
      expect((await f.broker.openRuntime(target)).channel).toBe("direct-provider-websocket");
    });
  it("keeps disconnected route publication observational and does not remember an unproved relay", async () => {
    const f = setup(), first = await f.broker.openRuntime(target);
    f.issueEngineAdmission.mockResolvedValueOnce(relay());
    const fallback = await f.broker.refreshRuntime(first);
    await f.broker.publishRuntimeConnection({ ...fallback, connected: false });
    expect(() => f.broker.assertRuntime(fallback)).not.toThrow();
    expect(f.revokeEngineAdmission).toHaveBeenCalledOnce();
    await f.broker.closeRuntime(first.runtimeId);
    f.issueEngineAdmission.mockResolvedValueOnce({ ...admission(), grantToken: `zwa_${"c".repeat(43)}` });
    expect((await f.broker.openRuntime(target)).channel).toBe("direct-provider-websocket");
  });
  it("ignores a late connected publication after its handle closed", async () => {
    const f = setup(), first = await f.broker.openRuntime(target);
    f.issueEngineAdmission.mockResolvedValueOnce(relay());
    const fallback = await f.broker.refreshRuntime(first);
    await f.broker.closeRuntime(first.runtimeId);
    await expect(f.broker.publishRuntimeConnection({ ...fallback, connected: true })).resolves.toBeUndefined();
    f.issueEngineAdmission.mockResolvedValueOnce({ ...admission(), grantToken: `zwa_${"c".repeat(43)}` });
    expect((await f.broker.openRuntime(target)).channel).toBe("direct-provider-websocket");
  });
  it("ignores route-health publication from a retired account without weakening runtime authority", async () => {
    const f = setup(), first = await f.broker.openRuntime(target);
    f.issueEngineAdmission.mockResolvedValueOnce(relay());
    const fallback = await f.broker.refreshRuntime(first); f.replaceAccount();
    await expect(f.broker.publishRuntimeConnection({ ...fallback, connected: true })).resolves.toBeUndefined();
    expect(() => f.broker.assertRuntime(fallback)).toThrow();
    await vi.waitFor(() => expect(f.revokeEngineAdmission).toHaveBeenCalledTimes(2));
    expect(f.revokeEngineAdmission.mock.calls.map(call => call[1].grantToken)).toEqual([firstToken, nextToken]);
    const current = setup();
    expect((await current.broker.openRuntime(target)).channel).toBe("direct-provider-websocket");
  });
  it("uses a fresh CP grant on a new handle after the same exact boot fell back", async () => {
    const f = setup(), first = await f.broker.openRuntime(target);
    f.issueEngineAdmission.mockResolvedValueOnce(relay());
    const fallback = await f.broker.refreshRuntime(first);
    await f.broker.publishRuntimeConnection({ ...fallback, connected: true });
    await f.broker.closeRuntime(first.runtimeId);
    const freshToken = `zwa_${"c".repeat(43)}`;
    f.issueEngineAdmission.mockResolvedValueOnce({ ...admission(), grantToken: freshToken });
    const reopened = await f.broker.openRuntime(target);
    expect(reopened).toMatchObject({ channel: "control-plane-websocket", connectionSequence: 1, cloudToken: freshToken });
    expect(reopened.runtimeId).not.toBe(first.runtimeId);
    expect(f.issueEngineAdmission).toHaveBeenCalledTimes(3);
    expect(f.forbidden).not.toHaveBeenCalled();
  });
  it.each(["bootId", "writerEpoch", "engineInstanceId", "fundingOwnerUserId", "fundingOwnerEpoch", "authorityEpoch"] as const)(
    "does not carry CP preference to a different %s", async field => {
      const f = setup(), first = await f.broker.openRuntime(target);
      f.issueEngineAdmission.mockResolvedValueOnce(relay());
      const fallback = await f.broker.refreshRuntime(first);
      await f.broker.publishRuntimeConnection({ ...fallback, connected: true });
      await f.broker.closeRuntime(first.runtimeId);
      const fresh = admission();
      const changed = field === "authorityEpoch" ? { ...fresh, authorityEpoch: 4 } : {
        ...fresh, ...(field === "engineInstanceId" ? { engineInstanceId: ids[8] } : {}),
        bootScope: { ...bootScope, [field]: field === "fundingOwnerEpoch" ? 2 : ids[8] },
      };
      f.issueEngineAdmission.mockResolvedValueOnce(changed);
      expect((await f.broker.openRuntime(target)).channel).toBe("direct-provider-websocket");
    });
  it("expires the CP route preference while still minting a fresh admission", async () => {
    const f = setup(), first = await f.broker.openRuntime(target);
    f.issueEngineAdmission.mockResolvedValueOnce(relay());
    const fallback = await f.broker.refreshRuntime(first);
    await f.broker.publishRuntimeConnection({ ...fallback, connected: true });
    await f.broker.closeRuntime(first.runtimeId); f.advance(5 * 60_000 + 1);
    f.issueEngineAdmission.mockResolvedValueOnce({ ...admission(), expiresAt: new Date(now + 6 * 60_000).toISOString() });
    expect((await f.broker.openRuntime(target)).channel).toBe("direct-provider-websocket");
  });
  it("bounds remembered route health independently of one-use admissions", async () => {
    const f = setup();
    for (let index = 0; index < 65; index++) {
      const grant = { ...admission(), authorityEpoch: index + 10 };
      f.issueEngineAdmission.mockResolvedValueOnce(grant);
      const first = await f.broker.openRuntime(target);
      f.issueEngineAdmission.mockResolvedValueOnce({ ...relay(), authorityEpoch: grant.authorityEpoch });
      const fallback = await f.broker.refreshRuntime(first);
      await f.broker.publishRuntimeConnection({ ...fallback, connected: true });
      await f.broker.closeRuntime(first.runtimeId);
    }
    f.issueEngineAdmission.mockResolvedValueOnce({ ...admission(), authorityEpoch: 10 });
    expect((await f.broker.openRuntime(target)).channel).toBe("direct-provider-websocket");
    f.issueEngineAdmission.mockResolvedValueOnce({ ...admission(), authorityEpoch: 74 });
    expect((await f.broker.openRuntime(target)).channel).toBe("control-plane-websocket");
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
