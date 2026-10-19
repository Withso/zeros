import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@zeros/protocol/version";
import { CLOUD_ENGINE_EXIT_REPORT_ENV } from "@zeros/protocol/cloud-runtime-lifecycle";

import {
  CLOUD_RUNTIME_ENV,
  CloudClientAuthorityTransientError,
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
  vi.restoreAllMocks();
});

describe("supervisor exit reporting compatibility", () => {
  it.each(["armed", "absent", "foreign-engine", "foreign-runtime", "foreign-boot", "foreign-supervisor", "foreign-setup", "malformed"])(
    "offers lease.v1 only for an armed exact launch episode (%s)", kind => {
      const source = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
      const report = { version: 1, audience: "zeros-cloud-engine-exit-v1", reason: "unexpected_exit",
        reportId: ACCOUNT_USER_ID, ...source.execution, engineInstanceId: source.engine.instanceId,
        runtimeId: V4_ATTESTATION.runtimeId, bootId: V4_ATTESTATION.bootId, supervisorSessionId: V4_ATTESTATION.supervisorSessionId };
      if (kind === "foreign-engine") report.engineInstanceId = ACCOUNT_USER_ID;
      if (kind === "foreign-runtime") report.runtimeId = `r1-${"f".repeat(64)}`;
      if (kind === "foreign-boot") report.bootId = ACCOUNT_USER_ID;
      if (kind === "foreign-supervisor") report.supervisorSessionId = ACCOUNT_USER_ID;
      if (kind === "foreign-setup") report.executionFence += 1;
      const env: Record<string, string | undefined> = { [CLOUD_RUNTIME_ENV]: encodedRuntime(),
        ...(kind === "absent" ? {} : { [CLOUD_ENGINE_EXIT_REPORT_ENV]: kind === "malformed" ? "bad" : Buffer.from(JSON.stringify(report)).toString("base64url") }) };
      const config = consumeCloudRuntimeEnvironment(env, () => NOW)!;
      const registration = new CloudRuntimeRegistration(config, { agentRuntime: V4_ATTESTATION,
        onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync() });
      const features = registration.uplinkFeatures();
      expect(features.includes("lease.v1")).toBe(kind === "armed");
      expect(features.includes("exit.report.v1")).toBe(kind === "armed");
      expect(features).toContain("checkpoint.fallback.v1");
      expect(env).not.toHaveProperty(CLOUD_ENGINE_EXIT_REPORT_ENV);
    });
  it("Local consumes no registration or exit-report capability", () => {
    const env = { [CLOUD_ENGINE_EXIT_REPORT_ENV]: "bad" };
    expect(consumeCloudRuntimeEnvironment(env)).toBeNull();
    expect(env).toEqual({});
  });
});

describe("cloud renewal timing", () => {
  function fixture(options: { negotiated?: boolean } = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let monotonic = 100;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json(registrationResponse(), {
      headers: options.negotiated ? { "x-zeros-cloud-local-commands": "1" } : {},
    }));
    const lost = vi.fn();
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher,
      now: () => NOW, ...(options.negotiated ? { negotiateLocalCommands: true as const } : {}),
      onAuthorityLost: lost, onDurableRecordSync: completedDurableRecordSync() });
    const reports = () => log.mock.calls.filter(([line]) => typeof line === "string" && line.startsWith("[cloud-runtime] renewal-timing "))
      .map(([line]) => JSON.parse(String(line).slice("[cloud-runtime] renewal-timing ".length)));
    return { registration, runtime, fetcher, lost, log, reports, at: (value: number) => { monotonic = value; } };
  }

  it("times a complete heartbeat without adding requests or reporting timers", async () => {
    const f = fixture();
    f.fetcher.mockImplementationOnce(async () => {
      f.at(137);
      return Response.json({ version: 1, audience: "zeros-cloud-workspace-engine-heartbeat-v1", accepted: true,
        engineInstanceId: f.runtime.engine.instanceId, leaseExpiresAtMs: NOW + 120_000 });
    });
    await f.registration.start();
    expect(f.reports()).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.registration.readiness()).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    await f.registration.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.reports()).toEqual([expect.objectContaining({ version: 1, scope: "cloud-runtime-renewal", invalidSpans: 0,
      inFlight: 0, series: [expect.objectContaining({ operation: "engine-heartbeat", outcome: "completed", count: 1, sumMs: 37, maxMs: 37 })] })]);
    await f.registration.stop();
    expect(f.reports()).toHaveLength(1);
  });

  it("keeps concurrent renewal durations separate and excludes initial admission and private values", async () => {
    const f = fixture();
    await f.registration.start();
    f.fetcher.mockResolvedValueOnce(Response.json(actorAdmissionResponse()));
    await expect(f.registration.verifyClientAdmission(`zwa_${"I".repeat(43)}`)).resolves.not.toBeNull();
    const finish: Array<(value: Response) => void> = [];
    f.fetcher.mockImplementation(() => new Promise<Response>(resolve => { finish.push(resolve); }));
    const first = f.registration.verifyClientAdmission(`zwa_${"A".repeat(43)}`, true);
    f.at(150);
    const second = f.registration.verifyClientAdmission(`zwa_${"B".repeat(43)}`, true);
    expect(finish).toHaveLength(2);
    f.at(200); finish[0](Response.json(actorAdmissionResponse())); await first;
    f.at(450); finish[1](Response.json(actorAdmissionResponse())); await second;
    await f.registration.stop();
    const reports = f.reports();
    expect(reports).toEqual([expect.objectContaining({ series: [expect.objectContaining({ operation: "client-renew",
      outcome: "completed", count: 2, sumMs: 400, maxMs: 300 })] })]);
    expect(reports[0].series[0].buckets.reduce((sum: number, count: number) => sum + count, 0)).toBe(2);
    expect(JSON.stringify(reports)).not.toMatch(/zwa_|zwh_|zws_|control\.example|55555555|11111111|22222222|Bearer/);
  });

  it.each(["invalid", "503", "401"])("records %s completion without changing admission authority", async kind => {
    const f = fixture(); await f.registration.start();
    f.fetcher.mockImplementationOnce(async () => {
      f.at(112);
      return kind === "invalid" ? Response.json({ private: "rejected response" }) : new Response("private upstream text", { status: Number(kind) });
    });
    const request = f.registration.verifyClientAdmission(`zwa_${"A".repeat(43)}`, true);
    if (kind === "503") await expect(request).rejects.toMatchObject({ code: "cloud_client_authority_transient" });
    else await expect(request).resolves.toBeNull();
    expect(f.lost).not.toHaveBeenCalled();
    expect(f.registration.readiness()).not.toBeNull();
    await f.registration.stop();
    expect(f.reports()).toEqual([expect.objectContaining({ series: [expect.objectContaining({ operation: "client-renew",
      outcome: kind === "invalid" ? "refused" : "failed", count: 1, sumMs: 12 })] })]);
    expect(JSON.stringify(f.reports())).not.toMatch(/private|upstream|rejected response/);
  });

  it("records a rejected heartbeat before authority retirement", async () => {
    const f = fixture(); await f.registration.start();
    f.fetcher.mockImplementationOnce(async () => { f.at(123); return new Response("private refusal", { status: 401 }); });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.lost).toHaveBeenCalledOnce();
    expect(f.registration.readiness()).toBeNull();
    expect(f.reports()).toEqual([expect.objectContaining({ inFlight: 0, series: [expect.objectContaining({
      operation: "engine-heartbeat", outcome: "failed", count: 1, sumMs: 23 })] })]);
    await f.registration.stop();
    expect(f.reports()).toHaveLength(1);
  });

  it("contains logging failures and flushes only on work or retirement", async () => {
    const f = fixture(); await f.registration.start();
    f.fetcher.mockImplementation(async () => Response.json(actorAdmissionResponse()));
    await expect(f.registration.verifyClientAdmission(`zwa_${"A".repeat(43)}`, true)).resolves.not.toBeNull();
    f.at(60_101);
    f.log.mockImplementation(() => { throw new Error("private logger failure"); });
    await expect(f.registration.verifyClientAdmission(`zwa_${"A".repeat(43)}`, true)).resolves.not.toBeNull();
    expect(f.log).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await expect(f.registration.stop()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.log).toHaveBeenCalledOnce();
  });

  it("reports an unavailable monotonic clock without changing renewal or authority time", async () => {
    const f = fixture(); await f.registration.start();
    f.at(Number.NaN);
    f.fetcher.mockResolvedValueOnce(Response.json(actorAdmissionResponse()));
    await expect(f.registration.verifyClientAdmission(`zwa_${"A".repeat(43)}`, true)).resolves.not.toBeNull();
    f.at(200);
    await f.registration.stop();
    expect(f.reports()).toEqual([expect.objectContaining({ invalidSpans: 1, inFlight: 0, series: [] })]);
  });

  it("retires pending timing with the old registration and ignores its late response", async () => {
    const f = fixture(); await f.registration.start();
    let finish!: (value: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    const pending = f.registration.verifyClientAdmission(`zwa_${"A".repeat(43)}`, true);
    await f.registration.stop();
    expect(f.reports()).toEqual([expect.objectContaining({ inFlight: 1, series: [] })]);
    const stopped = JSON.stringify(f.reports());
    f.at(950); finish(Response.json(actorAdmissionResponse()));
    await expect(pending).resolves.toBeNull();
    expect(JSON.stringify(f.reports())).toBe(stopped);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["actor-confirm", "warm-context"] as const)("times validated %s responses and exact-scope failures", async operation => {
    const f = fixture({ negotiated: true }); await f.registration.start();
    const reference = { organizationId: f.runtime.execution.organizationId, workspaceId: f.runtime.execution.workspaceId,
      generation: f.runtime.execution.generation, engineInstanceId: f.runtime.engine.instanceId,
      bootId: V4_ATTESTATION.bootId, writerEpoch: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    const scope = { ...reference, fundingOwnerUserId: ACCOUNT_USER_ID, fundingOwnerEpoch: 1 };
    const actor = { scope, actorSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", authorityEpoch: 1, confirmedUntilMs: NOW + 10_000,
      fundingConsentVersion: 1 as const, fundingGrant: { kind: "owner" as const }, actor: { userId: ACCOUNT_USER_ID,
        deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", deviceKeyVersion: 1, role: "owner" as const, fingerprint: "a".repeat(64) } };
    const confirm = { ...reference, version: 1 as const, mode: "boot-owner-v1" as const, actorSessionId: actor.actorSessionId };
    const warm = { ...confirm, provider: "claude" as const, model: "synthetic-model", conversationId: "private-conversation",
      cwd: "/srv/zeros/workspace/private-repository", repositoryServers: [] };
    const confirmed = { version: 1, mode: "boot-owner-v1", provenance: actor };
    const context = { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", authorityEpoch: 1,
      contextId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", contextRevision: "b".repeat(64), actor, provider: "claude",
      model: warm.model, conversationId: warm.conversationId, cwd: warm.cwd, gitAuthor: null, customization: null,
      environment: { version: 1, revision: "d".repeat(64), values: {}, history: { owner: "c".repeat(64), currentKeyVersion: 1, keys: { 1: "a".repeat(43) } } },
      nativeCapabilities: { version: 1, goals: false, nativeFork: false, transcriptFork: false, nativeReview: false, connectedApps: false, multiAgent: false } };
    const result = operation === "actor-confirm" ? confirmed : context;
    f.fetcher.mockImplementationOnce(async () => { f.at(130); return Response.json({ result }); });
    await expect(f.registration.agentBootRequest(operation, operation === "actor-confirm" ? confirm : warm, new AbortController().signal)).resolves.toEqual(result);
    f.fetcher.mockImplementationOnce(async () => {
      f.at(145);
      return Response.json({ result: operation === "actor-confirm" ? { ...confirmed, provenance: { ...actor, scope: { ...scope, writerEpoch: V4_ATTESTATION.bootId } } }
        : { ...context, writerEpoch: V4_ATTESTATION.bootId } });
    });
    await expect(f.registration.agentBootRequest(operation, operation === "actor-confirm" ? confirm : warm, new AbortController().signal)).rejects.toThrow();
    await f.registration.stop();
    expect(f.reports()).toEqual([expect.objectContaining({ series: [
      expect.objectContaining({ operation, outcome: "completed", count: 1, sumMs: 30 }),
      expect.objectContaining({ operation, outcome: "failed", count: 1, sumMs: 15 }),
    ] })]);
    expect(JSON.stringify(f.reports())).not.toMatch(/private|synthetic-model|bbbbbbbb|dddddddd|fundingOwner|fingerprint/);
  });
});

describe("cloud runtime registration", () => {
  it.each(["current", "foreign-boot", "late"])("binds %s recovery authority without admitting controls or a local writer", async mode => {
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const target = { organizationId: runtime.execution.organizationId, workspaceId: runtime.execution.workspaceId,
      generation: runtime.execution.generation, engineInstanceId: runtime.engine.instanceId,
      bootId: mode === "foreign-boot" ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : V4_ATTESTATION.bootId,
      fundingOwnerUserId: ACCOUNT_USER_ID, fundingOwnerEpoch: 1 };
    const result = { ...target, version: 1, mode: "boot-owner-v1", recoveryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      code: "history_recovered_with_gap", coverage: "unknown", predecessorRetiredAt: new Date(NOW - 1_000).toISOString(),
      predecessor: { ...target, engineInstanceId: "66666666-6666-4666-8666-666666666666", bootId: "77777777-7777-4777-8777-777777777777",
        writerEpoch: "88888888-8888-4888-8888-888888888888" },
      checkpoint: { writerEpoch: "99999999-9999-4999-8999-999999999999", sha256: "a".repeat(64) }, mirroredSequence: 0 };
    let release!: (value: Response) => void;
    const held = new Promise<Response>(resolve => { release = resolve; });
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(registrationResponse(), { headers: { "x-zeros-cloud-local-commands": "1" } }))
      .mockImplementationOnce(() => mode === "late" ? held : Promise.resolve(Response.json({ result })));
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher,
      now: () => NOW, negotiateLocalCommands: true, onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync() });
    try {
      await registration.start();
      const request = registration.agentBootRequest("recover-history", { version: 1, mode: "boot-owner-v1",
        organizationId: target.organizationId, workspaceId: target.workspaceId, generation: target.generation,
        engineInstanceId: target.engineInstanceId }, new AbortController().signal);
      const settled = request.then(value => ({ value }), error => ({ error }));
      if (mode === "late") { await registration.stop(); release(Response.json({ result })); }
      if (mode === "current") expect(await settled).toEqual({ value: result });
      else expect(await settled).toHaveProperty("error");
      await expect(registration.credentialControlsRequest({ ...target, version: 1, mode: "boot-owner-v1", writerEpoch: result.predecessor.writerEpoch, acknowledgements: [] },
        new AbortController().signal)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { release(Response.json({ result })); await registration.stop(); }
  });
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
      expect(registration.agentBootAuthorityRemainingMs()).toBe(0);
      expect(fetcher.mock.calls[0]![1].headers["x-zeros-cloud-local-commands"]).toBe("1");
      expect(JSON.parse(fetcher.mock.calls[0]![1].body)).not.toHaveProperty("cloudLocalCommandsVersion");
      release(); await starting;
      expect(registration.localCommandsNegotiated()).toBe(acknowledged);
      expect(registration.agentBootAuthorityRemainingMs()).toBe(acknowledged ? 89_000 : 0);
      await registration.stop();
      expect(registration.localCommandsNegotiated()).toBe(false);
      expect(registration.agentBootAuthorityRemainingMs()).toBe(0);
    } finally { release(); await registration.stop(); }
  });

  it.each([true, false])("offers detached support only after the exact registration ACK (%s)", async accepted => {
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const fetcher = vi.fn().mockResolvedValue(Response.json(registrationResponse(), { headers: {
      "x-zeros-cloud-local-commands": "1", ...(accepted ? { "x-zeros-cloud-accepted-work": "1" } : {}),
    } }));
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher,
      now: () => NOW, negotiateLocalCommands: true, onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync() });
    try {
      await registration.start();
      expect(registration.acceptedWorkNegotiated()).toBe(accepted);
      expect(registration.uplinkFeatures().includes("detached.v1")).toBe(accepted);
      expect(fetcher.mock.calls[0]![1].headers["x-zeros-cloud-accepted-work"]).toBe("1");
      expect(JSON.parse(fetcher.mock.calls[0]![1].body)).not.toHaveProperty("acceptedWorkVersion");
    } finally { await registration.stop(); }
    expect(registration.acceptedWorkNegotiated()).toBe(false);
  });

  it("bounds the boot budget by the existing authority margin and fences handoff without renewing", async () => {
    let now = NOW;
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => now)!;
    const fetcher = vi.fn().mockResolvedValue(Response.json(registrationResponse(), {
      headers: { "x-zeros-cloud-local-commands": "1" },
    }));
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher,
      now: () => now, negotiateLocalCommands: true, onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync() });
    try {
      await registration.start(); now += 10_000;
      expect(registration.agentBootAuthorityRemainingMs()).toBe(79_000);
      await registration.pauseRecordForRuntimeHandoff();
      expect(registration.agentBootAuthorityRemainingMs()).toBe(0);
      registration.resumeRecordAfterRuntimeHandoff();
      expect(registration.agentBootAuthorityRemainingMs()).toBe(79_000);
      now += 79_000;
      expect(registration.agentBootAuthorityRemainingMs()).toBe(0);
      expect(registration.localCommandsNegotiated()).toBe(false);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { await registration.stop(); }
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

  describe("checkpoint hints", () => {
    const hintEndpoint = "https://control.example.test/internal/v1/cloud-workspaces/engine/checkpoint-hint";
    const directive = { id: "55555555-5555-4555-8555-555555555555", reason: "before_stop", deadlineAtMs: NOW + 5 * 60_000 };
    const hint = (pending: boolean) => Response.json({ version: 1, audience: "zeros-cloud-workspace-engine-checkpoint-hint-v1", pending });
    function harness(hints: Array<() => Response | Promise<Response>>, options: { enabled?: boolean; heartbeatDirective?: boolean } = {}) {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, Date.now)!;
      const calls: string[] = [];
      let heartbeatGate: Promise<void> | undefined;
      const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        calls.push(href === hintEndpoint ? "hint" : href === heartbeatEndpoint ? "heartbeat" : "register");
        if (href === registrationEndpoint) return Response.json(registrationResponse());
        if (href === hintEndpoint) {
          const next = hints.shift();
          if (next) return next();
          // Hold like the control plane until the engine aborts it.
          return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        }
        await heartbeatGate;
        return Response.json({ version: 1, audience: "zeros-cloud-workspace-engine-heartbeat-v1", accepted: true,
          engineInstanceId: runtime.engine.instanceId, leaseExpiresAtMs: Date.now() + 90_000,
          ...(options.heartbeatDirective === false ? {} : { checkpointRequest: directive }) });
      });
      const onCheckpointRequested = vi.fn(async () => {});
      const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
        fetch: fetch as unknown as typeof globalThis.fetch, now: Date.now, onAuthorityLost: vi.fn(),
        onDurableRecordSync: completedDurableRecordSync(), onCheckpointRequested,
        ...(options.enabled === false ? {} : { checkpointHints: true as const }) });
      return { registration, fetch, calls, onCheckpointRequested, gate: (value: Promise<void> | undefined) => { heartbeatGate = value; } };
    }

    it("heartbeats at once for a queued checkpoint instead of waiting for the next beat", async () => {
      const t = harness([() => hint(true)]);
      await t.registration.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(t.onCheckpointRequested).toHaveBeenCalledOnce();
      expect(t.calls.slice(0, 3)).toEqual(["register", "hint", "heartbeat"]);
      const body = JSON.parse(String(t.fetch.mock.calls[1]![1]?.body));
      expect(body).toEqual({ workspaceId: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222",
        generation: 3, engineInstanceId: "44444444-4444-4444-8444-444444444444" });
      expect(t.fetch.mock.calls[1]![1]?.headers).toMatchObject({ authorization: `Bearer zwh_${"H".repeat(43)}` });
      await t.registration.stop();
    });

    it("asks for one more beat when the hint arrives during a heartbeat", async () => {
      let release!: () => void, answer!: (response: Response) => void;
      const t = harness([() => new Promise<Response>(resolve => { answer = resolve; })], { heartbeatDirective: false });
      t.gate(new Promise<void>(resolve => { release = resolve; }));
      await t.registration.start();
      // The regular beat is now in flight and held.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(t.calls.filter(call => call === "heartbeat")).toHaveLength(1);
      answer(hint(true));
      await vi.advanceTimersByTimeAsync(10);
      expect(t.calls.filter(call => call === "heartbeat")).toHaveLength(1);
      t.gate(undefined);
      release();
      await vi.advanceTimersByTimeAsync(10);
      expect(t.calls.filter(call => call === "heartbeat")).toHaveLength(2);
      await t.registration.stop();
    });

    it("never treats a hint as a checkpoint directive", async () => {
      const t = harness([() => hint(true)], { heartbeatDirective: false });
      await t.registration.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(t.calls).toContain("heartbeat");
      expect(t.onCheckpointRequested).not.toHaveBeenCalled();
      await t.registration.stop();
    });

    it.each([404, 401, 403])("ends the fast path on %s and keeps the regular heartbeat", async status => {
      const t = harness([() => Response.json({ error: { code: "not_available" } }, { status })]);
      await t.registration.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.calls.filter(call => call === "hint")).toHaveLength(1);
      expect(t.calls.filter(call => call === "heartbeat")).toHaveLength(2);
      await t.registration.stop();
    });

    it.each(["503", "429", "network", "malformed"])("backs off after a %s hint failure without spinning", async kind => {
      const failure = () => kind === "network" ? Promise.reject(new Error("offline"))
        : kind === "malformed" ? Response.json({ version: 1, pending: true })
          : Response.json({ error: {} }, { status: Number(kind) });
      const t = harness([failure, failure, failure, () => hint(false)], { heartbeatDirective: false });
      await t.registration.start();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(t.calls.filter(call => call === "hint")).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(t.calls.filter(call => call === "hint")).toHaveLength(5);
      expect(t.calls.filter(call => call === "heartbeat")).toHaveLength(0);
      await t.registration.stop();
    });

    it("waits again at once after an idle hint and stops waiting on shutdown", async () => {
      const t = harness([() => hint(false), () => hint(false)], { heartbeatDirective: false });
      await t.registration.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(t.calls.filter(call => call === "hint")).toHaveLength(3);
      await t.registration.stop();
      const calls = t.fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(t.fetch.mock.calls.length).toBe(calls);
    });

    it("leaves no retry timer behind when stopped during a held hint", async () => {
      const t = harness([], { heartbeatDirective: false });
      await t.registration.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(t.calls).toEqual(["register", "hint"]);
      await t.registration.stop();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("holds no hint without the explicit opt-in", async () => {
      const t = harness([() => hint(true)], { enabled: false, heartbeatDirective: false });
      await t.registration.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(t.calls).toEqual(["register"]);
      await t.registration.stop();
    });
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

describe("final checkpoint delivery after record handoff", () => {
  it("delivers the next final request after cancellation without reopening record writes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, Date.now)!;
    const first = { id: "55555555-5555-4555-8555-555555555555", reason: "before_stop" as const,
      deadlineAtMs: NOW + 5 * 60_000 };
    const next = { ...first, id: "66666666-6666-4666-8666-666666666666", reason: "before_delete" as const };
    let current = first as typeof first | typeof next;
    const sync = completedDurableRecordSync(), lost = vi.fn(), cancelled: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const route = new URL(String(url)).pathname;
      if (route.endsWith("/register")) return Response.json(registrationResponse());
      if (route.endsWith("/idle-stop")) {
        cancelled.push(JSON.parse(String(init!.body)).request.requestId);
        return Response.json({ cancelled: true });
      }
      if (!route.endsWith("/heartbeat")) throw new Error("Unexpected synthetic route");
      return Response.json({ version: 1, audience: "zeros-cloud-workspace-engine-heartbeat-v1", accepted: true,
        engineInstanceId: runtime.engine.instanceId, leaseExpiresAtMs: Date.now() + 90_000, checkpointRequest: current });
    });
    let release!: () => void;
    const pendingCapture = new Promise<void>(resolve => { release = resolve; });
    const onCheckpointRequested = vi.fn(async (request: { id: string }) => {
      if (request.id !== first.id) return;
      await registration.pauseRecordForRuntimeHandoff();
      await pendingCapture;
      await registration.idleStopRequest({ kind: "cancel", requestId: request.id });
      throw new Error("Synthetic capture superseded after handoff");
    });
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
      fetch: fetcher, now: Date.now, onAuthorityLost: lost, onDurableRecordSync: sync, onCheckpointRequested });
    try {
      await registration.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onCheckpointRequested).toHaveBeenCalledOnce();
      const recordWrites = sync.mock.calls.length;
      current = next;
      await vi.advanceTimersByTimeAsync(30_000);
      // A new authoritative directive cannot overlap the still-running capture.
      expect(onCheckpointRequested).toHaveBeenCalledOnce();
      release(); await vi.advanceTimersByTimeAsync(0);
      expect(cancelled).toEqual([first.id]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onCheckpointRequested).toHaveBeenCalledTimes(2);
      expect(onCheckpointRequested).toHaveBeenLastCalledWith(next, expect.objectContaining({
        engineInstanceId: runtime.engine.instanceId, generation: runtime.execution.generation,
      }));
      expect(sync).toHaveBeenCalledTimes(recordWrites);
      expect(fetcher.mock.calls.filter(([url]) => String(url) === heartbeatEndpoint)).toHaveLength(3);
      expect(registration.hasRuntimeHandoffAuthority()).toBe(true);
      await expect(registration.commandRequest({ kind: "claim", conversationId: "chat", executionId: "execution" }))
        .rejects.toMatchObject({ code: "command_durability_unavailable" });
      expect(lost).not.toHaveBeenCalled();
    } finally {
      release(); await Promise.allSettled(onCheckpointRequested.mock.results.map(result => result.value));
      await registration.stop();
    }
  });
});

describe("failed record handoff retry", () => {
  it("retries a failed final flush explicitly while keeping ordinary record writes parked", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, Date.now)!;
    const sync = completedDurableRecordSync();
    const fetcher = vi.fn<typeof fetch>(async url => new URL(String(url)).pathname.endsWith("/register")
      ? Response.json(registrationResponse()) : Response.json({ version: 1,
        audience: "zeros-cloud-workspace-engine-heartbeat-v1", accepted: true,
        engineInstanceId: runtime.engine.instanceId, leaseExpiresAtMs: Date.now() + 90_000 }));
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
      fetch: fetcher, now: Date.now, onAuthorityLost: vi.fn(), onDurableRecordSync: sync });
    try {
      await registration.start(); sync.mockRejectedValueOnce(new Error("Synthetic handoff flush failure"));
      await expect(registration.pauseRecordForRuntimeHandoff()).rejects.toThrow("Synthetic");
      await expect(registration.pauseRecordForRuntimeHandoff()).rejects.toThrow("record flush failed");
      expect(sync).toHaveBeenCalledTimes(2);
      await registration.pauseRecordForRuntimeHandoff({ retryFailedFlush: true });
      expect(sync).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sync).toHaveBeenCalledTimes(3);
      await expect(registration.commandRequest({ kind: "claim", conversationId: "chat", executionId: "execution" }))
        .rejects.toMatchObject({ code: "command_durability_unavailable" });
    } finally { await registration.stop(); }
  });
});


it.each(["manual", "before_fork"] as const)("keeps %s outside final-only control during record handoff", async reason => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, Date.now)!;
  const onCheckpointRequested = vi.fn(async () => {}), sync = completedDurableRecordSync();
  const fetcher = vi.fn<typeof fetch>(async url => new URL(String(url)).pathname.endsWith("/register")
    ? Response.json(registrationResponse()) : Response.json({ version: 1,
      audience: "zeros-cloud-workspace-engine-heartbeat-v1", accepted: true,
      engineInstanceId: runtime.engine.instanceId, leaseExpiresAtMs: Date.now() + 90_000,
      checkpointRequest: { id: "55555555-5555-4555-8555-555555555555", reason, deadlineAtMs: NOW + 300_000 } }));
  const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
    fetch: fetcher, now: Date.now, onAuthorityLost: vi.fn(), onDurableRecordSync: sync, onCheckpointRequested });
  try {
    await registration.start(); await registration.pauseRecordForRuntimeHandoff();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onCheckpointRequested).not.toHaveBeenCalled(); expect(sync).toHaveBeenCalledTimes(2);
  } finally { await registration.stop(); }
});

describe("engine uplink advertisement", () => {
  const advertised = { uplink: { endpoint: "wss://realtime.example.test/v1/uplink" } };

  function fixture(responseOverrides: Record<string, unknown> = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const response = { ...registrationResponse(), ...responseOverrides };
    const fetcher = vi.fn<typeof fetch>(async url => new URL(String(url)).pathname.endsWith("/register")
      ? Response.json(response)
      : Response.json({ version: 1, audience: "zeros-cloud-workspace-engine-heartbeat-v1", accepted: true,
          engineInstanceId: runtime.engine.instanceId, leaseExpiresAtMs: NOW + 90_000 }));
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher,
      now: () => NOW, onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync() });
    return { registration, fetcher, runtime };
  }

  it("opts in with the uplink header on the registration POST", async () => {
    const f = fixture();
    await f.registration.start();
    expect(f.fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-zeros-cloud-engine-uplink": "1" });
    await f.registration.stop();
  });

  it("exposes the advertised endpoint with the heartbeat credential until stop", async () => {
    const f = fixture(advertised);
    await f.registration.start();
    expect(f.registration.engineUplink()).toEqual({
      endpoint: "wss://realtime.example.test/v1/uplink", token: `zwh_${"H".repeat(43)}`,
      controlPlaneOrigin: new URL(registrationResponse().heartbeat.endpoint).origin,
    });
    await f.registration.stop();
    expect(f.registration.engineUplink()).toBeNull();
  });

  it("keeps working without the advertisement (older control plane or flag off)", async () => {
    const f = fixture();
    await f.registration.start();
    expect(f.registration.engineUplink()).toBeNull();
    expect(f.registration.readiness()).not.toBeNull();
    await f.registration.stop();
  });

  it.each([
    ["an https endpoint", { uplink: { endpoint: "https://realtime.example.test/v1/uplink" } }],
    ["a credential-bearing endpoint", { uplink: { endpoint: "wss://u:p@realtime.example.test/v1/uplink" } }],
    ["an endpoint with a query", { uplink: { endpoint: "wss://realtime.example.test/v1/uplink?x=1" } }],
    ["extra uplink keys", { uplink: { endpoint: "wss://realtime.example.test/v1/uplink", token: "x" } }],
    ["an unknown top-level member", { ...advertised, surprise: true }],
  ])("rejects the registration document with %s", async (_label, overrides) => {
    const f = fixture(overrides);
    await expect(f.registration.start()).rejects.toThrow("registration");
    await f.registration.stop();
  });

  it("requestHeartbeatSoon schedules an immediate beat on the heartbeat endpoint", async () => {
    const f = fixture(advertised);
    await f.registration.start();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.registration.requestHeartbeatSoon();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(String(f.fetcher.mock.calls[1]?.[0])).toBe(heartbeatEndpoint);
    await f.registration.stop();
  });

  it("requests an engine capability by REST with the heartbeat credential and the registered boot id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const token = `${"a".repeat(20)}.${"b".repeat(40)}.${"c".repeat(43)}`;
    let answer: unknown = { capability: { token, expiresAt: new Date(NOW + 300_000).toISOString() } };
    const fetcher = vi.fn<typeof fetch>(async url => {
      const route = new URL(String(url)).pathname;
      if (route.endsWith("/register")) return Response.json({ ...registrationResponse(), ...advertised });
      if (route === "/internal/v2/cloud-workspaces/engine/capability") return Response.json(answer, { status: 201 });
      return Response.json({ version: 1, audience: "zeros-cloud-workspace-engine-heartbeat-v1", accepted: true,
        engineInstanceId: runtime.engine.instanceId, leaseExpiresAtMs: NOW + 90_000 });
    });
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher,
      now: () => NOW, onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync() });
    try {
      await registration.start();
      expect(await registration.requestEngineCapability()).toEqual({ token, expiresAtMs: NOW + 300_000 });
      const call = fetcher.mock.calls.find(([url]) => new URL(String(url)).pathname.endsWith("/engine/capability"))!;
      expect(new URL(String(call[0])).origin).toBe(new URL(heartbeatEndpoint).origin);
      expect(call[1]?.headers).toMatchObject({ authorization: `Bearer zwh_${"H".repeat(43)}`, "content-type": "application/json" });
      expect(JSON.parse(String(call[1]?.body))).toEqual({
        workspaceId: runtime.execution.workspaceId, organizationId: runtime.execution.organizationId,
        generation: runtime.execution.generation, engineInstanceId: runtime.engine.instanceId, bootId: registration.runtimeBootId,
      });
      for (const invalid of [{ capability: { token } }, { capability: { token: "x", expiresAt: new Date(NOW).toISOString() } },
        { capability: { token, expiresAt: "soon" } }, { capability: { token, expiresAt: new Date(NOW).toISOString() }, extra: 1 }]) {
        answer = invalid;
        await expect(registration.requestEngineCapability()).rejects.toThrow();
      }
    } finally { await registration.stop(); }
    await expect(registration.requestEngineCapability()).rejects.toThrow();
  });

  it("asks the control plane to admit a verified capability's actor through the heartbeat authority", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => NOW)!;
    const renewalToken = `zwa_${"R".repeat(43)}`;
    const admitted = { ...actorAdmissionResponse(4), renewalToken };
    let answer: () => Response = () => Response.json(admitted);
    const fetcher = vi.fn<typeof fetch>(async url => {
      const route = new URL(String(url)).pathname;
      if (route.endsWith("/register")) return Response.json({ ...registrationResponse(), ...advertised });
      if (route === "/internal/v2/cloud-workspaces/engine/capability-admission") return answer();
      return Response.json({ version: 1, audience: "zeros-cloud-workspace-engine-heartbeat-v1", accepted: true,
        engineInstanceId: runtime.engine.instanceId, leaseExpiresAtMs: NOW + 90_000 });
    });
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher,
      now: () => NOW, onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync() });
    const client = { capability: `${"a".repeat(20)}.${"b".repeat(40)}.${"c".repeat(43)}`,
      proof: { timestampMs: NOW, nonce: "N".repeat(22), signature: "S".repeat(86) } };
    const transient = () => expect(registration.admitCapabilityClient(client, "direct")).rejects.toBeInstanceOf(CloudClientAuthorityTransientError);
    await transient();
    expect(fetcher).not.toHaveBeenCalled();
    try {
      await registration.start();
      expect(await registration.admitCapabilityClient(client, "direct")).toEqual({
        admission: { accountUserId: ACCOUNT_USER_ID, authorityEpoch: 4, actor: { sessionId: admitted.actorSessionId,
          deviceId: admitted.deviceId, role: "developer", fingerprint: admitted.fingerprint } },
        renewalToken,
      });
      const calls = () => fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith("/engine/capability-admission"));
      const [call] = calls();
      expect(new URL(String(call![0])).origin).toBe(new URL(heartbeatEndpoint).origin);
      expect(call![1]?.headers).toMatchObject({ authorization: `Bearer zwh_${"H".repeat(43)}`, "content-type": "application/json" });
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        workspaceId: runtime.execution.workspaceId, organizationId: runtime.execution.organizationId,
        generation: runtime.execution.generation, engineInstanceId: runtime.engine.instanceId,
        capability: client.capability, proof: client.proof, route: "direct",
      });
      // The control plane's refusals.
      for (const status of [401, 403, 404, 422]) {
        answer = () => Response.json({ error: { code: "cloud_actor_admission_rejected" } }, { status });
        expect(await registration.admitCapabilityClient(client, "relay")).toBeNull();
      }
      expect(JSON.parse(String(calls().at(-1)![1]?.body))).toMatchObject({ route: "relay" });
      for (const invalid of [actorAdmissionResponse(4), { ...admitted, renewalToken: "zwa_short" }, { ...admitted, extra: 1 }]) {
        answer = () => Response.json(invalid);
        expect(await registration.admitCapabilityClient(client, "direct")).toBeNull();
      }
      // Not answered yet: the client retries.
      for (const next of [408, 429, 500, 503].map(status => () => Response.json({ error: { code: "later" } }, { status })))  {
        answer = next;
        await transient();
      }
      answer = () => new Response("<html>", { headers: { "content-type": "text/html" } });
      await transient();
      answer = () => { throw new TypeError("network"); };
      await transient();
      let stopping: Promise<void> | undefined;
      answer = () => { stopping = registration.stop(); return Response.json(admitted); };
      await transient();
      await stopping;
    } finally { await registration.stop(); }
    answer = () => Response.json(admitted);
    await transient();
  });});

describe("engine lease over the uplink (lease.v1)", () => {
  const LEASE = 36 * 60_000;
  const hintEndpoint = "https://control.example.test/internal/v1/cloud-workspaces/engine/checkpoint-hint";
  const refresh = { version: 1 as const, audience: "zeros-cloud-github-refresh-v1" as const, generation: "G".repeat(24),
    requestedAt: NOW, ownerSubjectSha256: "d".repeat(64), method: "github-app" as const, reason: "credential-invalid" as const };
  type Ports = { port: number; protocol: "tcp" }[];

  /** A cloud engine whose uplink renews its lease. The heartbeat answers like
   * the control plane, `greatest(lease, clock + 90 s)`; the hint wait answers
   * idle once and then holds, unless told otherwise. */
  function harness(options: { hints?: "healthy" | "absent" | "failing" | "unanswered"; push?: boolean } = {}) {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, Date.now)!;
    const beats: Array<{ at: number; body: Record<string, unknown> }> = [];
    let uplinkLease = 0;
    let answer: (now: number) => number = now => Math.max(uplinkLease, now + 90_000);
    let failStatus: number | null = null;
    let hintCalls = 0;
    const hintAnswers: boolean[] = (options.hints ?? "healthy") === "healthy" ? [false] : [];
    let directive: Record<string, unknown> | null = null;
    let heartbeatHold: Promise<void> | undefined;
    let portHold: Promise<Ports> | undefined;
    const checkpoints: unknown[] = [];
    const held = (init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === registrationEndpoint)
        return Response.json(registrationResponse(), { headers: { "x-zeros-cloud-local-commands": "1" } });
      if (href === hintEndpoint) {
        hintCalls += 1;
        if (options.hints === "absent") return Response.json({ error: { code: "not_found" } }, { status: 404 });
        if (options.hints === "failing") return Response.json({ error: { code: "unavailable" } }, { status: 503 });
        const pending = hintAnswers.shift();
        if (pending === undefined) return held(init);
        return Response.json({ version: 1, audience: "zeros-cloud-workspace-engine-checkpoint-hint-v1", pending });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      beats.push({ at: Date.now(), body });
      await heartbeatHold;
      if (failStatus !== null) return Response.json({ error: { code: "engine_heartbeat_unavailable" } }, { status: failStatus });
      return Response.json({ version: 1, audience: "zeros-cloud-workspace-engine-heartbeat-v1", accepted: true,
        engineInstanceId: runtime.engine.instanceId, leaseExpiresAtMs: answer(Date.now()),
        ...(directive ? { checkpointRequest: directive } : {}),
        ...(body.repositoryCredentialRefresh
          ? { repositoryCredential: { requestGeneration: refresh.generation, outcome: "unavailable" } } : {}) });
    });
    let active = true;
    let push = options.push === true;
    let ports: Ports = [{ port: 3_000, protocol: "tcp" }];
    let pendingRefresh: typeof refresh | null = null;
    const sync = completedDurableRecordSync();
    const lost = vi.fn();
    const readPorts = vi.fn(async () => portHold ?? ports);
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION,
      fetch: fetch as unknown as typeof globalThis.fetch, now: Date.now, negotiateLocalCommands: true,
      checkpointHints: true, onAuthorityLost: lost, onDurableRecordSync: sync,
      onCheckpointRequested: async value => { checkpoints.push(value); },
      readObservedPorts: readPorts, readRepositoryCredentialRefresh: () => pendingRefresh });
    registration.attachUplinkLease(() => active);
    registration.attachUplinkCheckpointPush(() => push);
    return {
      registration, beats, sync, lost, checkpoints, readPorts,
      hintCalls: () => hintCalls,
      /** The uplink's checkpoint push started or ended; without `notify` the
       * change report was missed. */
      setPush: (value: boolean, notify = true) => {
        push = value;
        if (notify) registration.uplinkCheckpointPushChanged();
      },
      /** The next hint wait answers instead of holding. */
      queueHint: (pending: boolean) => { hintAnswers.push(pending); },
      /** The uplink renewed the lease now and reported it (pong). */
      renew: () => { const at = Date.now(); uplinkLease = at + LEASE; registration.adoptUplinkLease(uplinkLease, at); },
      remaining: () => registration.agentBootAuthorityRemainingMs() + 1_000,
      setActive: (value: boolean) => { active = value; },
      setPorts: (value: Ports) => { ports = value; },
      holdPorts: (value: Promise<Ports> | undefined) => { portHold = value; },
      holdHeartbeat: (value: Promise<void> | undefined) => { heartbeatHold = value; },
      setRefresh: (value: typeof refresh | null) => { pendingRefresh = value; },
      failWith: (status: number | null) => { failStatus = status; },
      answerWith: (value: (now: number) => number) => { answer = value; },
      /** The checkpoint request each beat delivers until it completes (null). */
      setDirective: (value: Record<string, unknown> | null) => { directive = value; },
    };
  }
  type Harness = ReturnType<typeof harness>;

  async function started(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
    const h = harness(options);
    await h.registration.start();
    await vi.advanceTimersByTimeAsync(0); // the hint wait answers (or not) before the first tick
    h.renew();
    return h;
  }

  it("skips a periodic beat that would carry nothing while the uplink renews the lease, and still syncs the record", async () => {
    const h = await started();
    try {
      expect(h.remaining()).toBe(LEASE);
      await vi.advanceTimersByTimeAsync(30_000);
      // The first beat reports the observed ports; the control plane keeps the longer lease.
      expect(h.beats).toHaveLength(1);
      expect(h.beats[0]!.body).toMatchObject({ observedPorts: [{ port: 3_000, protocol: "tcp" }] });
      expect(h.remaining()).toBe(LEASE - 30_000);
      await vi.advanceTimersByTimeAsync(5 * 30_000);
      expect(h.beats).toHaveLength(1);
      // A skipped tick still synchronizes the durable record on the beat's cadence.
      expect(h.sync).toHaveBeenCalledTimes(1 + 6);
      expect(h.sync.mock.calls.slice(1).every(([, context]) => context.initial === false)).toBe(true);
      expect(h.lost).not.toHaveBeenCalled();
    } finally { await h.registration.stop(); }
  });

  it.each([
    ["the uplink stops renewing", (h: Harness) => h.setActive(false), 3],
    ["a repository credential refresh is pending", (h: Harness) => h.setRefresh(refresh), 3],
    ["the observed ports changed", (h: Harness) => h.setPorts([{ port: 3_000, protocol: "tcp" }, { port: 8_080, protocol: "tcp" }]), 2],
  ] as const)("beats on the next tick when %s", async (_label, change, afterTwoTicks) => {
    const h = await started();
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.beats).toHaveLength(1);
      change(h);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.beats).toHaveLength(2);
      // A changed listener set is reported once; the other conditions persist.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.beats).toHaveLength(afterTwoTicks);
      expect(h.lost).not.toHaveBeenCalled();
    } finally { await h.registration.stop(); }
  });

  it.each(["absent", "failing", "unanswered"] as const)("keeps every periodic beat while the checkpoint hint wait is %s", async hints => {
    const h = await started({ hints });
    try {
      await vi.advanceTimersByTimeAsync(3 * 30_000);
      expect(h.beats).toHaveLength(3);
    } finally { await h.registration.stop(); }
  });

  it("returns to the HTTP heartbeat once 25 minutes or less of an unrenewed lease remain", async () => {
    const h = await started();
    try {
      await vi.advanceTimersByTimeAsync(630_000);
      expect(h.beats).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(30_000); // 25 minutes left
      expect(h.beats).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.beats).toHaveLength(3);
      // A renewal reported over the uplink restores the skip.
      h.renew();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.beats).toHaveLength(3);
    } finally { await h.registration.stop(); }
  });

  it("posts a forced beat at once even while the uplink renews the lease", async () => {
    const h = await started();
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.beats).toHaveLength(1);
      h.registration.requestHeartbeatSoon();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.beats).toHaveLength(2);
    } finally { await h.registration.stop(); }
  });

  it("keeps every periodic beat while the control plane redelivers a checkpoint request", async () => {
    const h = await started();
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.beats).toHaveLength(1);
      h.setDirective({ id: "66666666-6666-4666-8666-666666666666", reason: "manual", deadlineAtMs: NOW + 10 * 60_000 });
      h.registration.requestHeartbeatSoon(); // the hint wait reported a queued request
      await vi.advanceTimersByTimeAsync(0);
      expect(h.beats).toHaveLength(2);
      expect(h.checkpoints).toHaveLength(1);
      // An incomplete request is redelivered on every beat, so the beat is
      // not empty: one that waited behind another capture is fetched here.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.beats).toHaveLength(3);
      h.setDirective(null); // completed
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.beats).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.beats).toHaveLength(4);
      expect(h.lost).not.toHaveBeenCalled();
    } finally { await h.registration.stop(); }
  });

  it.each([[LEASE + 60_000, true], [LEASE + 60_001, false]] as const)(
    "accepts a heartbeat lease up to the uplink lease plus a minute, stored no later than the request plus the uplink lease (%s ms)",
    async (ahead, accepted) => {
      const h = harness();
      h.answerWith(now => now + ahead);
      try {
        await h.registration.start();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(h.beats).toHaveLength(1);
        if (accepted) {
          expect(h.lost).not.toHaveBeenCalled();
          expect(h.remaining()).toBe(LEASE);
        } else {
          expect(h.lost).toHaveBeenCalledOnce();
        }
      } finally { await h.registration.stop(); }
    });

  it("backs off failed beats while a long lease remains and retries every 5 s in its last two minutes", async () => {
    const h = await started();
    try {
      h.setActive(false); // the uplink is gone, so every periodic beat posts
      h.failWith(503);
      await vi.advanceTimersByTimeAsync(225_000);
      expect(h.beats.map(beat => beat.at - NOW)).toEqual([30_000, 35_000, 45_000, 65_000, 105_000, 165_000, 225_000]);
      await vi.advanceTimersByTimeAsync(LEASE);
      const at = h.beats.map(beat => beat.at - NOW);
      // A minute apart until the last two minutes, then every 5 s until one
      // second before the lease ends, when authority is retired.
      expect(at.filter(value => value > 225_000 && value <= 2_085_000).every((value, index, all) =>
        (index === 0 ? value - 225_000 : value - all[index - 1]!) === 60_000)).toBe(true);
      expect(at.slice(-4)).toEqual([2_145_000, 2_150_000, 2_155_000, LEASE - 1_000]);
      expect(at.filter(value => value > 2_085_000)).toHaveLength(15);
      expect(h.lost).toHaveBeenCalledOnce();
    } finally { await h.registration.stop(); }
  });

  it("keeps the 5 s retry for a 90-second HTTP lease and retires authority one second before it ends", async () => {
    const h = harness();
    try {
      await h.registration.start();
      h.failWith(503);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(h.beats.map(beat => beat.at - NOW)).toEqual([30_000, 35_000, 40_000, 45_000, 50_000, 55_000, 60_000,
        65_000, 70_000, 75_000, 80_000, 85_000, 89_000]);
      expect(h.lost).toHaveBeenCalledOnce();
    } finally { await h.registration.stop(); }
  });

  it("adopts an uplink lease only upward and never past the request time plus the uplink lease", async () => {
    let now = NOW;
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => now)!;
    const fetcher = vi.fn().mockResolvedValue(Response.json(registrationResponse(), {
      headers: { "x-zeros-cloud-local-commands": "1" },
    }));
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher,
      now: () => now, negotiateLocalCommands: true, onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync() });
    const remaining = () => registration.agentBootAuthorityRemainingMs() + 1_000;
    registration.adoptUplinkLease(NOW + LEASE, NOW); // nothing to raise before registration
    try {
      await registration.start();
      expect(remaining()).toBe(90_000);
      registration.adoptUplinkLease(NOW + LEASE + 10 * 60_000, NOW); // a skewed report
      expect(remaining()).toBe(LEASE);
      registration.adoptUplinkLease(NOW + 60_000, NOW); // never lowers
      expect(remaining()).toBe(LEASE);
      now += 5 * 60_000;
      registration.adoptUplinkLease(now + LEASE, now - 1_000); // a pong answering a ping sent a second ago
      expect(remaining()).toBe(LEASE - 1_000);
      for (const [lease, sentAt] of [[Number.NaN, now], [now + LEASE + 0.5, now], [now + LEASE, now + 1], [now + LEASE, Number.NaN]])
        registration.adoptUplinkLease(lease!, sentAt!); // malformed, or a request from the future
      expect(remaining()).toBe(LEASE - 1_000);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { await registration.stop(); }
    registration.adoptUplinkLease(now + LEASE, now);
    expect(registration.agentBootAuthorityRemainingMs()).toBe(0);
  });

  it("never revives a lapsed lease from an uplink report", async () => {
    let now = NOW;
    const runtime = consumeCloudRuntimeEnvironment({ [CLOUD_RUNTIME_ENV]: encodedRuntime() }, () => now)!;
    const fetcher = vi.fn().mockResolvedValue(Response.json(registrationResponse(), {
      headers: { "x-zeros-cloud-local-commands": "1" },
    }));
    const registration = new CloudRuntimeRegistration(runtime, { agentRuntime: V4_ATTESTATION, fetch: fetcher,
      now: () => now, negotiateLocalCommands: true, onAuthorityLost: vi.fn(), onDurableRecordSync: completedDurableRecordSync() });
    try {
      await registration.start();
      now = NOW + 90_000; // the 90-second lease ends; no beat ran
      registration.adoptUplinkLease(now + LEASE, now);
      expect(registration.agentBootAuthorityRemainingMs()).toBe(0);
    } finally { await registration.stop(); }
  });

  it("retries a failed forced beat until one is accepted, even while the uplink renews the lease", async () => {
    const h = await started();
    const at = () => h.beats.map(beat => beat.at - NOW);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(at()).toEqual([30_000]);
      h.failWith(503);
      h.registration.requestHeartbeatSoon();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(at()).toEqual([30_000, 60_000, 65_000, 75_000]);
      h.failWith(null);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(at()).toEqual([30_000, 60_000, 65_000, 75_000, 95_000]);
      // An accepted beat ends the failure series: the next one backs off from 5 s.
      h.failWith(503);
      h.registration.requestHeartbeatSoon();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(at().slice(5)).toEqual([95_000, 100_000]);
      h.failWith(null);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(at().slice(5)).toEqual([95_000, 100_000, 110_000]);
      // Periodic beats that carry nothing are skipped again.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.beats).toHaveLength(8);
      expect(h.lost).not.toHaveBeenCalled();
    } finally { await h.registration.stop(); }
  });

  describe("checkpoint requests pushed over the uplink (checkpoint.v1)", () => {
    const queued = { id: "77777777-7777-4777-8777-777777777777", reason: "manual", deadlineAtMs: NOW + 10 * 60_000 };

    it("sends no checkpoint hint wait while the uplink pushes requests, and re-checks every 30 s", async () => {
      const h = await started({ push: true, hints: "unanswered" });
      try {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(h.hintCalls()).toBe(0);
        expect(h.beats.map(beat => beat.at - NOW)).toEqual([30_000, 90_000, 150_000, 210_000, 270_000]);
        h.setPush(false, false); // the change report was missed
        await vi.advanceTimersByTimeAsync(29_000);
        expect(h.hintCalls()).toBe(0);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(h.hintCalls()).toBe(1);
      } finally { await h.registration.stop(); }
    });

    it("resumes the hint wait at once when the push ends, so its first read sees a request queued meanwhile", async () => {
      const h = await started({ push: true, hints: "unanswered" });
      try {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.hintCalls()).toBe(0);
        h.setDirective(queued);
        h.queueHint(true);
        h.setPush(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.hintCalls()).toBe(1);
        expect(h.beats).toHaveLength(2);
        expect(h.checkpoints).toEqual([expect.objectContaining({ id: queued.id })]);
      } finally { await h.registration.stop(); }
    });

    it("re-checks at once when another uplink attaches", async () => {
      const h = await started({ push: true, hints: "unanswered" });
      try {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.hintCalls()).toBe(0);
        h.registration.attachUplinkCheckpointPush(() => false);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.hintCalls()).toBe(1);
      } finally { await h.registration.stop(); }
    });

    it("restarts the hint backoff once the push ends", async () => {
      const h = await started({ hints: "failing" });
      try {
        await vi.advanceTimersByTimeAsync(40_000); // failed waits back off to 30 s
        h.setPush(true);
        await vi.advanceTimersByTimeAsync(60_000); // the current backoff ends, then the wait pauses
        const paused = h.hintCalls();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.hintCalls()).toBe(paused);
        h.setPush(false);
        await vi.advanceTimersByTimeAsync(1_000);
        // A fresh series: the first failure retries after 1 s, not 30 s.
        expect(h.hintCalls()).toBe(paused + 2);
      } finally { await h.registration.stop(); }
    });

    it("posts a beat at once for a pushed request; the beat fetches it", async () => {
      const h = await started({ push: true });
      try {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.beats).toHaveLength(1);
        h.setDirective(queued);
        h.registration.checkpointRequested();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.beats).toHaveLength(2);
        expect(h.checkpoints).toEqual([expect.objectContaining({ id: queued.id })]);
        expect(h.hintCalls()).toBe(0);
      } finally { await h.registration.stop(); }
    });

    it.each(["absent", "failing", "unanswered"] as const)(
      "bounds skipped periodic beats while the uplink pushes requests and the hint wait is %s",
      async hints => {
        const h = await started({ hints });
        try {
          await vi.advanceTimersByTimeAsync(3 * 30_000);
          expect(h.beats).toHaveLength(3);
          h.setPush(true);
          const hintCalls = h.hintCalls();
          await vi.advanceTimersByTimeAsync(3 * 30_000);
          expect(h.beats).toHaveLength(4);
          expect(h.hintCalls()).toBe(hintCalls);
          h.setPush(false);
          await vi.advanceTimersByTimeAsync(3 * 30_000);
          expect(h.beats).toHaveLength(7);
          expect(h.lost).not.toHaveBeenCalled();
        } finally { await h.registration.stop(); }
      });

    it("fetches before_stop within 76 seconds when push stays open but delivers nothing", async () => {
      const h = await started({ push: true, hints: "unanswered" });
      try {
        await vi.advanceTimersByTimeAsync(31_000);
        const requestedAt = Date.now();
        h.setDirective({ ...queued, reason: "before_stop", deadlineAtMs: requestedAt + 300_000 });
        await vi.advanceTimersByTimeAsync(76_000);
        expect(h.checkpoints).toEqual([expect.objectContaining({ id: queued.id, reason: "before_stop" })]);
        expect(h.beats[1]!.at - requestedAt).toBeLessThanOrEqual(76_000);
        expect(h.hintCalls()).toBe(0);
        expect(h.remaining()).toBeGreaterThan(25 * 60_000);
      } finally { await h.registration.stop(); }
    });

    it("cached pongs and repeated push-active callbacks cannot postpone the API watchdog", async () => {
      const h = await started({ push: true });
      try {
        await vi.advanceTimersByTimeAsync(30_000);
        for (let i = 0; i < 6; i += 1) {
          h.renew();
          h.setPush(true);
          await vi.advanceTimersByTimeAsync(10_000);
        }
        expect(h.beats.map(beat => beat.at - NOW)).toEqual([30_000, 90_000]);
      } finally { await h.registration.stop(); }
    });

    it("a held port scan cannot delay a due checkpoint probe or publish its late result", async () => {
      const h = await started({ push: true });
      let release!: (ports: Ports) => void;
      try {
        await vi.advanceTimersByTimeAsync(31_000);
        h.holdPorts(new Promise(resolve => { release = resolve; }));
        h.setDirective({ ...queued, reason: "before_stop" });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.checkpoints).toHaveLength(1);
        expect(h.beats[1]!.at - NOW).toBeLessThanOrEqual(91_000);
        expect(h.beats[1]!.body).not.toHaveProperty("observedPorts");
        release([{ port: 8_080, protocol: "tcp" }]);
        h.holdPorts(undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.beats).toHaveLength(2);
      } finally { await h.registration.stop(); }
    });

    it("a late response uses request-start freshness", async () => {
      const h = await started({ push: true });
      let release!: () => void;
      try {
        await vi.advanceTimersByTimeAsync(31_000);
        h.holdHeartbeat(new Promise(resolve => { release = resolve; }));
        await vi.advanceTimersByTimeAsync(73_000);
        expect(h.beats).toHaveLength(2);
        h.holdHeartbeat(undefined);
        release();
        await vi.advanceTimersByTimeAsync(46_000);
        expect(h.beats.map(beat => beat.at - NOW)).toEqual([30_000, 90_000, 150_000]);
      } finally { release?.(); await h.registration.stop(); }
    });
    it("keeps optional discovery bounded when the port reader never completes", async () => {
      const h = await started({ push: true });
      try {
        await vi.advanceTimersByTimeAsync(31_000);
        h.holdPorts(new Promise(() => {}));
        await vi.advanceTimersByTimeAsync(180_000);
        expect(h.beats.length).toBeGreaterThanOrEqual(3);
        expect(h.readPorts).toHaveBeenCalledTimes(2); // One completed scan and one still held.
        expect(h.lost).not.toHaveBeenCalled();
      } finally { await h.registration.stop(); }
    });

    it("a scan begun before push activates cannot hold its API fallback", async () => {
      const h = await started({ hints: "unanswered" });
      try {
        h.holdPorts(new Promise(() => {}));
        await vi.advanceTimersByTimeAsync(30_000);
        h.setPush(true);
        h.setDirective({ ...queued, reason: "before_stop" });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(h.checkpoints).toHaveLength(1);
        expect(h.beats).toHaveLength(1);
      } finally { await h.registration.stop(); }
    });

    it("keeps a granted long lease through a 30-minute API and realtime outage", async () => {
      const h = await started({ push: true, hints: "unanswered" });
      try {
        await vi.advanceTimersByTimeAsync(31_000);
        h.failWith(503);
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(h.lost).not.toHaveBeenCalled();
        expect(h.remaining()).toBe(LEASE - 1_831_000);
        expect(h.beats.length).toBeLessThan(40);
        h.failWith(null);
        h.setDirective({ ...queued, reason: "before_stop", deadlineAtMs: Date.now() + 300_000 });
        await vi.advanceTimersByTimeAsync(60_000);
        // Capture has not acknowledged this request, so normal heartbeat
        // redelivery can repeat it after the API recovers.
        expect(h.checkpoints.length).toBeGreaterThan(0);
        for (const checkpoint of h.checkpoints) expect(checkpoint).toMatchObject({ id: queued.id });
      } finally { await h.registration.stop(); }
    });

    it("watchdog failure preserves the long lease and bounded retry backoff without a zero-delay loop", async () => {
      const h = await started({ push: true });
      try {
        await vi.advanceTimersByTimeAsync(31_000);
        h.failWith(503);
        await vi.advanceTimersByTimeAsync(194_000);
        expect(h.beats.map(beat => beat.at - NOW)).toEqual([30_000, 90_000, 95_000, 105_000, 125_000, 165_000, 225_000]);
        expect(h.remaining()).toBe(LEASE - 225_000);
        expect(h.lost).not.toHaveBeenCalled();
      } finally { await h.registration.stop(); }
    });

    it("push during a held watchdog heartbeat produces one follow-up", async () => {
      const h = await started({ push: true });
      let release!: () => void;
      try {
        await vi.advanceTimersByTimeAsync(31_000);
        h.holdHeartbeat(new Promise(resolve => { release = resolve; }));
        await vi.advanceTimersByTimeAsync(59_000);
        h.registration.checkpointRequested();
        h.registration.checkpointRequested();
        h.holdHeartbeat(undefined);
        release();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.beats).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(h.beats).toHaveLength(3);
      } finally { release?.(); await h.registration.stop(); }
    });

    it("stop cancels watchdog work and rejects a stale heartbeat completion", async () => {
      const h = await started({ push: true });
      let release!: () => void;
      try {
        await vi.advanceTimersByTimeAsync(31_000);
        h.holdHeartbeat(new Promise(resolve => { release = resolve; }));
        await vi.advanceTimersByTimeAsync(59_000);
        await h.registration.stop();
        const syncs = h.sync.mock.calls.length;
        h.setDirective({ ...queued, reason: "before_stop" });
        release();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(h.checkpoints).toEqual([]);
        expect(h.sync).toHaveBeenCalledTimes(syncs);
        expect(vi.getTimerCount()).toBe(0);
      } finally { release?.(); await h.registration.stop(); }
    });

    it("watchdog final checkpoint control still runs after record handoff", async () => {
      const h = await started({ push: true });
      try {
        await vi.advanceTimersByTimeAsync(31_000);
        await h.registration.pauseRecordForRuntimeHandoff();
        const syncs = h.sync.mock.calls.length;
        h.setDirective({ ...queued, reason: "before_stop" });
        await vi.advanceTimersByTimeAsync(59_000);
        expect(h.checkpoints).toEqual([expect.objectContaining({ id: queued.id })]);
        expect(h.sync).toHaveBeenCalledTimes(syncs);
      } finally { await h.registration.stop(); }
    });
  });
});
