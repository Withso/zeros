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
  "https://control.example.test/internal/v1/cloud-workspaces/engine/client-admission";
const ACCOUNT_USER_ID = "55555555-5555-4555-8555-555555555555";

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
      if (path.endsWith("/client-admission")) return Response.json({ version: 1, audience: "zeros-cloud-workspace-engine-client-admission-v1",
        admitted: true, accountUserId: ACCOUNT_USER_ID, authorityEpoch: 1 });
      return Response.json({ result: { paused: true } });
    });
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) }, fetch: fetcher as typeof fetch, now: Date.now,
      onAuthorityLost: vi.fn(), onDurableRecordSync: sync });
    await registration.start(); await vi.advanceTimersByTimeAsync(30000);
    expect(registration.readiness()).toBeNull();
    await expect(registration.verifyClientAdmission(`zws_${"A".repeat(43)}`, true)).resolves.toMatchObject({ accountUserId: ACCOUNT_USER_ID });
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
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) },
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
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) },
      fetch: fetcher,
      now: () => NOW,
      onAuthorityLost: vi.fn(),
      onDurableRecordSync: completedDurableRecordSync(),
    });
    await registration.start();
    const pending = registration.verifyClientAdmission(
      `zws_${"A".repeat(43)}`,
      true,
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({
      renew: true,
    });
    await registration.stop();
    finish(
      Response.json({
        version: 1,
        audience: "zeros-cloud-workspace-engine-client-admission-v1",
        admitted: true,
        authorityEpoch: 1,
        accountUserId: ACCOUNT_USER_ID,
      }),
    );
    await expect(pending).resolves.toBeNull();
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
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) },
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
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) },
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
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) }, fetch: fetcher, now: () => now,
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
    const agentRuntime={profile:"zeros-cloud-worker-v3" as const,contractSha256:"a".repeat(64)};
    const registration=new CloudRuntimeRegistration(runtime,{
      fetch,now:()=>NOW,onAuthorityLost:vi.fn(),onDurableRecordSync:completedDurableRecordSync(),
      ...{agentRuntime},
    });
    try {
      await registration.start();
      expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({actorProtocolVersion:2,agentRuntime});
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
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) },
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
      agentRuntime: {profile:"zeros-cloud-worker-v3",contractSha256:"a".repeat(64)},
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
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) },
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
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) },
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
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) },
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
    const grantToken = `zws_${"G".repeat(43)}`;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(registrationResponse()))
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          audience: "zeros-cloud-workspace-engine-client-admission-v1",
          admitted: true,
          authorityEpoch: 9,
          accountUserId: ACCOUNT_USER_ID,
        }),
      )
      .mockResolvedValueOnce(Response.json({ admitted: true }));
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) },
      fetch: fetch as typeof globalThis.fetch,
      now: () => NOW,
      onAuthorityLost: vi.fn(),
      onDurableRecordSync: completedDurableRecordSync(),
    });
    await registration.start();

    await expect(
      registration.verifyClientAdmission(grantToken),
    ).resolves.toEqual({
      accountUserId: ACCOUNT_USER_ID,
      authorityEpoch: 9,
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

  it("redeems v2 actor admission without relaxing the strict v1 response contract",async()=>{
    vi.useFakeTimers();vi.setSystemTime(NOW);
    const runtime=consumeCloudRuntimeEnvironment({[CLOUD_RUNTIME_ENV]:encodedRuntime()},Date.now)!;
    const body={version:2,audience:"zeros-cloud-workspace-engine-client-admission-v2",admitted:true,
      authorityEpoch:9,accountUserId:ACCOUNT_USER_ID,actorSessionId:"22222222-2222-4222-8222-222222222222",
      deviceId:"33333333-3333-4333-8333-333333333333",role:"developer",fingerprint:"a".repeat(64)};
    const fetch=vi.fn().mockResolvedValueOnce(Response.json(registrationResponse()))
      .mockResolvedValueOnce(Response.json(body)).mockResolvedValueOnce(Response.json({...body,version:1}));
    const registration=new CloudRuntimeRegistration(runtime,{ agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) },fetch:fetch as typeof globalThis.fetch,now:()=>NOW,onAuthorityLost:vi.fn(),onDurableRecordSync:completedDurableRecordSync()});
    await registration.start();
    await expect(registration.verifyClientAdmission(`zwa_${"G".repeat(43)}`)).resolves.toMatchObject({accountUserId:ACCOUNT_USER_ID,actor:{sessionId:body.actorSessionId,deviceId:body.deviceId,role:"developer"}});
    expect(fetch.mock.calls[1]![0]).toContain("/internal/v2/cloud-workspaces/engine/client-admission");
    await expect(registration.verifyClientAdmission(`zws_${"H".repeat(43)}`)).resolves.toBeNull();
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
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) },
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
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) },
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
      const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) },
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
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) },
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
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: { profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) },
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
