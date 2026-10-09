import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@zeros/protocol/version";

import {
  CLOUD_RUNTIME_ENV,
  CloudRuntimeRegistration,
  consumeCloudRuntimeEnvironment,
  type CloudDurableRecordSyncContext,
  type CloudRuntimeAuthority,
} from "../cloud-runtime-registration";

const NOW = Date.parse("2026-08-23T12:00:00.000Z");
const registrationEndpoint =
  "https://control.example.test/internal/v1/cloud-workspaces/engine/register";
const heartbeatEndpoint =
  "https://control.example.test/internal/v1/cloud-workspaces/engine/heartbeat";
const clientAdmissionEndpoint =
  "https://control.example.test/internal/v2/cloud-workspaces/engine/client-admission";
const ACCOUNT_USER_ID = "55555555-5555-4555-8555-555555555555";
const V4_ATTESTATION = {
  profile: "zeros-cloud-worker-v4" as const, runtimeId: `r1-${"a".repeat(64)}`,
  manifestSha256: "a".repeat(64), baseCompatibilityId: `bc1-${"b".repeat(64)}`,
  installerReceiptSha256: "c".repeat(64), bootId: "12345678-1234-4234-8234-123456789abc",
  supervisorSessionId: "22345678-1234-4234-8234-123456789abc",
};
function actorAdmissionResponse(authorityEpoch = 1) {
  return {version:2,audience:"zeros-cloud-workspace-engine-client-admission-v2",admitted:true,
    authorityEpoch,accountUserId:ACCOUNT_USER_ID,actorSessionId:"22222222-2222-4222-8222-222222222222",
    deviceId:"33333333-3333-4333-8333-333333333333",role:"developer",fingerprint:"a".repeat(64)};
}

function completedDurableRecordSync() {
  return vi.fn(
    async (
      _authority: CloudRuntimeAuthority,
      _context: CloudDurableRecordSyncContext,
    ) => undefined,
  );
}

function encodedRuntime(overrides: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      audience: "zeros-cloud-engine-runtime-v1",
      execution: {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        organizationId: "22222222-2222-4222-8222-222222222222",
        generation: 3,
        setupRunId: "33333333-3333-4333-8333-333333333333",
        executionFence: 7,
      },
      engine: {
        instanceId: "44444444-4444-4444-8444-444444444444",
        protocolVersion: PROTOCOL_VERSION,
        readinessProbeToken: `zwr_${"R".repeat(43)}`,
      },
      registration: {
        endpoint: registrationEndpoint,
        token: `zws_${"A".repeat(43)}`,
        expiresAtMs: NOW + 60 * 60_000,
      },
      ...overrides,
    }),
  ).toString("base64url");
}

function registrationResponse() {
  return {
    version: 1,
    audience: "zeros-cloud-workspace-engine-registration-v1",
    engineInstanceId: "44444444-4444-4444-8444-444444444444",
    durableRecordConnected: true,
    leaseExpiresAtMs: NOW + 90_000,
    heartbeat: {
      endpoint: heartbeatEndpoint,
      token: `zwh_${"H".repeat(43)}`,
      intervalMs: 30_000,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("cloud runtime registration", () => {
  it.each(["local", "legacy"])("passes the authenticated %s journal mode before the initial record restore", async agentJournalMode => {
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const fetcher = vi.fn().mockResolvedValue(Response.json(registrationResponse(), {
      headers: { "x-zeros-cloud-local-commands": "1", "x-zeros-cloud-agent-journal": agentJournalMode,
        ...(agentJournalMode === "local" ? { "x-zeros-cloud-agent-source-writer": V4_ATTESTATION.bootId } : {}) },
    }));
    const sync = vi.fn(async () => {});
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher,
      now: () => NOW, negotiateLocalCommands: true, onAuthorityLost: vi.fn(), onDurableRecordSync: sync });
    try {
      await registration.start();
      expect(sync).toHaveBeenCalledWith(expect.anything(), { initial: true, agentJournalMode });
      expect(registration.agentSourceWriterEpoch).toBe(agentJournalMode === "local" ? V4_ATTESTATION.bootId : null);
    } finally { await registration.stop(); }
  });
  it.each([null, "", "not-a-writer", `${V4_ATTESTATION.bootId},${V4_ATTESTATION.bootId}`])(
    "refuses negotiated local history before restore when source writer is invalid (%s)", async sourceWriter => {
      const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
      const sync = completedDurableRecordSync();
      const fetcher = vi.fn().mockResolvedValue(Response.json(registrationResponse(), { headers: {
        "x-zeros-cloud-local-commands": "1", "x-zeros-cloud-agent-journal": "local",
        ...(sourceWriter === null ? {} : { "x-zeros-cloud-agent-source-writer": sourceWriter }),
      } }));
      const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher,
        now: () => NOW, negotiateLocalCommands: true, onAuthorityLost: vi.fn(), onDurableRecordSync: sync });
      try {
        await expect(registration.start()).rejects.toThrow();
        expect(sync).not.toHaveBeenCalled(); expect(registration.localCommandsNegotiated()).toBe(false);
      } finally { await registration.stop(); }
    });
  it.each(["legacy", "unnegotiated"])("does not grant source selection from %s response headers", async mode => {
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const sync = completedDurableRecordSync();
    const fetcher = vi.fn().mockResolvedValue(Response.json(registrationResponse(), { headers: {
      "x-zeros-cloud-agent-journal": mode === "legacy" ? "legacy" : "local",
      "x-zeros-cloud-agent-source-writer": "untrusted-invalid-header",
      ...(mode === "legacy" ? { "x-zeros-cloud-local-commands": "1" } : {}),
    } }));
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher,
      now: () => NOW, negotiateLocalCommands: mode === "legacy" ? true : undefined,
      onAuthorityLost: vi.fn(), onDurableRecordSync: sync });
    try {
      await registration.start(); expect(registration.agentSourceWriterEpoch).toBe(null);
      expect(sync).toHaveBeenCalledOnce();
    } finally { await registration.stop(); }
  });
  it.each([true, false])("negotiates local commands only with a committed CP header ACK (ack=%s)", async acknowledged => {
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const fetcher = vi.fn().mockResolvedValue(Response.json(registrationResponse(), {
      headers: acknowledged ? { "x-zeros-cloud-local-commands": "1" } : {},
    }));
    let release!: () => void;
    const connected = new Promise<void>(resolve => { release = resolve; });
    const registration = new CloudRuntimeRegistration(runtime, {
      agentRuntime: V4_ATTESTATION, fetch: fetcher, now: () => NOW, negotiateLocalCommands: true,
      onAuthorityLost: vi.fn(), onDurableRecordSync: () => connected,
    });
    try {
      const starting = registration.start();
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      expect(registration.localCommandsNegotiated()).toBe(false);
      expect(fetcher.mock.calls[0]![1].headers["x-zeros-cloud-local-commands"]).toBe("1");
      expect(JSON.parse(fetcher.mock.calls[0]![1].body)).not.toHaveProperty("cloudLocalCommandsVersion");
      release(); await starting;
      expect(registration.localCommandsNegotiated()).toBe(acknowledged);
      await registration.stop();
      expect(registration.localCommandsNegotiated()).toBe(false);
    } finally { release(); await registration.stop(); }
  });

  it("ignores an unsolicited new-mode header on a legacy registration", async () => {
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const fetcher = vi.fn().mockResolvedValue(Response.json(registrationResponse(), {
      headers: { "x-zeros-cloud-local-commands": "1" },
    }));
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher,
      now: () => NOW, onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync() });
    try {
      await registration.start();
      expect(fetcher.mock.calls[0]![1].headers).not.toHaveProperty("x-zeros-cloud-local-commands");
      expect(registration.localCommandsNegotiated()).toBe(false);
      await expect(registration.agentBootRequest("bootstrap", { version: 1, mode: "boot-owner-v1",
        ...runtime.execution, engineInstanceId: runtime.engine.instanceId }, new AbortController().signal))
        .rejects.toMatchObject({ code: "cloud_workspace_client_update_required" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { await registration.stop(); }
  });

  it.each([true, false])("binds background bootstrap to the attested runtime boot (same=%s)", async same => {
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const scope = { organizationId: runtime.execution.organizationId, workspaceId: runtime.execution.workspaceId,
      generation: runtime.execution.generation, engineInstanceId: runtime.engine.instanceId,
      bootId: same ? V4_ATTESTATION.bootId : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      writerEpoch: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", fundingOwnerUserId: ACCOUNT_USER_ID, fundingOwnerEpoch: 1 };
    const result = { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
      authorityEpoch: 1, cacheRevision: 1, desiredCacheRevision: 1,
      initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })),
      providers: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unavailable", code: "cloud_agent_credential_required" })) };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(registrationResponse(), {
      headers: { "x-zeros-cloud-local-commands": "1" },
    })).mockResolvedValueOnce(Response.json({ result }));
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher,
      now: () => NOW, negotiateLocalCommands: true, onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync() });
    try {
      await registration.start();
      const bootstrap = registration.agentBootRequest("bootstrap", { version: 1, mode: "boot-owner-v1",
        organizationId: scope.organizationId, workspaceId: scope.workspaceId, generation: scope.generation,
        engineInstanceId: scope.engineInstanceId }, new AbortController().signal);
      if (same) await expect(bootstrap).resolves.toEqual(result);
      else await expect(bootstrap).rejects.toMatchObject({ code: "cloud_admission_authority_response_invalid" });
      expect(String(fetcher.mock.calls[1]![0])).toBe("https://control.example.test/internal/v2/cloud-workspaces/engine/agent-boot/bootstrap");
      expect(fetcher.mock.calls[1]![1].headers.authorization).toBe(`Bearer ${registrationResponse().heartbeat.token}`);
      expect(JSON.parse(fetcher.mock.calls[1]![1].body)).not.toHaveProperty("fundingOwnerUserId");
    } finally { await registration.stop(); }
  });
  it("requires the exact acknowledged activation for private controls and mirrors and rejects late replies", async () => {
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const identity = { version: 1 as const, mode: "boot-owner-v1" as const, fundingScope: "workspace-roles-v1" as const,
      organizationId: runtime.execution.organizationId, workspaceId: runtime.execution.workspaceId,
      generation: runtime.execution.generation, engineInstanceId: runtime.engine.instanceId,
      bootId: V4_ATTESTATION.bootId, writerEpoch: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      fundingOwnerUserId: ACCOUNT_USER_ID, fundingOwnerEpoch: 1, authorityEpoch: 1 };
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/register")) return Response.json(registrationResponse(), { headers: { "x-zeros-cloud-local-commands": "1" } });
      if (url.pathname.endsWith("/activate")) return Response.json({ result: { ...identity, cacheRevision: 1, activated: true } });
      return Response.json({ result: { version: 1, mode: "boot-owner-v1", controls: [] } });
    });
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher, now: () => NOW,
      negotiateLocalCommands: true, onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync() });
    const { fundingScope: _funding, fundingOwnerUserId: _user, fundingOwnerEpoch: _ownerEpoch, authorityEpoch: _authority, ...reference } = identity;
    const control = { ...reference, acknowledgements: [] };
    try {
      await registration.start();
      await expect(registration.credentialControlsRequest(control, new AbortController().signal)).rejects.toMatchObject({ code: "engine_authority_rejected" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      await registration.agentBootRequest("activate", { ...reference, expectedCacheRevision: 1 }, new AbortController().signal);
      await expect(registration.credentialControlsRequest({ ...control, writerEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, new AbortController().signal))
        .rejects.toMatchObject({ code: "engine_authority_rejected" });
      await expect(registration.credentialControlsRequest(control, new AbortController().signal)).resolves.toEqual({ version: 1, mode: "boot-owner-v1", controls: [] });
      expect(String(fetcher.mock.calls.at(-1)![0])).toContain("/agent-credential-controls");
      let finish!: (value: Response) => void;
      fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const late = registration.credentialControlsRequest(control, new AbortController().signal);
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      await registration.stop(); finish(Response.json({ result: { version: 1, mode: "boot-owner-v1", controls: [] } }));
      await expect(late).rejects.toMatchObject({ code: "engine_authority_rejected" });
    } finally { await registration.stop(); }
  });
  it("fences final seals to the exact activated writer and refuses a retired response", async () => {
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const scope = { organizationId: runtime.execution.organizationId, workspaceId: runtime.execution.workspaceId,
      generation: runtime.execution.generation, engineInstanceId: runtime.engine.instanceId, bootId: V4_ATTESTATION.bootId,
      writerEpoch: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", fundingOwnerUserId: ACCOUNT_USER_ID, fundingOwnerEpoch: 1 };
    const identity = { ...scope, version: 1 as const, mode: "boot-owner-v1" as const, fundingScope: "workspace-roles-v1" as const, authorityEpoch: 1 };
    const fetcher = vi.fn<typeof fetch>(async input => new URL(String(input)).pathname.endsWith("/register") ?
      Response.json(registrationResponse(), { headers: { "x-zeros-cloud-local-commands": "1" } }) :
      Response.json({ result: { ...identity, cacheRevision: 1, activated: true } }));
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher, now: () => NOW,
      negotiateLocalCommands: true, onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync() });
    const descriptor = { version: 1 as const, scope, sealId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", sequence: 0,
      recordSequence: 1, eventSequence: 0, inventorySha256: "a".repeat(64) };
    const { createHash } = await import("node:crypto");
    const { canonicalCloudLocalCommandWriterSealDescriptor } = await import("@zeros/protocol/cloud-local-mirror");
    const seal = { ...descriptor, sha256: createHash("sha256").update(canonicalCloudLocalCommandWriterSealDescriptor(descriptor)).digest("hex") };
    try {
      await registration.start();
      await expect(registration.localCommandSealRequest(seal, new AbortController().signal)).rejects.toMatchObject({ code: "engine_authority_rejected" });
      const { fundingOwnerUserId: _owner, fundingOwnerEpoch: _epoch, ...reference } = scope;
      await registration.agentBootRequest("activate", { ...reference, version: 1, mode: "boot-owner-v1", expectedCacheRevision: 1 }, new AbortController().signal);
      await expect(registration.localCommandSealRequest({ ...seal, scope: { ...scope, writerEpoch: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } }, new AbortController().signal))
        .rejects.toMatchObject({ code: "engine_authority_rejected" });
      const { scope: _scope, ...fields } = seal, ack = { ...fields, writerEpoch: scope.writerEpoch };
      fetcher.mockResolvedValueOnce(Response.json({ result: ack }));
      expect(await registration.localCommandSealRequest(seal, new AbortController().signal)).toEqual(ack);
      let finish!: (response: Response) => void; fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const late = registration.localCommandSealRequest(seal, new AbortController().signal);
      await vi.waitFor(() => expect(finish).toBeTypeOf("function")); await registration.stop(); finish(Response.json({ result: ack }));
      await expect(late).rejects.toMatchObject({ code: "engine_authority_rejected" });
    } finally { await registration.stop(); }
  });
  it.each(["zeros-cloud-worker-v1", "zeros-cloud-worker-v2", "zeros-cloud-worker-v3"])("refuses %s before registration", profile => {
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const fetcher = vi.fn();
    expect(() => new CloudRuntimeRegistration(runtime, {
      agentRuntime: { profile, contractSha256: "a".repeat(64) } as unknown as typeof V4_ATTESTATION,
      fetch: fetcher, now: () => NOW, onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync(),
    })).toThrow(/attestation/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([false, true])("refuses a retired desktop grant without sending it to the control plane (renew=%s)", async renew => {
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(registrationResponse()))
      .mockResolvedValue(Response.json({ version: 1, audience: "zeros-cloud-workspace-engine-client-admission-v1",
        admitted: true, authorityEpoch: 1, accountUserId: ACCOUNT_USER_ID }));
    const registration = new CloudRuntimeRegistration(runtime, {
      agentRuntime: V4_ATTESTATION, fetch: fetcher, now: () => NOW,
      onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync(),
    });
    try {
      await registration.start();
      await expect(registration.verifyClientAdmission(`zws_${"G".repeat(43)}`, renew)).resolves.toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { await registration.stop(); }
  });
  it("flushes once for handoff and parks record writes while renewing the engine lease", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, Date.now)!;
    const sync = completedDurableRecordSync();
    const fetcher = vi.fn(async (url: URL | string) => new URL(url).pathname.endsWith("/register")
      ? Response.json(registrationResponse()) : Response.json({ version: 1,
        audience: "zeros-cloud-workspace-engine-heartbeat-v1", accepted: true,
        engineInstanceId: runtime.engine.instanceId, leaseExpiresAtMs: Date.now() + 90_000 }));
    const registration = new CloudRuntimeRegistration(runtime, {
      agentRuntime: V4_ATTESTATION,
      fetch: fetcher as typeof fetch, now: Date.now, onAuthorityLost: vi.fn(), onDurableRecordSync: sync,
    });
    try {
      await registration.start();
      let finish!: () => void;
      sync.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(undefined); }));
      const parked = registration.pauseRecordForRuntimeHandoff();
      await vi.advanceTimersByTimeAsync(0);
      expect(sync).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(sync).toHaveBeenCalledTimes(2);
      finish(); await parked;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(sync).toHaveBeenCalledTimes(2);
      await expect(registration.commandRequest({ kind: "claim", conversationId: "chat", executionId: "execution" }))
        .rejects.toMatchObject({ code: "command_durability_unavailable" });
      registration.resumeRecordAfterRuntimeHandoff();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sync).toHaveBeenCalledTimes(3);
    } finally { await registration.stop(); }
  });
  it("does not resume a parked record writer after the source lease is lost", async () => {
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const registration = new CloudRuntimeRegistration(runtime, {
      agentRuntime: V4_ATTESTATION,
      fetch: vi.fn(async () => Response.json(registrationResponse())), now: () => NOW,
      onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync(),
    });
    await registration.start(); await registration.pauseRecordForRuntimeHandoff();
    await registration.stop();
    expect(() => registration.resumeRecordAfterRuntimeHandoff()).toThrow("authority");
  });
  it("never promotes a failed handoff flush to a successful duplicate", async () => {
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const sync = completedDurableRecordSync();
    const registration = new CloudRuntimeRegistration(runtime, {
      agentRuntime: V4_ATTESTATION,
      fetch: vi.fn(async () => Response.json(registrationResponse())), now: () => NOW,
      onAuthorityLost: vi.fn(), onDurableRecordSync: sync,
    });
    try {
      await registration.start(); sync.mockRejectedValueOnce(new Error("record unavailable"));
      await expect(registration.pauseRecordForRuntimeHandoff()).rejects.toThrow();
      await expect(registration.pauseRecordForRuntimeHandoff()).rejects.toThrow();
      registration.resumeRecordAfterRuntimeHandoff();
      await registration.pauseRecordForRuntimeHandoff();
      expect(sync).toHaveBeenCalledTimes(3);
    } finally { await registration.stop(); }
  });
  it("leaves local engines outside the cloud registration path", () => {
    expect(consumeCloudRuntimeEnvironment({}, () => NOW)).toBeNull();
  });
  it("registers the complete v4 witness without a legacy image-contract claim", async () => {
    const runtime = consumeCloudRuntimeEnvironment({[CLOUD_RUNTIME_ENV]:encodedRuntime()},()=>NOW)!;
    const agentRuntime = {profile:"zeros-cloud-worker-v4" as const,runtimeId:`r1-${"a".repeat(64)}`,manifestSha256:"a".repeat(64),
      baseCompatibilityId:`bc1-${"b".repeat(64)}`,installerReceiptSha256:"c".repeat(64),
      bootId:"12345678-1234-4234-8234-123456789abc",supervisorSessionId:"22345678-1234-4234-8234-123456789abc"};
    const fetcher=vi.fn().mockResolvedValue(Response.json(registrationResponse()));
    const registration=new CloudRuntimeRegistration(runtime,{agentRuntime,fetch:fetcher,now:()=>NOW,
      onAuthorityLost:vi.fn(),onDurableRecordSync:completedDurableRecordSync()});
    try {
      await registration.start();
      const document=JSON.parse(fetcher.mock.calls[0][1].body);
      expect(document.agentRuntime).toEqual(agentRuntime);
      expect(document.agentCustomizationVersion).toBe(3);
      expect(document.agentRuntime).not.toHaveProperty("contractSha256");
    } finally { await registration.stop(); }
    for(const change of [{runtimeId:`r1-${"d".repeat(64)}`},{bootId:"invalid"},{supervisorSessionId:"invalid"},{contractSha256:"a".repeat(64)}])
      expect(()=>new CloudRuntimeRegistration(runtime,{agentRuntime:{...agentRuntime,...change},onAuthorityLost:vi.fn(),onDurableRecordSync:completedDurableRecordSync()})).toThrow(/attestation/);
  });
  it("preserves verified device control and Stop during a temporary record outage while blocking new claims", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, Date.now)!;
    const sync = completedDurableRecordSync();
    sync.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("temporary record outage"));
    const fetcher = vi.fn(async (url: URL | string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/register")) return Response.json(registrationResponse());
      if (path.endsWith("/heartbeat")) return Response.json({ version: 1, audience: "zeros-cloud-workspace-engine-heartbeat-v1",
        accepted: true, engineInstanceId: runtime.engine.instanceId, leaseExpiresAtMs: NOW + 120000 });
      if (path.endsWith("/client-admission")) return Response.json(actorAdmissionResponse());
      return Response.json({ result: { paused: true } });
    });
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher as typeof fetch, now: Date.now,
      onAuthorityLost: vi.fn(), onDurableRecordSync: sync });
    await registration.start(); await vi.advanceTimersByTimeAsync(30000);
    expect(registration.readiness()).toBeNull();
    await expect(registration.verifyClientAdmission(`zwa_${"A".repeat(43)}`, true)).resolves.toMatchObject({ accountUserId: ACCOUNT_USER_ID });
    await expect(registration.commandRequest({ kind: "stop", conversationId: "chat", operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).resolves.toEqual({ paused: true });
    await expect(registration.commandRequest({ kind: "claim", conversationId: "chat", executionId: "execution" })).rejects.toMatchObject({ code: "command_durability_unavailable" });
    await registration.stop();
  });

  it("flushes a fresh durable transcript before each terminal command receipt", async () => {
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const barriers: Array<() => void> = [];
    let initial = true;
    const sync = vi.fn(async () => {
      if (initial) { initial = false; return; }
      await new Promise<void>(resolve => { barriers.push(resolve); });
    });
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(registrationResponse()))
      .mockImplementation(async () => Response.json({ result: { state: "succeeded" } }));
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
      fetch: fetcher, now: () => NOW, onAuthorityLost: vi.fn(), onDurableRecordSync: sync,
    });
    await registration.start();
    const request = { kind: "settle" as const, result: {
      commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", claimId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      state: "succeeded" as const, resultCode: null,
    } };
    const first = registration.commandRequest(request);
    await vi.waitFor(() => expect(barriers).toHaveLength(1));
    const second = registration.commandRequest(request);
    expect(fetcher).toHaveBeenCalledTimes(1);
    barriers[0](); await first;
    await vi.waitFor(() => expect(barriers).toHaveLength(2));
    expect(fetcher).toHaveBeenCalledTimes(2);
    barriers[1](); await second;
    expect(fetcher).toHaveBeenCalledTimes(3);
    await registration.stop();
  });

  it("renews a consumed connection and ignores admission replies after shutdown", async () => {
    const runtime = consumeCloudRuntimeEnvironment(
      { [CLOUD_RUNTIME_ENV]: encodedRuntime() },
      () => NOW,
    )!;
    let finish!: (response: Response) => void;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(registrationResponse()))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
      fetch: fetcher,
      now: () => NOW,
      onAuthorityLost: vi.fn(),
      onDurableRecordSync: completedDurableRecordSync(),
    });
    await registration.start();
    const pending = registration.verifyClientAdmission(
      `zwa_${"A".repeat(43)}`,
      true,
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({
      renew: true,
    });
    await registration.stop();
    finish(
      Response.json(actorAdmissionResponse()),
    );
    await expect(pending).resolves.toBeNull();
  });
  it.each(["network", "503", "408", "429", "401", "403"])("distinguishes %s renewal from initial admission without disclosing upstream details", async kind => {
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(registrationResponse()));
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher,
      now: () => NOW, onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync() });
    await registration.start();
    for (const renew of [false, true]) {
      if (kind === "network") fetcher.mockRejectedValueOnce(new Error("private upstream content"));
      else fetcher.mockResolvedValueOnce(new Response("private upstream content", { status: Number(kind) }));
      const reply = registration.verifyClientAdmission(`zwa_${"A".repeat(43)}`, renew);
      if (renew && kind !== "401" && kind !== "403") await expect(reply).rejects.toMatchObject({ code: "cloud_client_authority_transient", message: "Cloud client authority is temporarily unavailable" });
      else await expect(reply).resolves.toBeNull();
    }
    await registration.stop();
  });

  it("rechecks service access through current heartbeat authority and refuses stale replies", async () => {
    const runtime = consumeCloudRuntimeEnvironment(
      { [CLOUD_RUNTIME_ENV]: encodedRuntime() },
      () => NOW,
    )!;
    const capability = `zwp_${"P".repeat(43)}`;
    const admission = {
      version: 1,
      audience: "zeros-cloud-runtime-access-admission-v1",
      admitted: true,
      grantId: "66666666-6666-4666-8666-666666666666",
      accountUserId: ACCOUNT_USER_ID,
      authorityEpoch: 1,
      kind: "preview",
      remotePort: 3000,
      expiresAtMs: NOW + 10_000,
    };
    let finish!: (response: Response) => void;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(registrationResponse()))
      .mockResolvedValueOnce(Response.json(admission))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
      fetch: fetcher,
      now: () => NOW,
      onAuthorityLost: vi.fn(),
      onDurableRecordSync: completedDurableRecordSync(),
    });
    expect(await registration.verifyServiceAccess(capability)).toBeNull();
    await registration.start();
    await expect(registration.verifyServiceAccess(capability)).resolves.toEqual(
      admission,
    );
    expect(fetcher.mock.calls[1][0]).toBe(
      "https://control.example.test/internal/v1/cloud-workspaces/engine/access-admission",
    );
    expect(fetcher.mock.calls[1][1].headers.authorization).toBe(
      `Bearer zwh_${"H".repeat(43)}`,
    );
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({
      grantToken: capability,
      generation: 3,
    });
    const pending = registration.verifyServiceAccess(capability);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await registration.stop();
    finish(Response.json(admission));
    await expect(pending).resolves.toBeNull();
  });

  it.each([
    { remotePort: 22 },
    { expiresAtMs: NOW },
    { expiresAtMs: NOW + 11_000 },
    { kind: "ssh" },
    { version: 2 },
    { grantId: "invalid" },
    { injected: true },
  ])("rejects malformed runtime service grants %j", async (change) => {
    const runtime = consumeCloudRuntimeEnvironment(
      { [CLOUD_RUNTIME_ENV]: encodedRuntime() },
      () => NOW,
    )!;
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
      fetch: vi
        .fn()
        .mockResolvedValueOnce(Response.json(registrationResponse()))
        .mockResolvedValueOnce(
          Response.json({
            version: 1,
            audience: "zeros-cloud-runtime-access-admission-v1",
            admitted: true,
            grantId: "66666666-6666-4666-8666-666666666666",
            accountUserId: ACCOUNT_USER_ID,
            authorityEpoch: 1,
            kind: "preview",
            remotePort: 3000,
            expiresAtMs: NOW + 10_000,
            ...change,
          }),
        ),
      now: () => NOW,
      onAuthorityLost: vi.fn(),
      onDurableRecordSync: completedDurableRecordSync(),
    });
    await registration.start();
    await expect(
      registration.verifyServiceAccess(`zwp_${"P".repeat(43)}`),
    ).resolves.toBeNull();
    await registration.stop();
  });

  it("uses a request-anchored relative service lease across clock skew and rejects expired transit", async () => {
    let now = NOW;
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const grant = { version: 1, audience: "zeros-cloud-runtime-access-admission-v1", admitted: true,
      grantId: "66666666-6666-4666-8666-666666666666", accountUserId: ACCOUNT_USER_ID,
      authorityEpoch: 1, kind: "preview", remotePort: 3000,
      expiresAtMs: NOW + 70_000, leaseDurationMs: 10_000 };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(registrationResponse()))
      .mockImplementationOnce(async () => { now += 200; return Response.json(grant); })
      .mockImplementationOnce(async () => { now += 10_001; return Response.json(grant); });
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher, now: () => now,
      onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync() });
    await registration.start();
    await expect(registration.verifyServiceAccess(`zwp_${"P".repeat(43)}`)).resolves.toMatchObject({ expiresAtMs: NOW + 10_000 });
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toHaveProperty("relativeLease", true);
    await expect(registration.verifyServiceAccess(`zwp_${"P".repeat(43)}`)).resolves.toBeNull();
    await registration.stop();
  });

  it("consumes and deletes the one-process runtime environment", () => {
    const env = { [CLOUD_RUNTIME_ENV]: encodedRuntime() };
    const runtime = consumeCloudRuntimeEnvironment(env, () => NOW);

    expect(env).not.toHaveProperty(CLOUD_RUNTIME_ENV);
    expect(runtime).toMatchObject({
      execution: { generation: 3, executionFence: 7 },
      engine: { protocolVersion: PROTOCOL_VERSION },
      registration: { endpoint: registrationEndpoint },
    });
  });

  it("deletes malformed runtime material before failing closed", () => {
    const env = { [CLOUD_RUNTIME_ENV]: "not-base64url==" };
    expect(() => consumeCloudRuntimeEnvironment(env, () => NOW)).toThrow(
      "runtime",
    );
    expect(env).not.toHaveProperty(CLOUD_RUNTIME_ENV);
  });

  it("registers actor protocol and verified private runtime identity together", async () => {
    const runtime=consumeCloudRuntimeEnvironment({[CLOUD_RUNTIME_ENV]:encodedRuntime()},()=>NOW)!;
    const fetch=vi.fn<typeof globalThis.fetch>(async()=>Response.json(registrationResponse()));
    const agentRuntime=V4_ATTESTATION;
    const registration=new CloudRuntimeRegistration(runtime,{
      fetch,now:()=>NOW,onAuthorityLost:vi.fn(),onDurableRecordSync:completedDurableRecordSync(),
      ...{agentRuntime},
    });
    try {
      await registration.start();
      expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({actorProtocolVersion:2,agentRuntime});
      expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toHaveProperty("agentCustomizationVersion",3);
    } finally { await registration.stop(); }
  });

  it("registers the exact engine without putting a capability in URL or body", async () => {
    const runtime = consumeCloudRuntimeEnvironment(
      { [CLOUD_RUNTIME_ENV]: encodedRuntime() },
      () => NOW,
    )!;
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(registrationResponse()),
    );
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
      fetch: fetch as typeof globalThis.fetch,
      now: () => NOW,
      onAuthorityLost: vi.fn(),
      onDurableRecordSync: completedDurableRecordSync(),
    });

    await registration.start();
    expect(registration.readiness()).toEqual({
      version: 1,
      instanceId: runtime.engine.instanceId,
      protocolVersion: PROTOCOL_VERSION,
      health: "ready",
      durableRecordConnected: true,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(registrationEndpoint);
    expect(url).not.toContain(runtime.registration.token);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${runtime.registration.token}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      workspaceId: runtime.execution.workspaceId,
      organizationId: runtime.execution.organizationId,
      generation: runtime.execution.generation,
      setupRunId: runtime.execution.setupRunId,
      executionFence: runtime.execution.executionFence,
      engineInstanceId: runtime.engine.instanceId,
      protocolVersion: runtime.engine.protocolVersion,
      actorProtocolVersion: 2,
      agentCustomizationVersion: 3,
      agentRuntime: V4_ATTESTATION,
    });
    expect(String(init?.body)).not.toContain(runtime.registration.token);
    await registration.stop();
  });

  it("renews its lease and loses authority immediately on a terminal heartbeat", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const runtime = consumeCloudRuntimeEnvironment(
      { [CLOUD_RUNTIME_ENV]: encodedRuntime() },
      Date.now,
    )!;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(registrationResponse()))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "engine_heartbeat_rejected" } },
          { status: 401 },
        ),
      );
    const onAuthorityLost = vi.fn();
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
      fetch: fetch as typeof globalThis.fetch,
      now: Date.now,
      onAuthorityLost,
      onDurableRecordSync: completedDurableRecordSync(),
    });
    await registration.start();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![0]).toBe(heartbeatEndpoint);
    expect(onAuthorityLost).toHaveBeenCalledTimes(1);
    expect(registration.readiness()).toBeNull();
    await registration.stop();
  });

  it("contains a rejected heartbeat timer task when authority cleanup throws", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const runtime = consumeCloudRuntimeEnvironment(
      { [CLOUD_RUNTIME_ENV]: encodedRuntime() },
      Date.now,
    )!;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(registrationResponse()))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "engine_heartbeat_rejected" } },
          { status: 401 },
        ),
      );
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
      fetch: fetch as typeof globalThis.fetch,
      now: Date.now,
      onAuthorityLost: () => {
        throw new Error("host teardown failed");
      },
      onDurableRecordSync: completedDurableRecordSync(),
    });
    await registration.start();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await registration.stop();
  });

  it("publishes only a canonical listener snapshot when the Linux view is available", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const runtime = consumeCloudRuntimeEnvironment(
      { [CLOUD_RUNTIME_ENV]: encodedRuntime() },
      Date.now,
    )!;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(registrationResponse()))
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          audience: "zeros-cloud-workspace-engine-heartbeat-v1",
          accepted: true,
          engineInstanceId: runtime.engine.instanceId,
          leaseExpiresAtMs: NOW + 120_000,
        }),
      );
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
      fetch: fetch as typeof globalThis.fetch,
      now: Date.now,
      onAuthorityLost: vi.fn(),
      onDurableRecordSync: completedDurableRecordSync(),
      readObservedPorts: vi.fn(async () => [
        { port: 3_000, protocol: "tcp" as const },
        { port: 8_080, protocol: "tcp" as const },
      ]),
    });
    await registration.start();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toMatchObject({
      observedPorts: [
        { port: 3_000, protocol: "tcp" },
        { port: 8_080, protocol: "tcp" },
      ],
    });
    await registration.stop();
  });

  it("redeems a desktop grant with heartbeat authority and rejects malformed responses", async () => {
    const runtime = consumeCloudRuntimeEnvironment(
      { [CLOUD_RUNTIME_ENV]: encodedRuntime() },
      () => NOW,
    )!;
    const grantToken = `zwa_${"G".repeat(43)}`;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(registrationResponse()))
      .mockResolvedValueOnce(
        Response.json(actorAdmissionResponse(9)),
      )
      .mockResolvedValueOnce(Response.json({ admitted: true }));
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
      fetch: fetch as typeof globalThis.fetch,
      now: () => NOW,
      onAuthorityLost: vi.fn(),
      onDurableRecordSync: completedDurableRecordSync(),
    });
    await registration.start();

    await expect(
      registration.verifyClientAdmission(grantToken),
    ).resolves.toMatchObject({
      accountUserId: ACCOUNT_USER_ID,
      authorityEpoch: 9,
      actor: { sessionId: actorAdmissionResponse().actorSessionId },
    });
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe(clientAdmissionEndpoint);
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${registrationResponse().heartbeat.token}`,
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      workspaceId: runtime.execution.workspaceId,
      organizationId: runtime.execution.organizationId,
      generation: runtime.execution.generation,
      engineInstanceId: runtime.engine.instanceId,
      grantToken,
    });
    expect(String(init?.body)).not.toContain(
      registrationResponse().heartbeat.token,
    );
    await expect(
      registration.verifyClientAdmission(grantToken),
    ).resolves.toBeNull();
    await registration.stop();
  });

  it("redeems actor admission and refuses a retired response schema",async()=>{
    vi.useFakeTimers();vi.setSystemTime(NOW);
    const runtime=consumeCloudRuntimeEnvironment({[CLOUD_RUNTIME_ENV]:encodedRuntime()},Date.now)!;
    const body={version:2,audience:"zeros-cloud-workspace-engine-client-admission-v2",admitted:true,
      authorityEpoch:9,accountUserId:ACCOUNT_USER_ID,actorSessionId:"22222222-2222-4222-8222-222222222222",
      deviceId:"33333333-3333-4333-8333-333333333333",role:"developer",fingerprint:"a".repeat(64)};
    const fetch=vi.fn().mockResolvedValueOnce(Response.json(registrationResponse()))
      .mockResolvedValueOnce(Response.json(body)).mockResolvedValueOnce(Response.json({...body,version:1}));
    const registration=new CloudRuntimeRegistration(runtime,{ agentRuntime: V4_ATTESTATION,fetch:fetch as typeof globalThis.fetch,now:()=>NOW,onAuthorityLost:vi.fn(),onDurableRecordSync:completedDurableRecordSync()});
    await registration.start();
    await expect(registration.verifyClientAdmission(`zwa_${"G".repeat(43)}`)).resolves.toMatchObject({accountUserId:ACCOUNT_USER_ID,actor:{sessionId:body.actorSessionId,deviceId:body.deviceId,role:"developer"}});
    expect(fetch.mock.calls[1]![0]).toContain("/internal/v2/cloud-workspaces/engine/client-admission");
    await expect(registration.verifyClientAdmission(`zwa_${"H".repeat(43)}`)).resolves.toBeNull();
    await registration.stop();
  });

  it("rotates a repository working copy through the heartbeat without sending an old token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const runtime = consumeCloudRuntimeEnvironment(
      { [CLOUD_RUNTIME_ENV]: encodedRuntime() },
      Date.now,
    )!;
    const refresh = {
      version: 1 as const,
      audience: "zeros-cloud-github-refresh-v1" as const,
      generation: "refresh-generation-000000000001",
      requestedAt: NOW,
      ownerSubjectSha256: "c".repeat(64),
      method: "github-app" as const,
      reason: "credential-invalid" as const,
    };
    const projection = {
      version: 1,
      audience: "zeros-cloud-github-credential-v1",
      generation: "projection-generation-0000000001",
      issuedAt: NOW + 30_000,
      expiresAt: NOW + 60 * 60_000,
      ownerSubjectSha256: "c".repeat(64),
      method: "github-app",
      credential: {
        method: "github-app",
        accessToken: "ghs_rotated-working-copy",
        gitHost: "github.com",
        gitHttpUsername: "x-access-token",
        expiresAtMs: NOW + 60 * 60_000,
      },
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(registrationResponse()))
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          audience: "zeros-cloud-workspace-engine-heartbeat-v1",
          accepted: true,
          engineInstanceId: runtime.engine.instanceId,
          leaseExpiresAtMs: NOW + 120_000,
          repositoryCredential: {
            requestGeneration: refresh.generation,
            outcome: "rotated",
            document: projection,
          },
        }),
      );
    const installRepositoryCredential = vi.fn();
    const acknowledgeRepositoryCredentialRefresh = vi.fn(() => true);
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
      fetch: fetch as typeof globalThis.fetch,
      now: Date.now,
      onAuthorityLost: vi.fn(),
      onDurableRecordSync: completedDurableRecordSync(),
      readRepositoryCredentialRefresh: () => refresh,
      installRepositoryCredential,
      acknowledgeRepositoryCredentialRefresh,
    });
    await registration.start();
    await vi.advanceTimersByTimeAsync(30_000);

    const heartbeatBody = JSON.parse(String(fetch.mock.calls[1]![1]?.body));
    expect(heartbeatBody.repositoryCredentialRefresh).toEqual({
      generation: refresh.generation,
      requestedAtMs: refresh.requestedAt,
      ownerSubjectSha256: refresh.ownerSubjectSha256,
      method: "github-app",
      reason: "credential-invalid",
    });
    expect(JSON.stringify(heartbeatBody)).not.toContain(
      "ghs_rotated-working-copy",
    );
    expect(installRepositoryCredential).toHaveBeenCalledWith(projection);
    expect(acknowledgeRepositoryCredentialRefresh).toHaveBeenCalledWith(
      refresh.generation,
    );
    await registration.stop();
  });

  it("delivers one exact checkpoint directive while heartbeats continue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const runtime = consumeCloudRuntimeEnvironment(
      { [CLOUD_RUNTIME_ENV]: encodedRuntime() },
      Date.now,
    )!;
    const directive = {
      id: "55555555-5555-4555-8555-555555555555",
      reason: "before_stop",
      deadlineAtMs: NOW + 5 * 60_000,
    };
    const heartbeat = (leaseExpiresAtMs: number) =>
      Response.json({
        version: 1,
        audience: "zeros-cloud-workspace-engine-heartbeat-v1",
        accepted: true,
        engineInstanceId: runtime.engine.instanceId,
        leaseExpiresAtMs,
        checkpointRequest: directive,
      });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(registrationResponse()))
      .mockResolvedValueOnce(heartbeat(NOW + 120_000))
      .mockResolvedValueOnce(heartbeat(NOW + 150_000));
    let finish!: () => void;
    const checkpoint = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onCheckpointRequested = vi.fn(() => checkpoint);
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
      fetch: fetch as typeof globalThis.fetch,
      now: Date.now,
      onAuthorityLost: vi.fn(),
      onDurableRecordSync: completedDurableRecordSync(),
      onCheckpointRequested,
    });
    await registration.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onCheckpointRequested).toHaveBeenCalledWith(directive, {
      heartbeatEndpoint,
      heartbeatToken: `zwh_${"H".repeat(43)}`,
      workspaceId: runtime.execution.workspaceId,
      organizationId: runtime.execution.organizationId,
      generation: runtime.execution.generation,
      engineInstanceId: runtime.engine.instanceId,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(onCheckpointRequested).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve();
    await registration.stop();
  });

  it("rejects a cross-origin heartbeat or mismatched durable identity", async () => {
    const runtime = consumeCloudRuntimeEnvironment(
      { [CLOUD_RUNTIME_ENV]: encodedRuntime() },
      () => NOW,
    )!;
    for (const response of [
      {
        ...registrationResponse(),
        engineInstanceId: "55555555-5555-4555-8555-555555555555",
      },
      {
        ...registrationResponse(),
        heartbeat: {
          ...registrationResponse().heartbeat,
          endpoint:
            "https://other.example.test/internal/v1/cloud-workspaces/engine/heartbeat",
        },
      },
    ]) {
      const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
        fetch: vi.fn(async () =>
          Response.json(response),
        ) as typeof globalThis.fetch,
        now: () => NOW,
        onAuthorityLost: vi.fn(),
        onDurableRecordSync: completedDurableRecordSync(),
      });
      await expect(registration.start()).rejects.toThrow("registration");
      expect(registration.readiness()).toBeNull();
    }
  });

  it("marks only the registration sync as initial", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const runtime = consumeCloudRuntimeEnvironment(
      { [CLOUD_RUNTIME_ENV]: encodedRuntime() },
      Date.now,
    )!;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(registrationResponse()))
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          audience: "zeros-cloud-workspace-engine-heartbeat-v1",
          accepted: true,
          engineInstanceId: runtime.engine.instanceId,
          leaseExpiresAtMs: NOW + 120_000,
        }),
      );
    const onDurableRecordSync = completedDurableRecordSync();
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
      fetch: fetch as typeof globalThis.fetch,
      now: Date.now,
      onAuthorityLost: vi.fn(),
      onDurableRecordSync,
    });

    await registration.start();
    expect(onDurableRecordSync.mock.calls[0]?.[1]).toEqual({ initial: true });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() =>
      expect(onDurableRecordSync).toHaveBeenCalledTimes(2),
    );
    expect(onDurableRecordSync.mock.calls[1]?.[1]).toEqual({ initial: false });
    await registration.stop();
  });

  it("withholds readiness until the durable record projection has converged", async () => {
    const runtime = consumeCloudRuntimeEnvironment(
      { [CLOUD_RUNTIME_ENV]: encodedRuntime() },
      () => NOW,
    )!;
    let complete!: () => void;
    const durableRecordSync = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const onDurableRecordSync = vi.fn(() => durableRecordSync);
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
      fetch: vi.fn(async () =>
        Response.json(registrationResponse()),
      ) as typeof globalThis.fetch,
      now: () => NOW,
      onAuthorityLost: vi.fn(),
      onDurableRecordSync,
    });

    const starting = registration.start();
    await vi.waitFor(() =>
      expect(onDurableRecordSync).toHaveBeenCalledTimes(1),
    );
    expect(registration.readiness()).toBeNull();
    expect(onDurableRecordSync).toHaveBeenCalledWith(
      {
        heartbeatEndpoint,
        heartbeatToken: `zwh_${"H".repeat(43)}`,
        workspaceId: runtime.execution.workspaceId,
        organizationId: runtime.execution.organizationId,
        generation: runtime.execution.generation,
        engineInstanceId: runtime.engine.instanceId,
      },
      { initial: true },
    );

    complete();
    await starting;
    expect(registration.readiness()?.durableRecordConnected).toBe(true);
    await registration.stop();
  });
});
