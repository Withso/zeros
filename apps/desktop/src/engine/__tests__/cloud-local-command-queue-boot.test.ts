import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudLocalAgentBootRuntime } from "../cloud-local-command-queue-boot";
import { testCloudBootFixture } from "../agents/__tests__/helpers/test-cloud-boot";
import { isCloudBootAgentExecutionFactory, isCloudBootAgentSelection, type CloudBootAgentExecutionFactory } from "../agents/cloud-provider-execution";
import type { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import type { CloudRuntimeRegistration } from "../cloud-runtime-registration";
import { CloudAgentAdmissionError, CloudAgentExecutionError, type CloudAgentBootResponses } from "../cloud-agent-execution-client";
import { CloudAgentBootSyncResponseSchema, CloudAgentBootRefreshResponseSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudLocalCommandEventStore } from "../cloud-local-command-queue-events";
import { CloudLocalCommandWriterLifecycle } from "../cloud-local-command-queue-lifecycle";
import { restoreCloudLocalCommandCheckpointLedger } from "../cloud-local-command-queue-checkpoint";
import { openSqlite } from "../db/sqlite";
import ts from "typescript";
import { ZerosEngine } from "../zeros-engine";
import { CloudTransport } from "../transport/cloud";

type Readiness = ReturnType<CloudRuntimeRegistration["readiness"]>;
const engineMethods = ZerosEngine.prototype as unknown as {
  cloudRuntimeReadiness(this: unknown): Readiness;
  verifyCloudActorClient(this: unknown, token: string, renew?: boolean): Promise<unknown>;
  initializeCloudAgentBoot(this: unknown): Promise<void>;
};
/** Exercise the actual transport callback without starting a native engine. */
function internalReadiness(engine: unknown): () => Readiness {
  const source = ts.createSourceFile("zeros-engine.ts", readFileSync(new URL("../zeros-engine.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "internalReadiness" && ts.isObjectLiteralExpression(node.initializer)) {
      const read = node.initializer.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === "read");
      if (read && ts.isPropertyAssignment(read)) expression = read.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!expression) throw new Error("Missing engine-owned readiness callback");
  const output = ts.transpileModule(`return ${expression.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(output).call(engine) as () => Readiness;
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.useRealTimers(); });
async function fixture(provider: "cursor" | "codex" = "cursor") {
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-boot-runtime-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, "workspace"); mkdirSync(cwd);
  const f = await testCloudBootFixture(cwd, provider); cleanups.push(f.close);
  const { fundingOwnerUserId: _funder, fundingOwnerEpoch: _epoch, bootId: _boot, writerEpoch: _writer, ...scope } = f.scope;
  let negotiated = true, live = true, authorityExpiresAt = Date.now() + 90_000;
  const request = vi.fn(async (operation: string, input: unknown, _signal?: AbortSignal): Promise<CloudAgentBootResponses[keyof CloudAgentBootResponses]> => {
    if (operation === "bootstrap" || operation === "sync") return f.response;
    if (operation === "actor-confirm") return { version: 1, mode: "boot-owner-v1", provenance: {
      ...f.provenance, confirmedUntilMs: Date.now() + 8_000 } };
    if (operation === "warm-context") return f.contextRequest(input as Parameters<typeof f.contextRequest>[0]);
    if (operation === "activate") {
      const { providers: _providers, initialAdoptions: _baseline, desiredCacheRevision: _desired, ...identity } = f.response;
      return { ...identity, activated: true };
    }
    throw new Error("Unexpected private request");
  });
  const registration = { localCommandsNegotiated: () => negotiated && Date.now() < authorityExpiresAt,
    agentBootAuthorityRemainingMs: () => negotiated ? Math.max(0, authorityExpiresAt - Date.now()) : 0,
    agentBootRequest: request } as unknown as
    Pick<CloudRuntimeRegistration, "localCommandsNegotiated" | "agentBootAuthorityRemainingMs" | "agentBootRequest" | "credentialControlsRequest">;
  const controls = vi.fn(async (_body: unknown) => ({ version: 1 as const, mode: "boot-owner-v1" as const, controls: [] as unknown[] }));
  registration.credentialControlsRequest = controls as unknown as CloudRuntimeRegistration["credentialControlsRequest"];
  const beforeActivate = vi.fn(async () => {}), install = vi.fn((_factory: CloudBootAgentExecutionFactory, _queue: CloudLocalCommandQueue): void | Promise<void> => {}), changed = vi.fn();
  const startup = vi.fn();
  const options = { file: path.join(directory, "queue.sqlite"), scope, runtimeBootId: f.scope.bootId, registration, observeStartup: startup,
    legacy: f.legacy, supervisor: { onRetirementFailure: vi.fn() }, engineLive: () => live,
    isAdmittedCwd: (cwd: string) => cwd === f.input.cwd, resolveConversation: () => ({ cwd: f.input.cwd, provider: f.input.provider, model: f.input.model }),
    history: () => ({ recordSequence: 1, eventSequence: 1 }), beforeActivate, install, changed };
  const boot = new CloudLocalAgentBootRuntime(options); cleanups.push(() => boot.dispose());
  const admission = { accountUserId: f.provenance.actor.userId, authorityEpoch: f.provenance.authorityEpoch,
    actor: { sessionId: f.provenance.actorSessionId, deviceId: f.provenance.actor.deviceId,
      role: f.provenance.actor.role, fingerprint: f.provenance.actor.fingerprint } };
  return { f, boot, options, admission, request, controls, beforeActivate, install, startup,
    expireAuthorityAt: (at: number) => { authorityExpiresAt = at; },
    unnegotiate: () => { negotiated = false; }, retire: () => { live = false; } };
}

describe("engine boot-mode orchestration", () => {
  it.each(["new", "same"])("activates the fresh engine writer with a %s VM boot after a stop retains its FULL ledger", async vmBoot => {
    const f = await fixture();
    await expect(f.boot.initialize()).resolves.toBe(true);
    const previous = f.boot.scope;
    const file = f.options.file, normal = openSqlite(path.join(path.dirname(file), "normal.sqlite"));
    normal.pragma("journal_mode = WAL"); normal.pragma("synchronous = NORMAL");
    normal.exec("CREATE TABLE sync_meta(id INTEGER PRIMARY KEY,next_rev INTEGER NOT NULL); INSERT INTO sync_meta VALUES(0,2)");
    cleanups.push(() => { normal.close(); });
    const events = new CloudLocalCommandEventStore({ file, queue: f.boot.queue, engineLive: () => true });
    cleanups.push(() => events.close());
    const lifecycle = new CloudLocalCommandWriterLifecycle({ file, queue: f.boot.queue, normalDb: () => normal,
      assertQuiescent: () => {}, heads: (source = normal) => ({ recordSequence: (source.prepare("SELECT next_rev-1 AS rev FROM sync_meta WHERE id=0").get() as { rev: number }).rev,
        eventSequence: events.head }) });
    cleanups.push(() => lifecycle.close());
    await f.boot.quiesceForSeal();
    await lifecycle.drainAndSeal({ mirror: { flush: async () => {} }, retireNative: async () => {}, waitForWork: async () => {},
      freezeNormal: () => normal.close(), request: async seal => { const { scope: _scope, ...body } = seal; return { ...body, writerEpoch: previous.writerEpoch }; } });
    const root = path.join(path.dirname(file), "checkpoint");
    await lifecycle.captureCheckpoint(root);
    events.close(); lifecycle.close();
    await f.boot.dispose();
    const restored = await restoreCloudLocalCommandCheckpointLedger({ root, file, scope: previous, expectedWriterEpoch: previous.writerEpoch });
    cleanups.push(restored.cleanup);
    const successor = { ...previous, engineInstanceId: randomUUID(), bootId: vmBoot === "same" ? previous.bootId : randomUUID(), writerEpoch: randomUUID() };
    Object.assign(f.f.response, successor);
    f.request.mockClear(); f.startup.mockClear(); f.install.mockClear();
    const next = new CloudLocalAgentBootRuntime({ ...f.options,
      scope: { ...f.options.scope, engineInstanceId: successor.engineInstanceId }, runtimeBootId: successor.bootId,
      predecessor: restored.predecessor });
    cleanups.push(() => next.dispose());
    await expect(next.initialize()).resolves.toBe(true);
    expect(next.scope).toEqual(successor);
    expect(next.queue.durability()).toEqual({ journalMode: "wal", synchronous: "full" });
    expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["bootstrap", "activate"]);
    expect(f.install).toHaveBeenCalledOnce();
    expect(f.startup).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "retry" }));
  });

  it.each([100, 5_000])("shares actor confirmation across sockets and a background renewal delayed by %ims without sharing token admission", async delay => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(); await f.boot.initialize(); await f.boot.confirmAdmission(f.admission);
    const actor = f.boot.authorizeActor(f.admission.actor.sessionId, "run");
    const original = f.request.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.request.mockClear().mockImplementation(async (operation, input) => {
      if (operation === "actor-confirm") await held;
      return original(operation, input);
    });
    const verify = vi.fn(async (_token: string, _renew: boolean) => f.admission);
    const engine = { cloudLocalHistoryRestored: true, cloudLocalEvents: {}, cloudRuntimeAuthorityStopping: false,
      cloudRuntimeRegistration: { ...f.options.registration, verifyClientAdmission: verify }, cloudAgentBoot: f.boot };
    await vi.advanceTimersByTimeAsync(4_000);
    const renewals = ["synthetic-device-token-a", "synthetic-device-token-b"].map(token =>
      engineMethods.verifyCloudActorClient.call(engine, token, true));
    try {
      await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(2), { interval: 1 });
      expect(f.request.mock.calls.filter(([operation]) => operation === "actor-confirm")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(delay);
      release();
      await expect(Promise.all(renewals)).resolves.toEqual([f.admission, f.admission]);
      if (delay < 4_000) expect(f.boot.authorizeActor(f.admission.actor.sessionId, "run")).toBe(actor);
      else expect(actor.signal.aborted).toBe(true); // A new proof never revives the expired principal.
      expect(verify.mock.calls.map(call => call[0])).toEqual(["synthetic-device-token-a", "synthetic-device-token-b"]);
    } finally { release(); await Promise.allSettled(renewals); }
  });

  it("rejects every waiter when an actor is revoked during shared confirmation", async () => {
    const f = await fixture(); await f.boot.initialize(); await f.boot.confirmAdmission(f.admission);
    const actor = f.boot.authorizeActor(f.admission.actor.sessionId, "run"), original = f.request.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.request.mockClear().mockImplementation(async (operation, input) => {
      if (operation === "actor-confirm") await held;
      return original(operation, input);
    });
    const results = Promise.allSettled([f.boot.confirmAdmission(f.admission), f.boot.confirmAdmission(f.admission)]);
    try {
      expect(f.request.mock.calls.filter(([operation]) => operation === "actor-confirm")).toHaveLength(1);
      f.boot.revokeActor(f.admission.actor.sessionId); release();
      expect((await results).map(result => result.status)).toEqual(["rejected", "rejected"]);
      expect(actor.signal.aborted).toBe(true);
      expect(() => f.boot.authorizeActor(f.admission.actor.sessionId, "read")).toThrow();
    } finally { release(); await results; }
  });

  it("does not share confirmation success with a different admitted identity", async () => {
    const f = await fixture(); await f.boot.initialize();
    const foreign = { ...f.admission, accountUserId: randomUUID() };
    const results = await Promise.allSettled([f.boot.confirmAdmission(f.admission), f.boot.confirmAdmission(foreign)]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "cloud_actor_authority_rejected" } });
  });

  it.each(["access_denied", "authority_response_invalid"] as const)(
    "does not background-retry an actor confirmation rejected with %s", async category => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const f = await fixture(); await f.boot.initialize(); await f.boot.confirmAdmission(f.admission);
      const original = f.request.getMockImplementation()!;
      f.request.mockClear().mockImplementation(async (operation, input) => {
        if (operation === "actor-confirm") throw new CloudAgentExecutionError(category, "validation");
        return original(operation, input);
      });
      await vi.advanceTimersByTimeAsync(4_750);
      expect(f.request.mock.calls.filter(([operation]) => operation === "actor-confirm")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3_250);
      expect(() => f.boot.authorizeActor(f.admission.actor.sessionId, "read")).toThrow();
    });

  it.each(["authority_transport", "authority_timeout", "authority_http_5xx", "rate_limited"] as const)(
    "preserves a typed transient actor-confirm %s for transport renewal", async category => {
      const f = await fixture(), error = new CloudAgentExecutionError(category, "validation");
      const confirmAdmission = vi.fn(async () => { throw error; });
      const engine = { cloudLocalHistoryRestored: true, cloudLocalEvents: {}, cloudRuntimeAuthorityStopping: false,
        cloudRuntimeRegistration: { localCommandsNegotiated: () => true, verifyClientAdmission: async () => f.admission },
        cloudAgentBoot: { active: true, initialize: async () => true, confirmAdmission } };
      await expect(engineMethods.verifyCloudActorClient.call(engine, "synthetic-token", true))
        .rejects.toMatchObject({ code: "cloud_client_authority_transient" });
      await expect(engineMethods.verifyCloudActorClient.call(engine, "synthetic-token"))
        .rejects.toBe(error);
    });

  it.each(["access_denied", "authority_response_invalid", "lifecycle_superseded", "authority_unavailable"] as const)(
    "keeps actor-confirm %s terminal during renewal", async category => {
      const f = await fixture(), error = new CloudAgentExecutionError(category, "validation");
      const engine = { cloudLocalHistoryRestored: true, cloudLocalEvents: {}, cloudRuntimeAuthorityStopping: false,
        cloudRuntimeRegistration: { localCommandsNegotiated: () => true, verifyClientAdmission: async () => f.admission },
        cloudAgentBoot: { active: true, initialize: async () => true, confirmAdmission: async () => { throw error; } } };
      await expect(engineMethods.verifyCloudActorClient.call(engine, "synthetic-token", true)).rejects.toBe(error);
    });

  it.each(["authority_transport", "authority_timeout", "authority_http_5xx", "rate_limited"] as const)(
    "recovers one transient bootstrap %s in the original startup flight", async category => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const f = await fixture();
      f.request.mockRejectedValueOnce(new CloudAgentExecutionError(category));
      const starting = f.boot.initialize(), outcome = starting.catch(error => error);
      expect(f.boot.initialize()).toBe(starting);
      await vi.advanceTimersByTimeAsync(249);
      expect(f.request).toHaveBeenCalledOnce(); expect(f.install).not.toHaveBeenCalled(); expect(f.boot.active).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toBe(true);
      const bootstrap = f.request.mock.calls.filter(([operation]) => operation === "bootstrap");
      expect(bootstrap).toHaveLength(2); expect(bootstrap[1]![1]).toEqual(bootstrap[0]![1]);
      expect(f.beforeActivate).toHaveBeenCalledOnce(); expect(f.install).toHaveBeenCalledOnce(); expect(f.boot.active).toBe(true);
      expect(f.startup).toHaveBeenCalledWith(expect.objectContaining({ phase: "boot_bootstrap", outcome: "ready" }));
    });
  it("retries an unknown activation ACK without rebuilding the ledger or repeating installation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(), original = f.request.getMockImplementation()!;
    let activations = 0;
    f.request.mockImplementation(async (operation, input) => {
      if (operation === "activate" && ++activations === 1) throw new CloudAgentExecutionError("authority_transport", "validation");
      return original(operation, input);
    });
    const starting = f.boot.initialize().catch(error => error);
    await vi.advanceTimersByTimeAsync(250);
    expect(await starting).toBe(true);
    const activate = f.request.mock.calls.filter(([operation]) => operation === "activate");
    expect(activate).toHaveLength(2); expect(activate[1]![1]).toEqual(activate[0]![1]);
    expect(f.request.mock.calls.filter(([operation]) => operation === "bootstrap")).toHaveLength(1);
    expect(f.beforeActivate).toHaveBeenCalledOnce(); expect(f.install).toHaveBeenCalledOnce();
    expect(f.boot.queue.durability()).toEqual({ journalMode: "wal", synchronous: "full" });
  });
  it("retries only the identical initial credential sync before activating the synchronized revision", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(), original = f.request.getMockImplementation()!;
    let syncs = 0;
    f.request.mockImplementation(async (operation, input) => {
      if (operation === "bootstrap") return { ...f.f.response, desiredCacheRevision: 2,
        providers: f.f.response.providers.map(provider => ({ provider: provider.provider, status: "unavailable" as const,
          code: "cloud_agent_credential_refresh_required" as const })) };
      if (operation === "sync") {
        if (++syncs === 1) throw new CloudAgentExecutionError("authority_http_5xx", "validation");
        return { ...f.f.response, cacheRevision: 2, desiredCacheRevision: 2 };
      }
      const result = await original(operation, input);
      return operation === "activate" ? { ...result, cacheRevision: 2 } : result;
    });
    const starting = f.boot.initialize().catch(error => error);
    await vi.advanceTimersByTimeAsync(250);
    expect(await starting).toBe(true);
    const sync = f.request.mock.calls.filter(([operation]) => operation === "sync");
    expect(sync).toHaveLength(2); expect(sync[1]![1]).toEqual(sync[0]![1]);
    expect(f.request.mock.calls.find(([operation]) => operation === "activate")?.[1]).toMatchObject({ expectedCacheRevision: 2 });
    expect(f.install).toHaveBeenCalledOnce();
  });
  it("caps a transient bootstrap at three attempts and reports only closed stage evidence", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(), error = Object.assign(new CloudAgentExecutionError("authority_http_5xx"), {
      message: "private-body-canary", path: "private-path-canary", response: { body: "private-body-canary" } });
    f.request.mockRejectedValue(error);
    const starting = f.boot.initialize().catch(cause => cause);
    await vi.advanceTimersByTimeAsync(750);
    expect(await starting).toBe(error); expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.request.mock.calls.every(([operation]) => operation === "bootstrap")).toBe(true);
    expect(f.startup.mock.calls.filter(([observation]) => observation.outcome === "retry")).toHaveLength(2);
    expect(f.startup).toHaveBeenLastCalledWith({ phase: "boot_bootstrap", outcome: "failed", elapsedMs: 750,
      failure: { phase: "boot_bootstrap", name: "CloudAgentExecutionError", code: error.code, errno: null } });
    expect(JSON.stringify(f.startup.mock.calls)).not.toContain("canary");
    expect(f.install).not.toHaveBeenCalled(); expect(f.boot.active).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000); expect(f.request).toHaveBeenCalledTimes(3);
  });
  it.each(["bootstrap", "install"] as const)("does not restart failed %s for another readiness/socket waiter", async step => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(), error = new CloudAgentExecutionError("authority_transport");
    if (step === "bootstrap") f.request.mockRejectedValue(error); else f.install.mockRejectedValue(error);
    const starting = f.boot.initialize().catch(cause => cause);
    await vi.advanceTimersByTimeAsync(750); expect(await starting).toBe(error);
    const calls = f.request.mock.calls.length, installs = f.install.mock.calls.length;
    const later = f.boot.initialize().catch(cause => cause);
    await vi.advanceTimersByTimeAsync(750); expect(await later).toBe(error);
    expect(f.request).toHaveBeenCalledTimes(calls); expect(f.install).toHaveBeenCalledTimes(installs);
    expect(f.boot.active).toBe(false);
  });
  it.each([
    ["denial", () => new CloudAgentExecutionError("access_denied")],
    ["invalid response", () => new CloudAgentExecutionError("authority_response_invalid")],
    ["credential integrity", () => new CloudAgentExecutionError("credential_refresh_invalid")],
    ["credential revoke", () => new CloudAgentAdmissionError("cloud_agent_credential_revoked")],
    ["image integrity", () => new CloudAgentExecutionError("attestation_failed")],
    ["identity mismatch", () => new CloudAgentExecutionError("environment_identity_mismatch")],
    ["unclassified authority", () => new CloudAgentExecutionError("authority_unavailable")],
    ["busy credential source", () => new CloudAgentExecutionError("lock_busy")],
    ["billing integrity", () => Object.assign(new Error("private-canary"), { code: "compute_credit_meter_rejected" })],
    ["unknown error", () => new Error("private-canary")],
  ] as const)("never retries %s during boot", async (_name, failure) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(), error = failure(); f.request.mockRejectedValueOnce(error);
    await expect(f.boot.initialize()).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.request).toHaveBeenCalledOnce(); expect(f.install).not.toHaveBeenCalled(); expect(f.boot.active).toBe(false);
  });
  it.each(["beforeActivate", "install"] as const)("does not replay local %s work even when its error is typed transient", async step => {
    const f = await fixture(), error = new CloudAgentExecutionError("authority_transport", "validation");
    f[step].mockRejectedValueOnce(error);
    await expect(f.boot.initialize()).rejects.toBe(error);
    expect(f[step]).toHaveBeenCalledOnce(); expect(f.boot.active).toBe(false);
    expect(f.request.mock.calls.filter(([operation]) => operation === "bootstrap")).toHaveLength(1);
    expect(f.request.mock.calls.filter(([operation]) => operation === "activate")).toHaveLength(step === "install" ? 1 : 0);
    expect(f.startup).toHaveBeenLastCalledWith(expect.objectContaining({ phase: step === "install" ? "boot_install" : "boot_durability",
      outcome: "failed", failure: expect.objectContaining({ code: error.code }) }));
  });
  it.each(["bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch"] as const)(
    "refuses an activation retry that changes %s", async field => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const f = await fixture(), original = f.request.getMockImplementation()!;
      let attempts = 0;
      f.request.mockImplementation(async (operation, input) => {
        if (operation !== "activate") return original(operation, input);
        if (++attempts === 1) throw new CloudAgentExecutionError("authority_transport", "validation");
        return { ...await original(operation, input), [field]: field === "fundingOwnerEpoch" ? 2 : randomUUID() };
      });
      const starting = f.boot.initialize().catch(error => error);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await starting).toMatchObject({ code: "cloud_admission_authority_response_invalid" });
      expect(attempts).toBe(2); expect(f.install).not.toHaveBeenCalled(); expect(f.boot.active).toBe(false);
    });
  it("does not begin a retry that cannot fit its backoff inside confirmed authority", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(), error = new CloudAgentExecutionError("authority_transport");
    f.expireAuthorityAt(Date.now() + 200); f.request.mockRejectedValue(error);
    await expect(f.boot.initialize()).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.request).toHaveBeenCalledOnce(); expect(f.install).not.toHaveBeenCalled();
  });
  it.each(["expiry", "disposal", "revocation"] as const)("rejects a late bootstrap success after %s", async stop => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture();
    let release!: (response: typeof f.f.response) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    if (stop === "expiry") f.expireAuthorityAt(Date.now() + 100);
    const starting = f.boot.initialize().catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    if (stop === "expiry") await vi.advanceTimersByTimeAsync(100);
    else if (stop === "disposal") await f.boot.dispose();
    else f.unnegotiate();
    if (stop !== "revocation") expect(f.request.mock.calls[0]![2]?.aborted).toBe(true);
    release(f.f.response);
    expect(await starting).toMatchObject({ code: "engine_authority_rejected" });
    expect(f.request).toHaveBeenCalledOnce(); expect(f.install).not.toHaveBeenCalled(); expect(f.boot.active).toBe(false);
  });
  it.each(["disposal", "revocation"] as const)("cancels a retry during backoff on %s", async stop => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(); f.request.mockRejectedValueOnce(new CloudAgentExecutionError("authority_transport"));
    const starting = f.boot.initialize().catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    if (stop === "disposal") await f.boot.dispose(); else f.unnegotiate();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await starting).toMatchObject({ code: "engine_authority_rejected" });
    expect(f.request).toHaveBeenCalledOnce(); expect(f.install).not.toHaveBeenCalled();
  });
  it("shares one monotonic boot budget across requests and ignores late ACKs and wall-clock rollback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (operation, input) => {
      await new Promise<void>(resolve => setTimeout(resolve, operation === "bootstrap" ? 9_000 : 10_000));
      if (operation === "activate") throw new CloudAgentExecutionError("authority_timeout", "validation");
      return original(operation, input);
    });
    const starting = f.boot.initialize().catch(error => error);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.request.mock.calls.filter(([operation]) => operation === "activate")).toHaveLength(3);
    // Neither a genuine later authority renewal nor wall-clock rollback can
    // reset this startup's original 30 s monotonic budget.
    f.expireAuthorityAt(Date.now() + 90_000); vi.setSystemTime(Date.now() - 60_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(await starting).toMatchObject({ code: "cloud_validation_authority_timeout" });
    expect(f.request.mock.calls.at(-1)![2]?.aborted).toBe(true);
    expect(f.install).not.toHaveBeenCalled(); expect(f.boot.active).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.request).toHaveBeenCalledTimes(4); expect(f.install).not.toHaveBeenCalled();
    await expect(f.boot.initialize()).rejects.toMatchObject({ code: "cloud_validation_authority_timeout" });
    expect(f.request).toHaveBeenCalledTimes(4);
  });
  it("does not start background credentials or controls while activation is awaiting its ACK", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(), original = f.request.getMockImplementation()!;
    const providers = f.f.response.providers.map(provider => provider.status === "ready"
      ? { ...provider, authorityExpiresAt: new Date(Date.now() + 20_000).toISOString() } : provider);
    let release!: () => void;
    f.request.mockImplementation(async (operation, input) => {
      if (operation === "bootstrap") return { ...f.f.response, providers };
      if (operation === "activate") await new Promise<void>(resolve => { release = resolve; });
      return original(operation, input);
    });
    const starting = f.boot.initialize();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["bootstrap", "activate"]);
    expect(f.controls).not.toHaveBeenCalled(); expect(f.boot.active).toBe(false);
    release(); await starting;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.controls).toHaveBeenCalled();
  });
  it.each(["Local Personal", "organization-local"])("keeps %s off the cloud boot path", async _owner => {
    const registration = { localCommandsNegotiated: vi.fn(() => true) }, restore = vi.fn();
    await engineMethods.initializeCloudAgentBoot.call({ cloudWorker: null, cloudRuntimeRegistration: registration,
      cloudRuntimeConfig: {}, cloudAgentLegacyFactory: {}, restoreCloudLocalHistory: restore });
    expect(registration.localCommandsNegotiated).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled();
  });
  it.each([100, 300])("withholds actual readiness during %ims bootstrap/activation and authenticates after the original flight", async delay => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (operation, input) => {
      await new Promise<void>(resolve => setTimeout(resolve, delay));
      return original(operation, input);
    });
    const ready: NonNullable<Readiness> = { version: 1, instanceId: f.f.scope.engineInstanceId,
      protocolVersion: 4, health: "ready", durableRecordConnected: true };
    const verify = vi.fn(async () => f.admission);
    const engine = { running: true, cloudWorker: { version: 4 }, cloudRuntimeAuthorityStopping: false,
      cloudLocalHistoryRestored: true, cloudLocalEvents: null as object | null,
      cloudRuntimeRegistration: { ...f.options.registration, readiness: () => ready, verifyClientAdmission: verify },
      cloudAgentBoot: f.boot, cloudRuntimeReadiness: engineMethods.cloudRuntimeReadiness };
    f.install.mockImplementation(() => { engine.cloudLocalEvents = {}; });
    const read = internalReadiness(engine), initialization = f.boot.initialize();
    const admission = engineMethods.verifyCloudActorClient.call(engine, "synthetic-connection-token");
    try {
      expect(read()).toBeNull();
      expect(verify).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(delay);
      expect(f.request.mock.calls.some(([operation]) => operation === "activate")).toBe(true);
      expect(read()).toBeNull(); expect(verify).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(delay * 2);
      await expect(initialization).resolves.toBe(true);
      await expect(admission).resolves.toBe(f.admission);
      expect(read()).toEqual(ready); expect(verify).toHaveBeenCalledOnce();
      expect(f.request.mock.calls.filter(([operation]) => operation === "activate")).toHaveLength(1);
      expect(f.request.mock.calls.filter(([operation]) => operation === "actor-confirm")).toHaveLength(1);
      engine.cloudLocalHistoryRestored = false; expect(read()).toBeNull();
      engine.cloudLocalHistoryRestored = true; engine.cloudLocalEvents = null; expect(read()).toBeNull();
      engine.cloudLocalEvents = {};
      await f.boot.quiesceForSeal();
      expect(f.boot.active).toBe(false); expect(f.boot.authorityActive).toBe(true);
      expect(read()).toEqual(ready);
      await f.boot.dispose(); expect(read()).toBeNull();
    } finally {
      await vi.advanceTimersByTimeAsync(delay * 3);
      await Promise.allSettled([initialization, admission]);
    }
  });
  it("waits for activation before acquiring the bounded actor proof", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (operation, input) => {
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      return original(operation, input);
    });
    const verify = vi.fn(async () => f.admission);
    const engine = { running: true, cloudWorker: { version: 4 }, cloudRuntimeAuthorityStopping: false,
      cloudLocalHistoryRestored: true, cloudLocalEvents: null as object | null, cloudAgentBoot: f.boot,
      cloudRuntimeRegistration: { ...f.options.registration, verifyClientAdmission: verify } };
    f.install.mockImplementation(() => { engine.cloudLocalEvents = {}; });
    const initialization = f.boot.initialize(), admission = engineMethods.verifyCloudActorClient.call(engine, "synthetic-connection-token");
    try {
      expect(verify).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      await expect(initialization).resolves.toBe(true);
      await expect(admission).resolves.toBe(f.admission);
      expect(verify).toHaveBeenCalledOnce();
    } finally {
      await vi.advanceTimersByTimeAsync(300);
      await Promise.allSettled([initialization, admission]);
    }
  });
  it("rejects a replaced boot while the original actor confirmation is in flight", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(); await f.boot.initialize();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (operation, input) => {
      if (operation === "actor-confirm") await new Promise<void>(resolve => setTimeout(resolve, 100));
      return original(operation, input);
    });
    const verify = vi.fn(async () => f.admission);
    const engine = { cloudRuntimeAuthorityStopping: false, cloudLocalHistoryRestored: true, cloudLocalEvents: {},
      cloudAgentBoot: f.boot as CloudLocalAgentBootRuntime | null,
      cloudRuntimeRegistration: { ...f.options.registration, verifyClientAdmission: verify } };
    const admission = engineMethods.verifyCloudActorClient.call(engine, "synthetic-connection-token");
    await vi.advanceTimersByTimeAsync(0); expect(verify).toHaveBeenCalledOnce();
    engine.cloudAgentBoot = null;
    await vi.advanceTimersByTimeAsync(100); await expect(admission).resolves.toBeNull();
  });
  it("keeps the authenticated quiet endpoint usable after starts are fenced for sealing", async () => {
    const f = await fixture();
    const ready: NonNullable<Readiness> = { version: 1, instanceId: f.f.scope.engineInstanceId,
      protocolVersion: 4, health: "ready", durableRecordConnected: true };
    const engine = { cloudWorker: { version: 4 }, cloudLocalHistoryRestored: true,
      cloudLocalEvents: null as object | null, cloudAgentBoot: f.boot,
      cloudRuntimeRegistration: { ...f.options.registration, readiness: () => ready },
      cloudRuntimeReadiness: engineMethods.cloudRuntimeReadiness };
    f.install.mockImplementation(() => { engine.cloudLocalEvents = {}; });
    const probeToken = `zwr_${"R".repeat(43)}`, challenge = randomUUID();
    const transport = new CloudTransport({ port: 0, token: "synthetic-cloud-token", internalReadiness: {
      token: probeToken, read: internalReadiness(engine), readQuiet: async nonce => ({ version: 1, challenge: nonce,
        workspaceId: f.f.scope.workspaceId, organizationId: f.f.scope.organizationId, generation: f.f.scope.generation,
        engineInstanceId: f.f.scope.engineInstanceId, activityRevision: 1, quietForMs: 60_000, stable: true,
        recordSync: "ready", workloadBusy: false, livePty: false, userProcesses: "idle", presence: "absent" }) } });
    cleanups.push(() => transport.stop()); await transport.start();
    const url = `http://127.0.0.1:${transport.boundPort}`;
    const headers = { "x-zeros-readiness-token": probeToken, "x-zeros-quiet-challenge": challenge };
    expect((await fetch(`${url}/internal/readiness`, { headers })).status).toBe(503);
    await f.boot.initialize();
    expect((await fetch(`${url}/internal/readiness`, { headers })).status).toBe(200);
    await f.boot.quiesceForSeal(); expect(f.boot.active).toBe(false);
    expect((await fetch(`${url}/internal/runtime-quiet`, { headers })).status).toBe(200);
    await f.boot.dispose();
    expect((await fetch(`${url}/internal/runtime-quiet`, { headers })).status).toBe(503);
  });
  it("retains legacy readiness and admission without negotiating a boot runtime", async () => {
    const ready: NonNullable<Readiness> = { version: 1, instanceId: randomUUID(), protocolVersion: 4,
      health: "ready", durableRecordConnected: true };
    const admission = { accountUserId: randomUUID(), authorityEpoch: 1 };
    const verify = vi.fn(async () => admission), initialize = vi.fn(async () => true);
    const engine = { running: true, cloudWorker: { version: 4 }, cloudRuntimeAuthorityStopping: false,
      cloudRuntimeRegistration: { readiness: () => ready, localCommandsNegotiated: () => false, verifyClientAdmission: verify },
      cloudAgentBoot: { active: false, initialize }, cloudRuntimeReadiness: engineMethods.cloudRuntimeReadiness };
    expect(internalReadiness(engine)()).toEqual(ready);
    await expect(engineMethods.verifyCloudActorClient.call(engine, "synthetic-legacy-token")).resolves.toBe(admission);
    expect(initialize).not.toHaveBeenCalled(); expect(verify).toHaveBeenCalledOnce();
  });
  it("keeps exact final authority usable while an admission barrier refuses new starts", async () => {
    const f = await fixture(); let startsAllowed = true;
    Object.assign(f.options, { startsAllowed: () => startsAllowed });
    await f.boot.initialize(); startsAllowed = false;
    expect(f.boot.active).toBe(false); expect(f.boot.authorityActive).toBe(true);
    expect(() => f.boot.metadata).toThrow("cloud_commands_unavailable");
    await expect(f.boot.quiesceForSeal()).resolves.toBeUndefined();
    expect(f.boot.authorityActive).toBe(true);
  });
  it("fences new starts and independently stops all background publications before final sealing", async () => {
    vi.useFakeTimers(); const f = await fixture(); await f.boot.initialize(); const queue = f.boot.queue;
    await f.boot.quiesceForSeal();
    expect(f.boot.active).toBe(false); expect(f.boot.authorityActive).toBe(true); expect(queue.accepting).toBe(false);
    const requests = f.request.mock.calls.length,controls = f.controls.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.request).toHaveBeenCalledTimes(requests); expect(f.controls).toHaveBeenCalledTimes(controls);
    await f.boot.dispose(); expect(f.boot.authorityActive).toBe(false);
  });
  it("waits for durable replay installation before advertising or polling controls", async () => {
    const f = await fixture(); let release!: () => void;
    const attached = new Promise<void>(resolve => { release = resolve; }); f.install.mockReturnValueOnce(attached);
    const pending = f.boot.initialize(); await vi.waitFor(() => expect(f.install).toHaveBeenCalledOnce());
    expect(f.boot.active).toBe(false); expect(f.controls).not.toHaveBeenCalled();
    release(); await pending; expect(f.boot.active).toBe(true);
  });
  it("keeps control polling independent of a successful scheduled Codex refresh", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture("codex");
    const provider = f.f.response.providers.find(value => value.status === "ready");
    if (!provider || provider.status !== "ready") throw new Error("Missing fixture source");
    const now = Math.floor(Date.now() / 1000) * 1000;
    Object.assign(provider, { kind: "codex-chatgpt", expiresAt: new Date(now + 60_000).toISOString(),
      refreshAfter: new Date(Date.now() + 2_000).toISOString(), material: { kind: "codex-chatgpt", accountId: randomUUID(),
        accessToken: "synthetic-before", expiresAt: (now + 60_000) / 1000 } });
    const refreshed = { ...provider, materialVersion: 2, expiresAt: new Date(now + 3_600_000).toISOString(),
      refreshAfter: new Date(now + 3_000_000).toISOString(), material: { ...provider.material,
        accessToken: "synthetic-codex-after", expiresAt: (now + 3_600_000) / 1000 } };
    const ready = CloudAgentBootSyncResponseSchema.parse({ ...f.f.response, cacheRevision: 2, desiredCacheRevision: 2,
      providers: f.f.response.providers.map(value => value.provider === "codex" ? refreshed : value) });
    const { providers: _providers, initialAdoptions: _baseline, ...identity } = ready;
    const refreshedResponse = CloudAgentBootRefreshResponseSchema.parse({ ...identity, provider: refreshed });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (operation, input) => {
      if (operation !== "refresh") return original(operation, input);
      Object.assign(f.f.response, ready);
      return refreshedResponse;
    });
    await f.boot.initialize(); await vi.advanceTimersByTimeAsync(6_000);
    expect(f.request.mock.calls.filter(([operation]) => operation === "refresh")).toHaveLength(1);
    expect(f.boot.metadata.cacheRevision).toBe(2);
    expect(f.controls.mock.calls.length).toBeGreaterThanOrEqual(10);
    await f.boot.dispose(); const calls = f.controls.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000); expect(f.controls).toHaveBeenCalledTimes(calls);
  });
  it("applies background start controls durably and retries the exact ACK after an unknown response", async () => {
    const f = await fixture(); await f.boot.initialize();
    const control = { ...f.f.scope, version: 1, mutationId: randomUUID(), controlRequestId: randomUUID(), fenceEpoch: 1,
      selectors: [{ provider: "cursor", credentialId: f.f.selection.credentialRun.credentialId }],
      operation: "pause-starts", desiredCacheRevision: null };
    f.controls.mockResolvedValueOnce({ version: 1, mode: "boot-owner-v1", controls: [control] });
    await f.boot.pollCredentialControls();
    expect(f.boot.fences.canStart(f.f.selection.credentialRun)).toBe(false);
    const ack = f.boot.fences.pendingAcknowledgement(); expect(ack).toMatchObject({ phase: "fenced" });
    f.controls.mockRejectedValueOnce(Object.assign(new Error("closed transient"), { code: "credential_control_storage_unavailable" }));
    await expect(f.boot.pollCredentialControls()).rejects.toThrow();
    expect(f.boot.fences.pendingAcknowledgement()).toEqual(ack);
    await f.boot.pollCredentialControls();
    expect(f.controls.mock.calls.at(-1)![0]).toMatchObject({ acknowledgements: [ack] });
    expect(f.boot.fences.pendingAcknowledgement()).toBeNull();
  });
  it("validates the whole returned control scope before retiring a durable ACK", async () => {
    const f = await fixture(); await f.boot.initialize();
    const control = { ...f.f.scope, version: 1, mutationId: randomUUID(), controlRequestId: randomUUID(), fenceEpoch: 1,
      selectors: [{ provider: "cursor", credentialId: f.f.selection.credentialRun.credentialId }],
      operation: "pause-starts", desiredCacheRevision: null };
    const fences = f.boot.fences, ack = await fences.handle(control);
    f.controls.mockResolvedValueOnce({ version: 1, mode: "boot-owner-v1", controls: [{ ...control, fundingOwnerEpoch: 2 }] });
    await expect(f.boot.pollCredentialControls()).rejects.toMatchObject({ code: "credential_control_authority_rejected" });
    expect(fences.pendingAcknowledgement()).toEqual(ack);
  });
  it("keeps an unacknowledged/old registration legacy without a private boot fetch", async () => {
    const f = await fixture(); f.unnegotiate();
    expect(await f.boot.initialize()).toBe(false); expect(f.boot.active).toBe(false);
    expect(f.request).not.toHaveBeenCalled(); expect(f.install).not.toHaveBeenCalled();
  });
  it("installs the genuine factory and FULL ledger only after exact CP activation", async () => {
    const f = await fixture(), original = f.request.getMockImplementation()!;
    let acknowledge!: (value: Awaited<ReturnType<typeof original>>) => void;
    const activate = new Promise<Awaited<ReturnType<typeof original>>>(resolve => { acknowledge = resolve; });
    f.request.mockImplementation((operation, input) => operation === "activate" ? activate : original(operation, input));
    const pending = f.boot.initialize();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([operation]) => operation === "activate")).toBe(true));
    expect(f.boot.active).toBe(false); expect(f.install).not.toHaveBeenCalled();
    const response = await original("activate", {}); acknowledge(response); await pending;
    expect(f.boot.active).toBe(true); expect(f.beforeActivate).toHaveBeenCalledTimes(1);
    const [factory, queue] = f.install.mock.calls[0]!;
    expect(isCloudBootAgentExecutionFactory(factory)).toBe(true);
    expect(queue.durability()).toEqual({ journalMode: "wal", synchronous: "full" });
    expect(f.boot.metadata).toMatchObject({ bootId: f.f.scope.bootId, writerEpoch: f.f.scope.writerEpoch });
    expect(f.boot.metadata).not.toHaveProperty("providers");
  });
  it("refuses a mismatched source boot before cutover", async () => {
    const f = await fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (operation, input) => operation === "bootstrap"
      ? { ...f.f.response, bootId: randomUUID() } : original(operation, input));
    await expect(f.boot.initialize()).rejects.toMatchObject({ code: "cloud_admission_authority_response_invalid" });
    expect(f.install).not.toHaveBeenCalled(); expect(f.boot.active).toBe(false);
  });
  it("confirms the actual admitted actor and warms the original context off Send; selection performs no CP request", async () => {
    const f = await fixture(); await f.boot.initialize();
    await f.boot.confirmAdmission(f.admission);
    await f.boot.observeConversation(f.admission.actor.sessionId, f.f.input.conversationId);
    const payload = { agentId: "cursor" as const, model: f.f.input.model, permissionMode: "auto" as const,
      modeRevision: 0, userMessageId: randomUUID(), prompt: [{ type: "text" as const, text: "Synthetic prompt" }] };
    const commandId = randomUUID();
    f.boot.queue.handle({ kind: "mutate", mutation: { conversationId: f.f.input.conversationId, operationId: commandId,
      expectedRevision: 0, action: { kind: "enqueue", commandId, payload } }, admissionError: null },
      { writerEpoch: f.f.scope.writerEpoch, actorSessionId: f.admission.actor.sessionId });
    const claim = f.boot.queue.handle({ kind: "claim", conversationId: f.f.input.conversationId,
      executionId: randomUUID(), claimId: randomUUID() }, { writerEpoch: f.f.scope.writerEpoch });
    f.request.mockClear();
    const selection = f.boot.selectClaim(claim);
    expect(isCloudBootAgentSelection(selection)).toBe(true);
    expect(selection.actor.provenance.actorSessionId).toBe(f.admission.actor.sessionId);
    expect(f.request).not.toHaveBeenCalled(); expect(f.f.legacy.prepare).not.toHaveBeenCalled();
  });
  it("does not turn repeated conversation reads into per-Send context validation", async () => {
    const f = await fixture(); await f.boot.initialize(); await f.boot.confirmAdmission(f.admission);
    await f.boot.observeConversation(f.admission.actor.sessionId, f.f.input.conversationId);
    f.request.mockClear();
    await f.boot.observeConversation(f.admission.actor.sessionId, f.f.input.conversationId);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("parks a cold context but dispatches a ready context without awaiting its background renewal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const f = await fixture(), original = f.request.getMockImplementation()!, contextRequest = f.f.contextRequest.getMockImplementation()!;
    let response: Awaited<ReturnType<typeof contextRequest>> | null = null;
    f.f.contextRequest.mockImplementation(async input => {
      response ??= await contextRequest(input);
      return { ...response, actor: { ...response.actor, confirmedUntilMs: Date.now() + 8_000 } };
    });
    f.request.mockImplementation(async (operation, input) => {
      if (operation === "warm-context") await new Promise<void>(resolve => setTimeout(resolve, 100));
      return original(operation, input);
    });
    await f.boot.initialize(); await f.boot.confirmAdmission(f.admission);
    const warming = f.boot.observeConversation(f.admission.actor.sessionId, f.f.input.conversationId);
    await vi.waitFor(() => expect(f.request.mock.calls.some(([operation]) => operation === "warm-context")).toBe(true));
    const commandId = randomUUID(), payload = { agentId: "cursor" as const, model: f.f.input.model,
      permissionMode: "auto" as const, modeRevision: 0, userMessageId: randomUUID(), prompt: [{ type: "text" as const, text: "Synthetic prompt" }] };
    const queue = f.boot.queue;
    queue.handle({ kind: "mutate", mutation: { conversationId: f.f.input.conversationId, operationId: commandId,
      expectedRevision: 0, action: { kind: "enqueue", commandId, payload } }, admissionError: null },
      { writerEpoch: f.f.scope.writerEpoch, actorSessionId: f.admission.actor.sessionId });
    const claimRequest = () => ({ kind: "claim" as const, conversationId: f.f.input.conversationId,
      executionId: randomUUID(), claimId: randomUUID() });
    expect(queue.handle(claimRequest(), { writerEpoch: f.f.scope.writerEpoch })).toBeNull();
    await vi.advanceTimersByTimeAsync(100); await warming;
    f.request.mockClear(); await vi.advanceTimersByTimeAsync(4_000);
    // Repository MCP reads precede the HTTP boundary even under fake timers.
    await vi.waitFor(() => expect(f.request.mock.calls.filter(([operation]) => operation === "warm-context")).toHaveLength(1),
      { timeout: 100, interval: 5 });
    let renewed = false;
    const renewal = f.boot.observeConversation(f.admission.actor.sessionId, f.f.input.conversationId).then(() => { renewed = true; });
    const count = f.request.mock.calls.length;
    const claim = queue.handle(claimRequest(), { writerEpoch: f.f.scope.writerEpoch });
    expect(claim).toMatchObject({ commandId });
    const selection = f.boot.selectClaim(claim);
    expect(isCloudBootAgentSelection(selection)).toBe(true); expect(renewed).toBe(false);
    expect(f.request).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(100); await renewal;
  });
  it("pins the original credential selection in the FULL claim and releases an unused capture exactly", async () => {
    const f = await fixture(); await f.boot.initialize(); await f.boot.confirmAdmission(f.admission);
    await f.boot.observeConversation(f.admission.actor.sessionId, f.f.input.conversationId);
    const commandId = randomUUID();
    const payload = { agentId: "cursor" as const, model: f.f.input.model, permissionMode: "auto" as const,
      modeRevision: 0, userMessageId: randomUUID(), prompt: [{ type: "text" as const, text: "Synthetic" }] };
    f.boot.queue.handle({ kind: "mutate", mutation: { conversationId: f.f.input.conversationId, operationId: commandId,
      expectedRevision: 0, action: { kind: "enqueue", commandId, payload } }, admissionError: null },
      { writerEpoch: f.f.scope.writerEpoch, actorSessionId: f.admission.actor.sessionId });
    const claim = f.boot.queue.handle({ kind: "claim", conversationId: f.f.input.conversationId,
      executionId: randomUUID(), claimId: randomUUID() }, { writerEpoch: f.f.scope.writerEpoch }) as Parameters<typeof f.boot.releaseClaim>[0];
    const run = f.boot.queue.peekMirrorBatch()!.changes.at(-1)!.credentialRun;
    expect(run).toMatchObject({ bootId: f.f.scope.bootId, provider: "cursor" });
    const selectors = [{ provider: "cursor" as const, credentialId: run!.credentialId }];
    expect(f.boot.executionFactory.bootScopeActivity(selectors)).toMatchObject({ reservedLaunches: 1,
      scopes: [expect.objectContaining({ credentialRun: run, executionId: claim.executionId })] });
    await f.boot.releaseClaim(claim);
    expect(f.boot.executionFactory.bootScopeActivity(selectors).scopes).toEqual([]);
    expect(() => f.boot.selectClaim(claim)).toThrow();
  });
  it("keeps a paused source queued before any durable dispatch marker", async () => {
    const f = await fixture(); await f.boot.initialize(); await f.boot.confirmAdmission(f.admission);
    await f.boot.observeConversation(f.admission.actor.sessionId, f.f.input.conversationId);
    const provider = f.f.response.providers.find(value => value.status === "ready")!;
    if (provider.status !== "ready") throw new Error("Fixture provider missing");
    await f.boot.fences.handle({ ...f.f.scope, version: 1, mutationId: randomUUID(), controlRequestId: randomUUID(),
      fenceEpoch: 1, operation: "pause-starts", desiredCacheRevision: null, selectors: [{ provider: provider.provider, credentialId: provider.credentialId }] });
    const commandId = randomUUID(), payload = { agentId: "cursor", model: f.f.input.model, modeRevision: 0,
      userMessageId: randomUUID(), prompt: [{ type: "text", text: "Synthetic" }] };
    f.boot.queue.handle({ kind: "mutate", mutation: { conversationId: f.f.input.conversationId, operationId: commandId,
      expectedRevision: 0, action: { kind: "enqueue", commandId, payload } }, admissionError: null },
      { writerEpoch: f.f.scope.writerEpoch, actorSessionId: f.admission.actor.sessionId });
    expect(f.boot.queue.handle({ kind: "claim", conversationId: f.f.input.conversationId,
      executionId: randomUUID(), claimId: randomUUID() }, { writerEpoch: f.f.scope.writerEpoch })).toBeNull();
  });
  it("exposes activated metadata only for a positively confirmed current actor", async () => {
    const f = await fixture(); await f.boot.initialize();
    expect(() => f.boot.metadataFor(f.admission.actor.sessionId)).toThrow("cloud_actor_authority_rejected");
    await f.boot.confirmAdmission(f.admission);
    expect(f.boot.metadataFor(f.admission.actor.sessionId)).toMatchObject({ bootId: f.f.scope.bootId, writerEpoch: f.f.scope.writerEpoch });
    expect(() => f.boot.metadataFor(randomUUID())).toThrow("cloud_actor_authority_rejected");
    f.retire(); expect(() => f.boot.metadataFor(f.admission.actor.sessionId)).toThrow();
  });
  it("renews context proof at its own shorter deadline rather than the actor-only deadline", async () => {
    vi.useFakeTimers(); const f = await fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (operation, input) => {
      const value = await original(operation, input);
      return operation === "warm-context" ? { ...value, actor: { ...f.f.provenance, confirmedUntilMs: Date.now() + 1_000 } } : value;
    });
    await f.boot.initialize(); await f.boot.confirmAdmission(f.admission);
    await f.boot.observeConversation(f.admission.actor.sessionId, f.f.input.conversationId);
    f.request.mockClear(); await vi.advanceTimersByTimeAsync(600);
    // Repository configuration uses real asynchronous file reads even under
    // fake timers; let the scheduled renewal reach its request boundary.
    await vi.waitFor(() => expect(f.request.mock.calls.some(([operation]) => operation === "warm-context")).toBe(true),
      { interval: 10, timeout: 100 });
  });
  it("does not install a foreign actor proof or advertise after engine authority retirement", async () => {
    const f = await fixture(); await f.boot.initialize();
    await expect(f.boot.confirmAdmission({ ...f.admission, accountUserId: randomUUID() }))
      .rejects.toMatchObject({ code: "cloud_actor_authority_rejected" });
    f.retire(); expect(f.boot.active).toBe(false);
    expect(() => f.boot.metadata).toThrow();
  });
});
