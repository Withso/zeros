import { describe, expect, it, vi } from "vitest";

import {
  CloudWorkspaceAccessBroker,
  type CloudWorkspaceAccessBrokerApi,
  type CloudWorkspaceTunnelHandle,
} from "../cloud-workspace-access-broker";
import type { CloudRuntimeServiceAccess } from "../cloud-runtime-service-client";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const GRANT_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_GRANT_ID = "44444444-4444-4444-8444-444444444444";
const NOW = 1_800_000_000_000;
const EXPIRES_AT = new Date(NOW + 30 * 60_000).toISOString();
const SSH_CREDENTIAL = `ssh_${"a".repeat(40)}`;
const PREVIEW_CAPABILITY = `zwp_${"b".repeat(43)}`;
const ENGINE_INSTANCE_ID = "66666666-6666-4666-8666-666666666666";
const DEVICE_ID = "77777777-7777-4777-8777-777777777777";
const TUNNEL_SESSION_ID = "88888888-8888-4888-8888-888888888888";
const ENGINE_GRANT = `zws_${"c".repeat(43)}`;

function api(): CloudWorkspaceAccessBrokerApi {
  return {
    revokeEngineAdmission: vi.fn(async()=>undefined),
    issueEngineAdmission: vi.fn(async () => ({
      version: 1 as const,
      audience: "zeros-cloud-workspace-engine-client-admission-v1" as const,
      workspaceId: WORKSPACE_ID,
      organizationId: ORGANIZATION_ID,
      generation: 7,
      authorityEpoch: 9,
      engineInstanceId: ENGINE_INSTANCE_ID,
      remotePort: 47891,
      grantToken: ENGINE_GRANT,
      expiresAt: new Date(NOW + 120_000).toISOString(),
    })),
    issuePreview: vi.fn(async () => ({
      grant: {
        id: GRANT_ID,
        kind: "preview" as const,
        workspaceId: WORKSPACE_ID,
        generation: 7,
        remotePort: 4173,
        expiresAt: EXPIRES_AT,
      },
      preview: {
        logicalUrl: "http://localhost:4173/",
        origin: "https://0123456789abcdef0123456789abcdef.preview.zeros.test",
        capability: PREVIEW_CAPABILITY,
        headerName: "x-zeros-preview-capability" as const,
      },
    })),
    issueSsh: vi.fn(async () => ({
      grant: {
        id: GRANT_ID,
        kind: "ssh" as const,
        workspaceId: WORKSPACE_ID,
        generation: 7,
        remotePort: null,
        expiresAt: EXPIRES_AT,
      },
      ssh: {
        username: SSH_CREDENTIAL,
        host: "ssh.fixture.test",
        command: `ssh ${SSH_CREDENTIAL}@ssh.fixture.test`,
      },
    })),
    issueTunnel: vi.fn(async (_accessToken, input) => ({
      grant: {
        id: GRANT_ID,
        kind: "tunnel" as const,
        workspaceId: WORKSPACE_ID,
        generation: 7,
        remotePort: input.remotePort,
        expiresAt: EXPIRES_AT,
      },
      tunnel: {
        sshUsername: SSH_CREDENTIAL,
        sshHost: "ssh.fixture.test",
        remoteHost: "127.0.0.1" as const,
        remotePort: input.remotePort,
        session: {
          id: TUNNEL_SESSION_ID,
          deviceId: input.deviceId,
          state: "starting" as const,
        },
      },
    })),
    activateTunnel: vi.fn(async (_accessToken, input) => ({
      id: input.sessionId,
      deviceId: input.deviceId,
      state: "active" as const,
      bindAddress: "127.0.0.1" as const,
      observedLocalPort: input.observedLocalPort,
    })),
    revoke: vi.fn(async () => undefined),
  };
}

function broker(
  accessApi: CloudWorkspaceAccessBrokerApi,
  overrides: Partial<
    ConstructorParameters<typeof CloudWorkspaceAccessBroker>[0]
  > = {},
) {
  return new CloudWorkspaceAccessBroker({
    api: accessApi,
    getAccountSessionKey: () => "account-a/session-a",
    getAccessToken: vi.fn(async () => "account-access-token"),
    getDeviceId: vi.fn(async () => DEVICE_ID),
    randomId: () => "55555555-5555-4555-8555-555555555555",
    now: () => NOW,
    ...overrides,
  });
}

function nativeFixture() {
  let account = "account-a/session-a";
  let device = { deviceId: DEVICE_ID, keyVersion: 1 };
  let sequence = 0;
  const handles: Array<{ stop: ReturnType<typeof vi.fn>; close: () => void; closed: Promise<void>; command: string; configPath: string; launchTerminal: ReturnType<typeof vi.fn>; localPort: number }> = [];
  const makeHandle = async () => {
    let close!: () => void;
    const closed = new Promise<void>(resolve => { close = resolve; });
    const handle = { closed, close, stop: vi.fn(async () => close()), command: "ssh -F /private/native/config zeros-cloud",
      configPath: "/private/native/config", launchTerminal: vi.fn(async () => undefined), localPort: 5173 };
    handles.push(handle); return handle;
  };
  const nativeServices = {
    api: {
      issue: vi.fn(async (_token: string, input: { kind: "ssh" | "tunnel"; remotePort?: number }): Promise<CloudRuntimeServiceAccess> => ({
        grant: { id: sequence++ ? SECOND_GRANT_ID : GRANT_ID, workspaceId: WORKSPACE_ID, generation: 7, kind: input.kind,
          remotePort: input.remotePort ?? null, deviceId: device.deviceId, expiresAt: EXPIRES_AT }, deviceKeyVersion: device.keyVersion,
        transport: { version: 1, url: "wss://api.zeros.test/service", capability: `zsh_${"a".repeat(43)}`,
          headerName: "x-zeros-runtime-service", protocol: "zeros.service.v1" },
        ...(input.kind === "ssh" ? { ssh: { username: "zeros", hostKey: "stream-introduction" } } : {}),
      })),
      revoke: vi.fn(async () => undefined),
    },
    readDeviceIdentity: () => device,
    prepareSsh: vi.fn(makeHandle), startTunnel: vi.fn(makeHandle),
  };
  const legacy = api(), clipboard = vi.fn(async (_text: string) => undefined);
  const getAccessToken = vi.fn(async () => "account-access-token");
  const access = broker(legacy, { ...{ nativeServices }, writeClipboard: clipboard, getAccessToken, getAccountSessionKey: () => account });
  return { access, nativeServices, legacy, clipboard, handles, getAccessToken, changeAccount: () => { account = "account-b/session-b"; },
    rotateDevice: () => { device = { ...device, keyVersion: 2 }; } };
}

describe("native service broker", () => {
  const target = { organizationId: ORGANIZATION_ID, workspaceId: WORKSPACE_ID };
  it("uses native SSH for copy/Terminal without exposing or calling provider authority", async () => {
    const f = nativeFixture();
    const result = await f.access.copySshCommand(target);
    expect(f.nativeServices.api.issue).toHaveBeenCalledWith("account-access-token", expect.objectContaining({ ...target, kind: "ssh" }));
    expect(f.legacy.issueSsh).not.toHaveBeenCalled();
    expect(f.clipboard).toHaveBeenCalledWith("ssh -F /private/native/config zeros-cloud");
    expect(result).toEqual({ accessId: GRANT_ID, expiresAt: EXPIRES_AT });
    await f.access.openSshTerminal(target);
    expect(f.handles[1]!.launchTerminal).toHaveBeenCalledOnce();
    await f.access.dispose();
  });
  it("closes one native grant without retiring a sibling, and retires an SSH window on EOF", async () => {
    const f = nativeFixture();
    const first = await f.access.copySshCommand(target);
    await f.access.startTunnel({ ...target, remotePort: 4173, localPort: 5173 });
    await f.access.revoke(first.accessId);
    expect(f.handles[0]!.stop).toHaveBeenCalledOnce();
    expect(f.handles[1]!.stop).not.toHaveBeenCalled();
    expect(f.nativeServices.api.revoke).toHaveBeenCalledWith("account-access-token", { ...target, grantId: GRANT_ID });
    expect(f.legacy.revoke).not.toHaveBeenCalled();
    f.handles[1]!.close();
    await vi.waitFor(() => expect(f.nativeServices.api.revoke).toHaveBeenCalledWith("account-access-token", { ...target, grantId: SECOND_GRANT_ID }));
    await f.access.dispose();
  });
  it("retires a late native admission using the issuing account and never publishes it", async () => {
    const f = nativeFixture();
    const issue = f.nativeServices.api.issue.getMockImplementation()!;
    let release!: (value: CloudRuntimeServiceAccess) => void;
    f.nativeServices.api.issue.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.access.copySshCommand(target);
    const rejected = expect(pending).rejects.toMatchObject({ code: "signed_out" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.changeAccount(); release(await issue("account-access-token", { kind: "ssh" })); await rejected;
    expect(f.clipboard).not.toHaveBeenCalled();
    expect(f.nativeServices.prepareSsh).not.toHaveBeenCalled();
    expect(f.nativeServices.api.revoke).toHaveBeenCalledWith("account-access-token", { ...target, grantId: GRANT_ID });
  });
  it("rejects a device key rotation during preparation and closes that local adapter", async () => {
    const f = nativeFixture();
    const prepare = f.nativeServices.prepareSsh.getMockImplementation()!;
    f.nativeServices.prepareSsh.mockImplementationOnce(async () => { const handle = await prepare(); f.rotateDevice(); return handle; });
    await expect(f.access.copySshCommand(target)).rejects.toThrow(/authority|device/i);
    expect(f.clipboard).not.toHaveBeenCalled();
    expect(f.handles[0]!.stop).toHaveBeenCalled();
    expect(f.nativeServices.api.revoke).toHaveBeenCalledOnce();
  });
  it("cleans up a port collision or failed clipboard write and never falls back", async () => {
    const f = nativeFixture();
    f.nativeServices.startTunnel.mockRejectedValueOnce(new Error("Local port already in use"));
    await expect(f.access.startTunnel({ ...target, remotePort: 4173, localPort: 5173 })).rejects.toThrow(/port/);
    expect(f.nativeServices.api.revoke).toHaveBeenCalledOnce();
    expect(f.legacy.issueTunnel).not.toHaveBeenCalled();
    f.clipboard.mockRejectedValueOnce(new Error("Clipboard unavailable"));
    await expect(f.access.copySshCommand(target)).rejects.toThrow(/Clipboard/);
    expect(f.handles[0]!.stop).toHaveBeenCalled();
    expect(f.nativeServices.api.revoke).toHaveBeenCalledTimes(2);
  });
  it("refuses unqualified native IDE launch before issuing authority", async () => {
    const f = nativeFixture();
    await expect(f.access.openSshIde({ ...target, appId: "cursor" })).rejects.toThrow(/IDE.*qualified/i);
    expect(f.nativeServices.api.issue).not.toHaveBeenCalled();
    expect(f.legacy.issueSsh).not.toHaveBeenCalled();
  });
  it("reads metadata only for the exact account/device/workspace without issuing access", async () => {
    const f = nativeFixture(), context = f.access.serviceContext();
    expect(f.access.listServices({ ...target, ...context })).toEqual([]);
    expect(f.nativeServices.api.issue).not.toHaveBeenCalled();
    await f.access.copySshCommand(target);
    const rows = f.access.listServices({ ...target, ...context });
    expect(rows).toEqual([{ accessId: GRANT_ID, kind: "ssh", generation: 7, expiresAt: EXPIRES_AT,
      localPort: null, remotePort: null, closing: false }]);
    expect(f.access.listServices({ ...target, ...context, workspaceId: SECOND_GRANT_ID })).toEqual([]);
    expect(() => f.access.listServices({ ...target, ...context, authorityId: "old-session" })).toThrow(/authority/);
    f.rotateDevice();
    expect(() => f.access.listServices({ ...target, ...context })).toThrow(/authority/);
    expect(f.access.listServices({ ...target, ...f.access.serviceContext() })).toEqual([]);
    await f.access.dispose();
  });
  it("retries remote retirement after stopping locally without losing a sibling", async () => {
    const f = nativeFixture();
    await f.access.copySshCommand(target);
    await f.access.startTunnel({ ...target, remotePort: 4173, localPort: 5173 });
    f.nativeServices.api.revoke.mockRejectedValueOnce(new Error("offline"));
    await expect(f.access.revoke(GRANT_ID)).rejects.toThrow(/offline/);
    const rows = f.access.listServices({ ...target, ...f.access.serviceContext() });
    expect(rows.find(row => row.accessId === GRANT_ID)?.closing).toBe(true);
    expect(f.handles[1]!.stop).not.toHaveBeenCalled();
    await f.access.revoke(GRANT_ID);
    expect(f.access.listServices({ ...target, ...f.access.serviceContext() }).map(row => row.accessId)).toEqual([SECOND_GRANT_ID]);
    await f.access.dispose();
    expect(f.nativeServices.api.revoke).toHaveBeenCalledWith("account-access-token", { ...target, grantId: SECOND_GRANT_ID });
  });
  it("retains failed admission cleanup so a port collision cannot orphan an idle-blocking grant", async () => {
    const f = nativeFixture();
    f.nativeServices.startTunnel.mockRejectedValueOnce(new Error("Local port already in use"));
    f.nativeServices.api.revoke.mockRejectedValueOnce(new Error("offline"));
    await expect(f.access.startTunnel({ ...target, remotePort: 4173, localPort: 5173 })).rejects.toThrow(/port/);
    expect(f.access.listServices({ ...target, ...f.access.serviceContext() })).toEqual([
      { accessId: GRANT_ID, kind: "tunnel", generation: 7, expiresAt: EXPIRES_AT,
        localPort: 5173, remotePort: 4173, closing: true },
    ]);
    await f.access.revoke(GRANT_ID);
    expect(f.access.listServices({ ...target, ...f.access.serviceContext() })).toEqual([]);
    await f.access.dispose();
  });
  it("refreshes the issuing account token for cleanup without adopting a replacement account", async () => {
    const f = nativeFixture();
    await f.access.copySshCommand(target);
    f.getAccessToken.mockResolvedValueOnce("refreshed-account-token");
    await f.access.revoke(GRANT_ID);
    expect(f.nativeServices.api.revoke).toHaveBeenLastCalledWith("refreshed-account-token", { ...target, grantId: GRANT_ID });

    await f.access.copySshCommand(target);
    f.getAccessToken.mockImplementationOnce(async () => {
      f.changeAccount();
      return "replacement-account-token";
    });
    await f.access.revoke(SECOND_GRANT_ID);
    expect(f.nativeServices.api.revoke).toHaveBeenLastCalledWith("account-access-token", { ...target, grantId: SECOND_GRANT_ID });
    expect(f.handles[1]!.stop).toHaveBeenCalled();
    await f.access.dispose();
  });
  it("rejects a device rotation while the grant is being issued", async () => {
    const f = nativeFixture();
    const issue = f.nativeServices.api.issue.getMockImplementation()!;
    f.nativeServices.api.issue.mockImplementationOnce(async (...args) => {
      f.rotateDevice();
      return issue(...args);
    });
    await expect(f.access.copySshCommand(target)).rejects.toThrow(/device authority changed/i);
    expect(f.nativeServices.prepareSsh).not.toHaveBeenCalled();
    expect(f.clipboard).not.toHaveBeenCalled();
    expect(f.nativeServices.api.revoke).toHaveBeenCalledOnce();
    await f.access.dispose();
  });

  async function automaticFixture() {
    const f = nativeFixture();
    vi.mocked(f.legacy.issueEngineAdmission).mockResolvedValue({ version: 2, audience: "zeros-cloud-workspace-engine-client-admission-v2",
      ...target, generation: 7, authorityEpoch: 9, engineInstanceId: ENGINE_INSTANCE_ID, remotePort: 47891,
      grantToken: `zwa_${"d".repeat(43)}`, expiresAt: new Date(NOW + 120000).toISOString(), bridgeUrl: "wss://api.zeros.test/v1/cloud-workspaces/bridge" });
    const runtime = await f.access.openRuntime(target);
    return { ...f, runtime, context: f.access.serviceContext() };
  }
  it("issues automatic tunnels only for the exact admitted runtime and records safe ownership", async () => {
    const f = await automaticFixture();
    const receipt = await f.access.startAutomaticTunnel({ ...f.runtime, ...f.context, localPort: 5173, remotePort: 4173 });
    expect(f.nativeServices.api.issue).toHaveBeenCalledWith("account-access-token", expect.objectContaining({
      ...target, kind: "tunnel", remotePort: 4173, idempotencyKey: "desktop:auto-tunnel:55555555-5555-4555-8555-555555555555",
    }));
    expect(f.access.listServices({ ...target, ...f.context })).toEqual([expect.objectContaining({ accessId: receipt.accessId, ownership: "auto" })]);
    await f.access.dispose();
  });
  it.each(["generation", "authorityEpoch", "connectionSequence"] as const)("rejects an automatic tunnel under stale %s before admission", async field => {
    const f = await automaticFixture();
    await expect(f.access.startAutomaticTunnel({ ...f.runtime, ...f.context, [field]: f.runtime[field] + 1, localPort: 5173, remotePort: 4173 })).rejects.toThrow(/superseded/i);
    expect(f.nativeServices.api.issue).not.toHaveBeenCalled();
    await f.access.dispose();
  });
  it("retires a late automatic grant when its runtime closes during admission", async () => {
    const f = await automaticFixture(), issue = f.nativeServices.api.issue.getMockImplementation()!;
    f.nativeServices.api.issue.mockImplementationOnce(async (...args) => { await f.access.closeRuntime(f.runtime.runtimeId); return issue(...args); });
    await expect(f.access.startAutomaticTunnel({ ...f.runtime, ...f.context, localPort: 5173, remotePort: 4173 })).rejects.toThrow(/superseded/i);
    expect(f.nativeServices.startTunnel).not.toHaveBeenCalled();
    expect(f.nativeServices.api.revoke).toHaveBeenCalledOnce();
    await f.access.dispose();
  });
});

describe("CloudWorkspaceAccessBroker", () => {
  it("reconciles a lost published actor refresh response without minting or revoking again", async () => {
    const accessApi = api();
    vi.mocked(accessApi.issueEngineAdmission).mockResolvedValue({ version: 2, audience: "zeros-cloud-workspace-engine-client-admission-v2",
      organizationId: ORGANIZATION_ID, workspaceId: WORKSPACE_ID, generation: 7, authorityEpoch: 9, engineInstanceId: ENGINE_INSTANCE_ID,
      remotePort: 47891, grantToken: `zwa_${"d".repeat(43)}`, expiresAt: new Date(NOW + 120_000).toISOString(), bridgeUrl: "wss://api.zeros.test/v1/cloud-workspaces/bridge" });
    const access = broker(accessApi), first = await access.openRuntime({ organizationId: ORGANIZATION_ID, workspaceId: WORKSPACE_ID });
    const published = await access.refreshRuntime(first);
    expect(await access.refreshRuntime(first)).toEqual(published);
    expect(accessApi.issueEngineAdmission).toHaveBeenCalledTimes(2); expect(accessApi.revokeEngineAdmission).toHaveBeenCalledOnce();
    await access.closeRuntime(first.runtimeId);
    await expect(access.refreshRuntime(first)).rejects.toMatchObject({ code: "cloud_workspace_access_superseded" });
  });
  it("joins identical concurrent actor refresh attempts", async () => {
    const accessApi = api();
    vi.mocked(accessApi.issueEngineAdmission).mockResolvedValue({ version: 2, audience: "zeros-cloud-workspace-engine-client-admission-v2",
      organizationId: ORGANIZATION_ID, workspaceId: WORKSPACE_ID, generation: 7, authorityEpoch: 9, engineInstanceId: ENGINE_INSTANCE_ID,
      remotePort: 47891, grantToken: `zwa_${"d".repeat(43)}`, expiresAt: new Date(NOW + 120_000).toISOString(), bridgeUrl: "wss://api.zeros.test/v1/cloud-workspaces/bridge" });
    const access = broker(accessApi), first = await access.openRuntime({ organizationId: ORGANIZATION_ID, workspaceId: WORKSPACE_ID });
    const [a, b] = await Promise.all([access.refreshRuntime(first), access.refreshRuntime(first)]);
    expect(a).toEqual(b); expect(accessApi.issueEngineAdmission).toHaveBeenCalledTimes(2);
    await access.dispose();
  });
  it("retires the issuing session before a replacement account can refresh its handle", async () => {
    const accessApi = api();
    vi.mocked(accessApi.issueEngineAdmission).mockResolvedValue({version:2,audience:"zeros-cloud-workspace-engine-client-admission-v2",
      organizationId:ORGANIZATION_ID,workspaceId:WORKSPACE_ID,generation:7,authorityEpoch:9,engineInstanceId:ENGINE_INSTANCE_ID,
      remotePort:47891,grantToken:`zwa_${"d".repeat(43)}`,expiresAt:new Date(NOW+120000).toISOString(),bridgeUrl:"wss://api.zeros.test/v1/cloud-workspaces/bridge"});
    let identity = "account-a/session-a", token = "token-a";
    const retired = vi.fn();
    const broker = new CloudWorkspaceAccessBroker({api:accessApi,getAccountSessionKey:()=>identity,
      getAccessToken:async()=>token,onRuntimeRetired:retired,now:()=>NOW});
    const first=await broker.openRuntime({organizationId:ORGANIZATION_ID,workspaceId:WORKSPACE_ID});
    token = "refreshed-token-a";
    const refreshed=await broker.refreshRuntime(first);
    expect(retired).not.toHaveBeenCalled();
    vi.mocked(accessApi.revokeEngineAdmission).mockRejectedValue(new Error("offline"));
    identity="account-b/session-b";token="token-b";
    await expect(broker.refreshRuntime(refreshed)).rejects.toMatchObject({code:"cloud_workspace_access_superseded"});
    expect(retired).toHaveBeenCalledWith([first.runtimeId]);
    expect(accessApi.issueEngineAdmission).toHaveBeenCalledTimes(2);
    await vi.waitFor(()=>expect(accessApi.revokeEngineAdmission).toHaveBeenLastCalledWith("refreshed-token-a",expect.any(Object)));
  });
  it("rejects a token refresh completed after the source session was replaced",async()=>{
    const accessApi=api();let identity="account-a/session-a";
    let resolveToken!:(value:string)=>void;
    const broker=new CloudWorkspaceAccessBroker({api:accessApi,getAccountSessionKey:()=>identity,
      getAccessToken:()=>new Promise(resolve=>{resolveToken=resolve;}),now:()=>NOW});
    const opening=broker.openRuntime({organizationId:ORGANIZATION_ID,workspaceId:WORKSPACE_ID});
    const rejected=expect(opening).rejects.toMatchObject({code:"signed_out"});
    identity="account-a/session-new";resolveToken("replacement-token");await rejected;
    expect(accessApi.issueEngineAdmission).not.toHaveBeenCalled();
  });

  it("fences an in-flight actor refresh as soon as close starts",async()=>{
    const accessApi=api(),admission={version:2 as const,audience:"zeros-cloud-workspace-engine-client-admission-v2" as const,
      organizationId:ORGANIZATION_ID,workspaceId:WORKSPACE_ID,generation:7,authorityEpoch:9,engineInstanceId:ENGINE_INSTANCE_ID,
      remotePort:47891,grantToken:`zwa_${"d".repeat(43)}`,expiresAt:new Date(NOW+120000).toISOString(),bridgeUrl:"wss://api.zeros.test/v1/cloud-workspaces/bridge"};
    vi.mocked(accessApi.issueEngineAdmission).mockResolvedValue(admission);
    const retired=vi.fn();
    const broker=new CloudWorkspaceAccessBroker({api:accessApi,getAccountSessionKey:()=>"account-a/session-a",getAccessToken:async()=>"account-token",onRuntimeRetired:retired,now:()=>NOW});
    const first=await broker.openRuntime({organizationId:ORGANIZATION_ID,workspaceId:WORKSPACE_ID});
    let mint!:(value:typeof admission)=>void,retire!:()=>void;
    vi.mocked(accessApi.issueEngineAdmission).mockImplementationOnce(()=>new Promise(resolve=>{mint=resolve;}));
    const refreshing=broker.refreshRuntime(first);const rejected=expect(refreshing).rejects.toMatchObject({code:"cloud_workspace_access_superseded"});
    await vi.waitFor(()=>expect(mint).toBeTypeOf("function"));
    vi.mocked(accessApi.revokeEngineAdmission).mockImplementationOnce(()=>new Promise(resolve=>{retire=resolve;}));
    const closing=broker.closeRuntime(first.runtimeId);
    expect(retired).toHaveBeenCalledWith([first.runtimeId]);
    await vi.waitFor(()=>expect(retire).toBeTypeOf("function"));
    mint({...admission,grantToken:`zwa_${"e".repeat(43)}`});
    retire();await closing;await rejected;
    expect(accessApi.revokeEngineAdmission).toHaveBeenCalledWith("account-token",expect.objectContaining({grantToken:`zwa_${"e".repeat(43)}`}));
  });
  it("connects actor v2 directly through the control-plane relay and releases only that connection",async()=>{
    const accessApi=api();
    vi.mocked(accessApi.issueEngineAdmission).mockResolvedValue({version:2,audience:"zeros-cloud-workspace-engine-client-admission-v2",
      organizationId:ORGANIZATION_ID,workspaceId:WORKSPACE_ID,generation:7,authorityEpoch:9,engineInstanceId:ENGINE_INSTANCE_ID,
      remotePort:47891,grantToken:`zwa_${"d".repeat(43)}`,expiresAt:new Date(NOW+120000).toISOString(),bridgeUrl:"wss://api.zeros.test/v1/cloud-workspaces/bridge"});
    const broker=new CloudWorkspaceAccessBroker({api:accessApi,getAccountSessionKey:()=>"account-a/session-a",getAccessToken:async()=>"account-token",now:()=>NOW});
    const target=await broker.openRuntime({organizationId:ORGANIZATION_ID,workspaceId:WORKSPACE_ID});
    expect(target).toMatchObject({channel:"control-plane-websocket",url:"wss://api.zeros.test/v1/cloud-workspaces/bridge",cloudToken:`zwa_${"d".repeat(43)}`});
    expect(accessApi.issueTunnel).not.toHaveBeenCalled();
    await expect(broker.closeRuntime(target.runtimeId)).resolves.toBe(true);
    expect(accessApi.revokeEngineAdmission).toHaveBeenCalledWith("account-token",{organizationId:ORGANIZATION_ID,workspaceId:WORKSPACE_ID,grantToken:`zwa_${"d".repeat(43)}`});
    expect(accessApi.revoke).not.toHaveBeenCalled();
  });
  it("keeps a preview capability in main and returns only safe navigation metadata", async () => {
    const accessApi = api();
    const authorizePreview = vi.fn(() => true);
    const accessBroker = broker(accessApi);

    const result = await accessBroker.openPreview(
      {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
        port: 4173,
        frameName: "zeros-browser-cloud-1",
      },
      authorizePreview,
    );

    expect(authorizePreview).toHaveBeenCalledWith({
      frameName: "zeros-browser-cloud-1",
      origin: "https://0123456789abcdef0123456789abcdef.preview.zeros.test",
      expiresAt: Date.parse(EXPIRES_AT),
      capability: PREVIEW_CAPABILITY,
    });
    expect(result).toEqual({
      accessId: GRANT_ID,
      logicalUrl: "http://localhost:4173/",
      origin: "https://0123456789abcdef0123456789abcdef.preview.zeros.test",
      admissionUrl:
        "https://0123456789abcdef0123456789abcdef.preview.zeros.test/",
      expiresAt: EXPIRES_AT,
    });
    expect(JSON.stringify(result)).not.toContain(PREVIEW_CAPABILITY);
  });

  it("revokes an unpublished preview when frame-scoped authorization fails", async () => {
    const accessApi = api();
    const accessBroker = broker(accessApi);

    await expect(
      accessBroker.openPreview(
        {
          organizationId: ORGANIZATION_ID,
          workspaceId: WORKSPACE_ID,
          port: 4173,
          frameName: "zeros-browser-cloud-1",
        },
        () => false,
      ),
    ).rejects.toThrow(/frame authorization/i);
    expect(accessApi.revoke).toHaveBeenCalledWith("account-access-token", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      grantId: GRANT_ID,
      credential: PREVIEW_CAPABILITY,
    });
  });

  it("serializes renewal for one Browser frame so a late grant cannot become orphaned", async () => {
    const accessApi = api();
    const firstResponse = await accessApi.issuePreview("", {} as never);
    const secondResponse = {
      ...firstResponse,
      grant: { ...firstResponse.grant, id: SECOND_GRANT_ID },
      preview: {
        ...firstResponse.preview,
        capability: `zwp_${"c".repeat(43)}`,
      },
    };
    let resolveFirst!: (value: typeof firstResponse) => void;
    vi.mocked(accessApi.issuePreview)
      .mockReset()
      .mockImplementationOnce(
        async () =>
          new Promise<typeof firstResponse>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(secondResponse);
    const accessBroker = broker(accessApi);
    const target = {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      port: 4173,
      frameName: "zeros-browser-cloud-1",
    };

    const first = accessBroker.openPreview(target, () => true);
    await vi.waitFor(() =>
      expect(accessApi.issuePreview).toHaveBeenCalledTimes(1),
    );
    const second = accessBroker.openPreview(target, () => true);
    await Promise.resolve();
    const callsBeforeFirstCompleted = vi.mocked(accessApi.issuePreview).mock
      .calls.length;
    resolveFirst(firstResponse);
    await Promise.all([first, second]);

    expect(callsBeforeFirstCompleted).toBe(1);
    expect(accessApi.revoke).toHaveBeenCalledWith("account-access-token", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      grantId: GRANT_ID,
      credential: PREVIEW_CAPABILITY,
    });
  });

  it("does not let a late duplicate revocation orphan a newer preview for the same frame", async () => {
    const accessApi = api();
    const firstResponse = await accessApi.issuePreview("", {} as never);
    const secondCapability = `zwp_${"c".repeat(43)}`;
    vi.mocked(accessApi.issuePreview)
      .mockReset()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce({
        ...firstResponse,
        grant: { ...firstResponse.grant, id: SECOND_GRANT_ID },
        preview: { ...firstResponse.preview, capability: secondCapability },
      });
    const revokeReleases: Array<() => void> = [];
    vi.mocked(accessApi.revoke).mockImplementation(
      async () =>
        new Promise<void>((resolve) => {
          revokeReleases.push(resolve);
        }),
    );
    const accessBroker = broker(accessApi);
    const target = {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      port: 4173,
      frameName: "zeros-browser-cloud-1",
    };
    const first = await accessBroker.openPreview(target, () => true);

    const lateDuplicate = accessBroker.revoke(first.accessId);
    await vi.waitFor(() => expect(revokeReleases).toHaveLength(1));
    const renewal = accessBroker.openPreview(target, () => true);
    await vi.waitFor(() => expect(revokeReleases).toHaveLength(2));
    revokeReleases[1]!();
    const renewed = await renewal;
    expect(renewed.accessId).toBe(SECOND_GRANT_ID);

    revokeReleases[0]!();
    await lateDuplicate;
    const closeFrame = accessBroker.revokePreviewFrame(target.frameName);
    await vi.waitFor(() => expect(revokeReleases).toHaveLength(3));
    revokeReleases[2]!();
    await expect(closeFrame).resolves.toBe(true);
    expect(accessApi.revoke).toHaveBeenLastCalledWith("account-access-token", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      grantId: SECOND_GRANT_ID,
      credential: secondCapability,
    });
  });

  it("copies an SSH command without returning its bearer to renderer code", async () => {
    const accessApi = api();
    const writeClipboard = vi.fn();
    const accessBroker = broker(accessApi, { writeClipboard });

    const result = await accessBroker.copySshCommand({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });

    expect(writeClipboard).toHaveBeenCalledWith(
      `ssh ${SSH_CREDENTIAL}@ssh.fixture.test`,
    );
    expect(result).toEqual({ accessId: GRANT_ID, expiresAt: EXPIRES_AT });
    expect(JSON.stringify(result)).not.toContain(SSH_CREDENTIAL);
  });

  it("revokes SSH access when a native Terminal launch fails", async () => {
    const accessApi = api();
    const accessBroker = broker(accessApi, {
      launchTerminal: vi.fn(async () => {
        throw new Error("Terminal unavailable");
      }),
    });

    await expect(
      accessBroker.openSshTerminal({
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow("Terminal unavailable");
    expect(accessApi.revoke).toHaveBeenCalledWith("account-access-token", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      grantId: GRANT_ID,
      credential: SSH_CREDENTIAL,
    });
  });

  it("starts only a structured localhost tunnel and stops it before revocation", async () => {
    const accessApi = api();
    const order: string[] = [];
    const handle: CloudWorkspaceTunnelHandle = {
      localPort: 54173,
      stop: vi.fn(async () => {
        order.push("stop");
      }),
    };
    const startTunnel = vi.fn(async () => handle);
    vi.mocked(accessApi.revoke).mockImplementation(async () => {
      order.push("revoke");
    });
    const accessBroker = broker(accessApi, { startTunnel });

    const opened = await accessBroker.startTunnel({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      remotePort: 4173,
      localPort: 54173,
    });
    expect(startTunnel).toHaveBeenCalledWith({
      localHost: "127.0.0.1",
      localPort: 54173,
      remoteHost: "127.0.0.1",
      remotePort: 4173,
      sshUsername: SSH_CREDENTIAL,
      sshHost: "ssh.fixture.test",
      expiresAt: EXPIRES_AT,
    });
    expect(accessApi.issueTunnel).toHaveBeenCalledWith(
      "account-access-token",
      expect.objectContaining({
        deviceId: DEVICE_ID,
        requestedLocalPort: 54_173,
      }),
    );
    expect(accessApi.activateTunnel).toHaveBeenCalledWith(
      "account-access-token",
      {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
        sessionId: TUNNEL_SESSION_ID,
        deviceId: DEVICE_ID,
        observedLocalPort: 54_173,
      },
    );
    expect(opened).toEqual({
      accessId: GRANT_ID,
      localHost: "127.0.0.1",
      localPort: 54173,
      remotePort: 4173,
      expiresAt: EXPIRES_AT,
    });

    await accessBroker.revoke(GRANT_ID);
    expect(order).toEqual(["stop", "revoke"]);
  });

  it("stops and revokes a tunnel whose server activation fails", async () => {
    const accessApi = api();
    vi.mocked(accessApi.activateTunnel).mockRejectedValueOnce(
      new Error("activation rejected"),
    );
    const handle: CloudWorkspaceTunnelHandle = {
      localPort: 54_173,
      stop: vi.fn(async () => undefined),
    };
    const accessBroker = broker(accessApi, {
      startTunnel: vi.fn(async () => handle),
    });

    await expect(
      accessBroker.startTunnel({
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
        remotePort: 4_173,
        localPort: 54_173,
      }),
    ).rejects.toThrow("activation rejected");
    expect(handle.stop).toHaveBeenCalledOnce();
    expect(accessApi.revoke).toHaveBeenCalledOnce();
  });

  it("still revokes provider authority when local tunnel cleanup fails", async () => {
    const accessApi = api();
    const handle: CloudWorkspaceTunnelHandle = {
      localPort: 54173,
      stop: vi.fn(async () => {
        throw new Error("local tunnel cleanup failed");
      }),
    };
    const accessBroker = broker(accessApi, {
      startTunnel: vi.fn(async () => handle),
    });
    const opened = await accessBroker.startTunnel({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      remotePort: 4173,
      localPort: 54173,
    });

    await expect(accessBroker.revoke(opened.accessId)).rejects.toThrow(
      "local tunnel cleanup failed",
    );

    expect(accessApi.revoke).toHaveBeenCalledWith("account-access-token", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      grantId: GRANT_ID,
      credential: SSH_CREDENTIAL,
    });
  });

  it("requires a current main-process account session before issuing", async () => {
    const accessApi = api();
    const accessBroker = broker(accessApi, {
      getAccessToken: vi.fn(async () => null),
    });

    await expect(
      accessBroker.copySshCommand({
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toMatchObject({ code: "signed_out" });
    expect(accessApi.issueSsh).not.toHaveBeenCalled();
  });

  it("reserves local capacity before concurrent provider requests can overrun it", async () => {
    const accessApi = api();
    const response = await accessApi.issueSsh("", {} as never);
    const releases: Array<() => void> = [];
    vi.mocked(accessApi.issueSsh)
      .mockReset()
      .mockImplementation(async () => {
        if (releases.length >= 64) return response;
        return new Promise<typeof response>((resolve) => {
          releases.push(() => resolve(response));
        });
      });
    const accessBroker = broker(accessApi, { writeClipboard: vi.fn() });

    const openings = Array.from({ length: 64 }, () =>
      accessBroker.copySshCommand({
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
      }),
    );
    await vi.waitFor(() =>
      expect(accessApi.issueSsh).toHaveBeenCalledTimes(64),
    );

    const overflow = accessBroker
      .copySshCommand({
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
      })
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
    const overflowResult = await overflow;

    for (const release of releases) release();
    await Promise.all(openings);
    expect(overflowResult.error).toMatchObject({
      code: "cloud_access_local_limit",
    });
    expect(accessApi.issueSsh).toHaveBeenCalledTimes(64);
  });

  it("revokes an SSH issue that resolves after broker disposal without launching", async () => {
    const accessApi = api();
    const issued = await accessApi.issueSsh("", {} as never);
    let resolveIssue!: (value: typeof issued) => void;
    vi.mocked(accessApi.issueSsh)
      .mockReset()
      .mockImplementation(
        async () =>
          new Promise<typeof issued>((resolve) => {
            resolveIssue = resolve;
          }),
      );
    const launchTerminal = vi.fn(async () => undefined);
    const accessBroker = broker(accessApi, { launchTerminal });

    const opening = accessBroker.openSshTerminal({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });
    await vi.waitFor(() => expect(accessApi.issueSsh).toHaveBeenCalledOnce());
    await accessBroker.dispose();
    resolveIssue(issued);

    await expect(opening).rejects.toMatchObject({ code: "signed_out" });
    expect(launchTerminal).not.toHaveBeenCalled();
    expect(accessApi.revoke).toHaveBeenCalledWith("account-access-token", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      grantId: GRANT_ID,
      credential: SSH_CREDENTIAL,
    });
  });

  it("rolls back frame authorization when disposal races preview publication", async () => {
    const accessApi = api();
    const accessBroker = broker(accessApi);
    const revokeFrameAuthorization = vi.fn();

    const opening = accessBroker.openPreview(
      {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
        port: 4173,
        frameName: "zeros-browser-cloud-1",
      },
      () => {
        void accessBroker.dispose();
        return revokeFrameAuthorization;
      },
    );

    await expect(opening).rejects.toMatchObject({ code: "signed_out" });
    expect(revokeFrameAuthorization).toHaveBeenCalledOnce();
    expect(accessApi.revoke).toHaveBeenCalledWith("account-access-token", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      grantId: GRANT_ID,
      credential: PREVIEW_CAPABILITY,
    });
  });

  it("treats provider-wide SSH revocation as invalidating sibling SSH sessions", async () => {
    const accessApi = api();
    const firstResponse = await accessApi.issueSsh("", {} as never);
    vi.mocked(accessApi.issueSsh)
      .mockReset()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce({
        ...firstResponse,
        grant: {
          ...firstResponse.grant,
          id: SECOND_GRANT_ID,
        },
      });
    const accessBroker = broker(accessApi, { writeClipboard: vi.fn() });
    const first = await accessBroker.copySshCommand({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });
    const second = await accessBroker.copySshCommand({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });

    await accessBroker.revoke(first.accessId);
    await expect(accessBroker.revoke(second.accessId)).resolves.toBe(false);
  });

  it("fails sibling SSH handles closed when cleanup has an unknown provider result", async () => {
    const accessApi = api();
    const firstResponse = await accessApi.issueSsh("", {} as never);
    vi.mocked(accessApi.issueSsh)
      .mockReset()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce({
        ...firstResponse,
        grant: { ...firstResponse.grant, id: SECOND_GRANT_ID },
      });
    const accessBroker = broker(accessApi, {
      writeClipboard: vi.fn(),
      launchTerminal: vi.fn(async () => {
        throw new Error("terminal refused");
      }),
    });
    const first = await accessBroker.copySshCommand({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });
    vi.mocked(accessApi.revoke).mockRejectedValueOnce(
      new Error("revocation result unknown"),
    );

    await expect(
      accessBroker.openSshTerminal({
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow(/terminal refused/i);
    await expect(accessBroker.revoke(first.accessId)).resolves.toBe(false);
  });

  it("does not invalidate SSH access issued for a newer workspace generation", async () => {
    const accessApi = api();
    const firstResponse = await accessApi.issueSsh("", {} as never);
    vi.mocked(accessApi.issueSsh)
      .mockReset()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce({
        ...firstResponse,
        grant: {
          ...firstResponse.grant,
          id: SECOND_GRANT_ID,
          generation: firstResponse.grant.generation + 1,
        },
      });
    const accessBroker = broker(accessApi, { writeClipboard: vi.fn() });
    const first = await accessBroker.copySshCommand({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });
    const second = await accessBroker.copySshCommand({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });

    await accessBroker.revoke(first.accessId);
    await expect(accessBroker.revoke(second.accessId)).resolves.toBe(true);
    expect(accessApi.revoke).toHaveBeenCalledTimes(2);
  });

  it("opens and compare-and-swap refreshes an exact engine runtime tunnel", async () => {
    const accessApi = api();
    const tunnel: CloudWorkspaceTunnelHandle = {
      localPort: 55123,
      stop: vi.fn(async () => undefined),
    };
    const accessBroker = broker(accessApi, {
      startDynamicTunnel: vi.fn(async () => tunnel),
    });

    const first = await accessBroker.openRuntime({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(first).toEqual({
      kind: "cloud",
      channel: "electron-ssh-tunnel",
      runtimeId: "55555555-5555-4555-8555-555555555555",
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      generation: 7,
      authorityEpoch: 9,
      engineInstanceId: ENGINE_INSTANCE_ID,
      connectionSequence: 1,
      url: "ws://127.0.0.1:55123/ws",
      cloudToken: ENGINE_GRANT,
      expiresAt: NOW + 120_000,
    });
    expect(JSON.stringify(first)).not.toContain(SSH_CREDENTIAL);
    expect(accessApi.issueTunnel).toHaveBeenCalledWith(expect.any(String), {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      remotePort: 47_891,
      deviceId: DEVICE_ID,
      runtimeGeneration: 7,
      expiresInMinutes: 30,
      idempotencyKey: expect.stringContaining("desktop:tunnel:"),
    });

    const refreshed = await accessBroker.refreshRuntime(first);
    expect(refreshed).toMatchObject({
      runtimeId: first.runtimeId,
      connectionSequence: 2,
      generation: 7,
      engineInstanceId: ENGINE_INSTANCE_ID,
    });
    await expect(accessBroker.refreshRuntime(first)).resolves.toEqual(refreshed);
    expect(accessApi.issueTunnel).toHaveBeenCalledOnce();

    await expect(accessBroker.closeRuntime(first.runtimeId)).resolves.toBe(
      true,
    );
    expect(tunnel.stop).toHaveBeenCalledOnce();
  });

  it("forgets and best-effort revokes a superseded runtime generation", async () => {
    const accessApi = api();
    const firstAdmission = await accessApi.issueEngineAdmission(
      "",
      {} as never,
    );
    const firstTunnelResponse = await accessApi.issueTunnel("", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      remotePort: firstAdmission.remotePort,
      deviceId: DEVICE_ID,
      expiresInMinutes: 30,
      idempotencyKey: "test:runtime:first",
    });
    const nextAdmission = {
      ...firstAdmission,
      generation: firstAdmission.generation + 1,
      authorityEpoch: firstAdmission.authorityEpoch + 1,
      grantToken: `zws_${"d".repeat(43)}`,
    };
    const nextTunnelResponse = {
      ...firstTunnelResponse,
      grant: {
        ...firstTunnelResponse.grant,
        id: SECOND_GRANT_ID,
        generation: nextAdmission.generation,
      },
    };
    vi.mocked(accessApi.issueEngineAdmission)
      .mockReset()
      .mockResolvedValueOnce(firstAdmission)
      .mockResolvedValueOnce(nextAdmission);
    vi.mocked(accessApi.issueTunnel)
      .mockReset()
      .mockResolvedValueOnce(firstTunnelResponse)
      .mockResolvedValueOnce(nextTunnelResponse);
    vi.mocked(accessApi.revoke).mockRejectedValueOnce(
      new Error("old generation revoke unavailable"),
    );
    const oldTunnel: CloudWorkspaceTunnelHandle = {
      localPort: 55_123,
      stop: vi.fn(async () => undefined),
    };
    const replacementTunnel: CloudWorkspaceTunnelHandle = {
      localPort: 55_124,
      stop: vi.fn(async () => undefined),
    };
    const startDynamicTunnel = vi
      .fn()
      .mockResolvedValueOnce(oldTunnel)
      .mockResolvedValueOnce(replacementTunnel);
    const accessBroker = broker(accessApi, { startDynamicTunnel });

    const first = await accessBroker.openRuntime({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });
    const refreshed = await accessBroker.refreshRuntime(first);

    expect(refreshed).toMatchObject({
      generation: nextAdmission.generation,
      connectionSequence: 2,
    });
    expect(oldTunnel.stop).toHaveBeenCalledOnce();
    expect(accessApi.revoke).toHaveBeenCalledWith("account-access-token", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      grantId: GRANT_ID,
      credential: SSH_CREDENTIAL,
    });

    await accessBroker.dispose();
    expect(oldTunnel.stop).toHaveBeenCalledOnce();
    expect(replacementTunnel.stop).toHaveBeenCalledOnce();
    expect(accessApi.revoke).toHaveBeenCalledTimes(2);
  });

  it("does not revoke a same-generation runtime tunnel rotation", async () => {
    const accessApi = api();
    const firstAdmission = await accessApi.issueEngineAdmission(
      "",
      {} as never,
    );
    const firstTunnelResponse = await accessApi.issueTunnel("", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      remotePort: firstAdmission.remotePort,
      deviceId: DEVICE_ID,
      expiresInMinutes: 30,
      idempotencyKey: "test:runtime:first",
    });
    const nextAdmission = {
      ...firstAdmission,
      remotePort: firstAdmission.remotePort + 1,
      grantToken: `zws_${"d".repeat(43)}`,
    };
    const nextTunnelResponse = {
      ...firstTunnelResponse,
      grant: { ...firstTunnelResponse.grant, id: SECOND_GRANT_ID },
      tunnel: {
        ...firstTunnelResponse.tunnel,
        remotePort: nextAdmission.remotePort,
      },
    };
    vi.mocked(accessApi.issueEngineAdmission)
      .mockReset()
      .mockResolvedValueOnce(firstAdmission)
      .mockResolvedValueOnce(nextAdmission);
    vi.mocked(accessApi.issueTunnel)
      .mockReset()
      .mockResolvedValueOnce(firstTunnelResponse)
      .mockResolvedValueOnce(nextTunnelResponse);
    const oldTunnel: CloudWorkspaceTunnelHandle = {
      localPort: 55_123,
      stop: vi.fn(async () => undefined),
    };
    const replacementTunnel: CloudWorkspaceTunnelHandle = {
      localPort: 55_124,
      stop: vi.fn(async () => undefined),
    };
    const accessBroker = broker(accessApi, {
      startDynamicTunnel: vi
        .fn()
        .mockResolvedValueOnce(oldTunnel)
        .mockResolvedValueOnce(replacementTunnel),
    });

    const first = await accessBroker.openRuntime({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });
    const refreshed = await accessBroker.refreshRuntime(first);

    expect(refreshed).toMatchObject({ generation: first.generation });
    expect(oldTunnel.stop).toHaveBeenCalledOnce();
    expect(accessApi.revoke).not.toHaveBeenCalled();

    await accessBroker.closeRuntime(first.runtimeId);
    expect(accessApi.revoke).toHaveBeenCalledOnce();
  });

  it("revokes a mismatched runtime tunnel before it can cross IPC", async () => {
    const accessApi = api();
    const issued = await accessApi.issueTunnel("", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      remotePort: 47891,
      deviceId: DEVICE_ID,
      expiresInMinutes: 30,
      idempotencyKey: "test:mismatch",
    });
    vi.mocked(accessApi.issueTunnel)
      .mockReset()
      .mockResolvedValue({
        ...issued,
        grant: { ...issued.grant, generation: 8 },
      });
    const startDynamicTunnel = vi.fn();
    const accessBroker = broker(accessApi, { startDynamicTunnel });

    await expect(
      accessBroker.openRuntime({
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toMatchObject({ code: "cloud_workspace_access_superseded" });
    expect(startDynamicTunnel).not.toHaveBeenCalled();
    expect(accessApi.revoke).toHaveBeenCalledOnce();
  });

  it("coalesces provider-wide SSH revocation while disposing sibling access", async () => {
    const accessApi = api();
    const tunnelResponse = await accessApi.issueTunnel("", {} as never);
    vi.mocked(accessApi.issueTunnel)
      .mockReset()
      .mockResolvedValue({
        ...tunnelResponse,
        grant: { ...tunnelResponse.grant, id: SECOND_GRANT_ID },
      });
    const tunnel: CloudWorkspaceTunnelHandle = {
      localPort: 54173,
      stop: vi.fn(async () => undefined),
    };
    const disposeLocalAccess = vi.fn(async () => undefined);
    const accessBroker = broker(accessApi, {
      writeClipboard: vi.fn(),
      startTunnel: vi.fn(async () => tunnel),
      disposeLocalAccess,
    });
    await accessBroker.copySshCommand({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });
    await accessBroker.startTunnel({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      remotePort: 4173,
      localPort: 54173,
    });

    await accessBroker.dispose();

    expect(tunnel.stop).toHaveBeenCalledOnce();
    expect(disposeLocalAccess).toHaveBeenCalledOnce();
    expect(accessApi.revoke).toHaveBeenCalledOnce();
  });

  it("uses the captured issuing account token to revoke after sign-out", async () => {
    const accessApi = api();
    const getAccessToken = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce("issuing-account-token")
      .mockResolvedValue(null);
    const accessBroker = broker(accessApi, {
      getAccessToken,
      writeClipboard: vi.fn(),
    });
    await accessBroker.copySshCommand({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });

    await accessBroker.dispose();

    expect(accessApi.revoke).toHaveBeenCalledWith(
      "issuing-account-token",
      expect.objectContaining({
        grantId: GRANT_ID,
        credential: SSH_CREDENTIAL,
      }),
    );
  });
});
