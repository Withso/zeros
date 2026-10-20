import { randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudAcceptedWorkReceiptSchema, type CloudAcceptedWorkEnrollRequest } from "@zeros/protocol/cloud-accepted-work";
import { cloudAcceptedWorkCommandBinding, cloudAcceptedWorkProofMessage } from "@zeros/protocol/cloud-accepted-work-client";
import { CloudBootCommandSnapshotSchema, type CloudBootCommandMutation } from "@zeros/protocol/cloud-commands";
import { CloudActorAuthorityRegistry } from "../agents/cloud-actor-authority";
import { CloudAgentContextCache } from "../agents/cloud-provider-execution";
import { CloudAcceptedWorkAuthority, isCloudAcceptedWork } from "../agents/cloud-accepted-work-authority";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { EngineCapabilityAuth } from "../cloud-capability-auth";
import { capabilityEpochEntries } from "../cloud-capability-verifier";
import { openSqlite } from "../db/sqlite";
import { TEST_CAPABILITY_HEADER, TEST_CAPABILITY_IDS, TEST_CAPABILITY_NOW_S, testClientClaims,
  signTestCapability, signTestProof, testSigningJwk, testEd25519Key } from "../../../../control-plane/src/cloud-workspaces/capability-verifier-test-utils";

const cleanup: Array<() => void> = [];
vi.mock("../agents/cloud-mcp", async original => ({ ...await original<typeof import("../agents/cloud-mcp")>(), readCloudRepositoryMcp: vi.fn(async () => []) }));
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.useRealTimers(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(options: { fundedByGrant?: boolean; maxEntries?: number; actorDeviceId?: string; continuation?: boolean; dispatch?: boolean } = {}) {
  const ids = TEST_CAPABILITY_IDS;
  const scope = { workspaceId: ids.workspace, organizationId: ids.org, engineInstanceId: ids.engine, generation: 7,
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: ids.user, fundingOwnerEpoch: 1 };
  const runtimeId = `r1-${"a".repeat(64)}`;
  const clock = { wall: TEST_CAPABILITY_NOW_S * 1000, monotonic: 0 };
  const time = { wall: () => clock.wall, monotonic: () => clock.monotonic };
  const engineLive = vi.fn(() => true), enabled = vi.fn(() => true);
  const auth = new EngineCapabilityAuth({ identity: scope, issuer: "https://cp.example.test", now: time.wall,
    store: { read: async () => null, write: async () => {} } });
  cleanup.push(() => auth.stop());
  await auth.applyKeys([{ ...testSigningJwk(TEST_CAPABILITY_HEADER.kid), use: "sig", alg: "EdDSA" }]);
  await auth.applySync({ syncId: randomUUID(), complete: true, authCursor: "accepted-start", epochs: { wa: 1, wr: 1 }, revocations: [] });
  const claims = testClientClaims({ role: "owner", ep: { wa: 1, wr: 1, me: 1, ac: 1, dk: 2 },
    iat: TEST_CAPABILITY_NOW_S, nbf: TEST_CAPABILITY_NOW_S, exp: TEST_CAPABILITY_NOW_S + 300 });
  const capability = signTestCapability(TEST_CAPABILITY_HEADER, claims);
  const proof = () => {
    const fields = { aud: "zeros:engine", wsp: ids.workspace, jti: String(claims.jti), timestampMs: clock.wall,
      nonce: randomBytes(16).toString("base64url"), route: "direct" as const };
    return { timestampMs: fields.timestampMs, nonce: fields.nonce, signature: signTestProof("device-a", fields) };
  };
  const verified = await auth.verifyClient({ capability, proof: proof() }, "direct");
  if (!verified.ok) throw new Error(`fixture capability rejected: ${verified.code}`);
  const clientSessionId = randomUUID(), actorSessionId = randomUUID();
  auth.admit(clientSessionId, verified, "direct");
  const actor = { userId: ids.user, deviceId: options.actorDeviceId ?? ids.device, deviceKeyVersion: 2, role: "owner" as const, fingerprint: "b".repeat(64) };
  const actors = new CloudActorAuthorityRegistry({ scope, engineLive, time }); cleanup.push(() => actors.dispose());
  const legacy = actors.confirm({ scope, actor, actorSessionId, authorityEpoch: 1, confirmedUntilMs: clock.wall + 10_000,
    fundingConsentVersion: 1, fundingGrant: options.fundedByGrant ? { kind: "share", grantId: randomUUID(), grantRevision: 1 } : { kind: "owner" } });
  const directory = mkdtempSync(join(tmpdir(), "zeros-accepted-work-")), file = join(directory, "queue.sqlite");
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  let authority: CloudAcceptedWorkAuthority;
  const acceptedReady = vi.fn(() => true);
  const selected = vi.fn((work: import("../agents/cloud-accepted-work-authority").CloudAcceptedWork) => ({ executionId: work.receipt.command.executionId }));
  const queueOptions = { file, scope, actors, engineLive, now: time.wall, ready: () => true,
    ...(options.dispatch ? { accepted: { get: (id: string) => authority?.get(id), ready: acceptedReady,
      selectExecution: ({ work }: { work: import("../agents/cloud-accepted-work-authority").CloudAcceptedWork }) => selected(work) } } : {}),
    history: () => ({ recordSequence: 0, eventSequence: 0 }) };
  const queue = new CloudLocalCommandQueue(queueOptions); cleanup.push(() => queue.close());
  const receipt = (request: CloudAcceptedWorkEnrollRequest) => CloudAcceptedWorkReceiptSchema.parse({ version: 1, acceptedWorkId: randomUUID(), revision: 1,
    scope, runtimeId, actorSessionId, actor, sourceSessionId: ids.session, kid: TEST_CAPABILITY_HEADER.kid, capabilityId: claims.jti,
    devicePublicKey: verified.claims.cnf!.jwk.x, epochs: verified.claims.ep, scopes: verified.claims.scp, command: request.command,
    acceptedAtMs: clock.wall, capabilityExpiresAtMs: Number(claims.exp) * 1000, providerExpiresAtMs: clock.wall + 3_600_000, providerProofVersion: 1 });
  const enroll = vi.fn(async (request: CloudAcceptedWorkEnrollRequest, _signal: AbortSignal): Promise<unknown> => receipt(request));
  const healthListeners = new Set<() => void>();
  let healthDeadline: number | null = null;
  const continuation = { retain: vi.fn(() => () => {}), deadline: () => healthDeadline,
    onChange: (listener: () => void) => { healthListeners.add(listener); return () => { healthListeners.delete(listener); }; } };
  const health = (valid: boolean) => { healthDeadline = valid ? clock.monotonic + 10_000 : null;
    for (const listener of healthListeners) listener(); };
  authority = new CloudAcceptedWorkAuthority({ ...(options.continuation ? { continuation } : {}), ledger: queue.acceptedWork, auth, runtimeId, engineLive, enabled, enroll, time,
    ...(options.maxEntries ? { maxEntries: options.maxEntries } : {}) });
  cleanup.push(() => authority.dispose());
  const mutation = (conversationId = randomUUID(), expectedRevision = 0): CloudBootCommandMutation => ({ conversationId,
    expectedRevision, operationId: randomUUID(), action: { kind: "enqueue", commandId: randomUUID(), payload: {
      userMessageId: randomUUID(), agentId: "claude", model: "claude-sonnet-4-6", modeRevision: 0,
      permissionMode: "default", prompt: [{ type: "text", text: "synthetic accepted command" }] } } });
  const input = (command = mutation()) => {
    const fresh = proof();
    const commandSignature = sign(null, Buffer.from(cloudAcceptedWorkProofMessage({ aud: "zeros:engine", wsp: scope.workspaceId,
      jti: String(claims.jti), scope, ...cloudAcceptedWorkCommandBinding(command), timestampMs: fresh.timestampMs,
      nonce: fresh.nonce, route: "direct" })), testEd25519Key("device-a").privateKey).toString("base64url");
    return { mutation: command, cwd: "/srv/zeros/workspace", executionId: randomUUID(),
      clientSessionId, actorSessionId, auth: { capability, proof: fresh, commandSignature }, route: "direct" as const };
  };
  const snapshot = (conversationId: string) => CloudBootCommandSnapshotSchema.parse(queue.handle({ kind: "snapshot", conversationId },
    { writerEpoch: scope.writerEpoch, actorSessionId }));
  const advance = (ms: number) => { clock.wall += ms; clock.monotonic += ms; };
  return { scope, actor, actorSessionId, clientSessionId, actors, legacy, auth, claims: verified.claims, capability, proof, time, clock,
    runtimeId, engineLive, enabled, queue, file, queueOptions, receipt, enroll, authority, mutation, input, snapshot, advance, health, continuation, acceptedReady, selected };
}

describe("accepted work remains separate from client authority", () => {
  it.each(["before", "after"] as const)("accepted work survives push observation loss %s client expiry", async timing => {
    const f = await fixture({ continuation: true }), { work } = await f.authority.accept(f.input());
    if (timing === "after") { f.advance(299_000); f.health(true); f.advance(2_000); }
    f.health(false);
    if (timing === "before") f.advance(301_000);
    expect(() => work.assertLive()).not.toThrow();
    expect(work.signal.aborted).toBe(false);
    expect(f.queue.acceptedWork.get(work.receipt.command.commandId)?.state).toBe("accepted");
    // Outage tolerance never renews the client or the accepted hard deadline.
    await expect(f.authority.accept(f.input())).rejects.toThrow();
    f.advance(3_600_000);
    expect(() => work.assertLive()).toThrow();
    expect(work.signal.aborted).toBe(true);
  });

  it.each([25, 500])("clamps a context response delayed by %ims to the original request-start deadline", async delay => {
    const f = await fixture(), { work } = await f.authority.accept(f.input());
    const request = vi.fn(async () => { throw new Error("legacy context used"); });
    const acceptedRequest = vi.fn(async () => {
      // The server starts its ten-second observation after outbound transit.
      f.advance(delay);
      return { ...f.scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", authorityEpoch: 1,
        contextId: randomUUID(), contextRevision: "a".repeat(64),
        acceptedWork: { acceptedWorkId: work.receipt.acceptedWorkId, confirmedUntilMs: f.clock.wall + 10_000 },
        provider: work.receipt.command.provider, model: work.receipt.command.model, cwd: work.receipt.command.cwd,
        conversationId: work.receipt.command.conversationId, customization: null, gitAuthor: null,
        environment: { version: 1, revision: "b".repeat(64), values: {}, history: { owner: "c".repeat(64), currentKeyVersion: 1, keys: { 1: "d".repeat(43) } } },
        nativeCapabilities: { version: 1, goals: false, nativeFork: false, transcriptFork: false, nativeReview: false, connectedApps: false, multiAgent: false } };
    });
    const cache = new CloudAgentContextCache({ scope: f.scope, registry: f.actors, request, acceptedRequest, time: f.time,
      engineLive: f.engineLive, isAdmittedCwd: cwd => cwd === work.receipt.command.cwd }); cleanup.push(() => cache.dispose());
    const context = await cache.warm({ actor: work, provider: work.receipt.command.provider, model: work.receipt.command.model,
      conversationId: work.receipt.command.conversationId, cwd: work.receipt.command.cwd });
    expect(cache.remainingMs(context)).toBe(10_000 - delay);
    f.advance(9_999 - delay); context.assertLive();
    f.advance(1); expect(() => context.assertLive()).toThrow();
    work.assertLive(); expect(request).not.toHaveBeenCalled();
  });

  it("accepted context warming never confirms a desktop actor and retains its independent ten-second proof", async () => {
    const f = await fixture({ continuation: true }), { work } = await f.authority.accept(f.input());
    f.auth.closeClient(f.clientSessionId); f.actors.dispose(); f.advance(299_000); f.health(true); f.advance(2_000);
    const request = vi.fn(async () => { throw new Error("legacy context used"); });
    const response = { ...f.scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", authorityEpoch: 1,
      contextId: randomUUID(), contextRevision: "a".repeat(64), acceptedWork: { acceptedWorkId: work.receipt.acceptedWorkId, confirmedUntilMs: f.clock.wall + 8000 },
      provider: work.receipt.command.provider, model: work.receipt.command.model, cwd: work.receipt.command.cwd,
      conversationId: work.receipt.command.conversationId, customization: null, gitAuthor: null,
      environment: { version: 1, revision: "b".repeat(64), values: {}, history: { owner: "c".repeat(64), currentKeyVersion: 1, keys: { 1: "d".repeat(43) } } },
      nativeCapabilities: { version: 1, goals: false, nativeFork: false, transcriptFork: false, nativeReview: false, connectedApps: false, multiAgent: false } };
    const acceptedRequest = vi.fn(async () => response);
    const cache = new CloudAgentContextCache({ scope: f.scope, registry: f.actors, request, acceptedRequest, time: f.time,
      engineLive: f.engineLive, isAdmittedCwd: cwd => cwd === work.receipt.command.cwd }); cleanup.push(() => cache.dispose());
    const input = { actor: work, provider: work.receipt.command.provider, model: work.receipt.command.model,
      conversationId: work.receipt.command.conversationId, cwd: work.receipt.command.cwd };
    const context = await cache.warm(input);
    expect(context.actor).toBe(work); expect(request).not.toHaveBeenCalled();
    expect(acceptedRequest).toHaveBeenCalledWith(expect.objectContaining({ acceptedWorkId: work.receipt.acceptedWorkId,
      operation: "context", command: work.receipt.command }), expect.any(AbortSignal));
    await expect(cache.warm({ ...input, conversationId: randomUUID() })).rejects.toThrow();
    f.advance(7000); f.health(true); f.advance(1500);
    work.assertLive(); expect(() => context.assertLive()).toThrow();
    expect(context.signal.aborted).toBe(true); expect(work.signal.aborted).toBe(false);
  });

  it("a valid client PoP cannot enroll a different command or payload", async () => {
    const f = await fixture(), input = f.input();
    if (input.mutation.action.kind !== "enqueue") throw new Error("fixture");
    input.mutation.action.payload.prompt = [{ type: "text", text: "changed after signing" }];
    await expect(f.authority.accept(input)).rejects.toThrow();
    expect(f.enroll).not.toHaveBeenCalled(); expect(f.queue.acceptedWork.reservedCount()).toBe(0);
  });

  it("queued_accepted_work_dispatches_once_with_current_fences", async () => {
    const f = await fixture({ continuation: true, dispatch: true }), input = f.input(), { work } = await f.authority.accept(input);
    f.auth.closeClient(f.clientSessionId); f.actors.dispose();
    f.advance(299_000); f.health(true); f.advance(2_000);
    const request = { kind: "claim", conversationId: input.mutation.conversationId, executionId: randomUUID() };
    const ctx = { writerEpoch: f.scope.writerEpoch };
    f.acceptedReady.mockReturnValue(false);
    expect(f.queue.handle(request, ctx)).toBeNull(); expect(f.selected).not.toHaveBeenCalled();
    f.acceptedReady.mockReturnValue(true);
    const claim = f.queue.handle(request, ctx) as import("@zeros/protocol/cloud-commands").CloudBootCommandClaim;
    expect(claim).toMatchObject({ commandId: work.receipt.command.commandId, executionId: input.executionId, dispatchAllowed: true, actor: f.actor });
    expect(f.queue.authorizeClaim(claim)).toBe(work);
    expect(f.queue.handle(request, ctx)).toBeNull(); expect(f.selected).toHaveBeenCalledOnce();
    expect(() => f.queue.authorizeClaim({ ...claim, executionId: randomUUID() })).toThrow();
    f.health(false);
    expect(f.queue.authorizeClaim(claim)).toBe(work);
  });

  it("an accepted dispatch cannot substitute another native execution", async () => {
    const f = await fixture({ dispatch: true }), input = f.input(); await f.authority.accept(input);
    f.selected.mockReturnValue({ executionId: randomUUID() });
    expect(() => f.queue.handle({ kind: "claim", conversationId: input.mutation.conversationId, executionId: randomUUID() },
      { writerEpoch: f.scope.writerEpoch })).toThrow();
    expect(f.snapshot(input.mutation.conversationId).pending[0]?.state).toBe("queued");
  });

  it("accepted_turn_runs_past_300s_without_any_desktop", async () => {
    const f = await fixture({ continuation: true }), { work } = await f.authority.accept(f.input());
    f.auth.closeClient(f.clientSessionId); f.actors.dispose();
    f.advance(299_000); f.health(true); f.advance(2_000);
    expect(() => work.assertLive()).not.toThrow();
    expect(work.signal.aborted).toBe(false);
    // The enrolled principal cannot accept any new work under that old token.
    await expect(f.authority.accept(f.input())).rejects.toThrow();
  });

  it("lost push after client expiry keeps the exact grant until its own deadline", async () => {
    const f = await fixture({ continuation: true }), { work } = await f.authority.accept(f.input());
    f.advance(299_000); f.health(true); f.advance(2_000);
    expect(() => work.assertLive()).not.toThrow();
    f.health(false);
    expect(work.signal.aborted).toBe(false);
    expect(f.queue.acceptedWork.get(work.receipt.command.commandId)?.state).toBe("accepted");
    f.advance(3_299_000);
    expect(() => work.assertLive()).toThrow();
  });

  it("lost push before client expiry cannot shorten or renew the work deadline", async () => {
    const f = await fixture({ continuation: true }), { work } = await f.authority.accept(f.input());
    f.health(true); f.advance(20_000); f.health(false);
    f.advance(279_999); expect(() => work.assertLive()).not.toThrow();
    f.advance(1); expect(() => work.assertLive()).not.toThrow();
    f.health(true); expect(work.signal.aborted).toBe(false);
    f.advance(3_300_000); expect(() => work.assertLive()).toThrow();
  });

  it("provider_expiry_ends_work_when_job_is_late", async () => {
    const f = await fixture({ continuation: true }), { work } = await f.authority.accept(f.input());
    f.advance(299_000); f.health(true); f.advance(2_000);
    expect(() => work.assertLive()).not.toThrow();
    // Repeated current health cannot extend the receipt's finite hard expiry.
    for (let elapsed = 301_000; elapsed < 3_599_000; elapsed += 5_000) {
      f.health(true); f.advance(Math.min(5_000, 3_599_000 - elapsed)); work.assertLive();
    }
    f.health(true); f.advance(1_000);
    expect(() => work.assertLive()).toThrow(); expect(work.signal.aborted).toBe(true);
  });

  it("reconnect after the work deadline cannot resurrect", async () => {
    const f = await fixture({ continuation: true }), { work } = await f.authority.accept(f.input());
    f.advance(299_000); f.health(true); f.advance(2_000);
    expect(() => work.assertLive()).not.toThrow();
    f.health(false); f.advance(60 * 60_000); f.health(true);
    expect(f.authority.get(work.receipt.command.commandId)).toBeUndefined();
    expect(() => work.assertLive()).toThrow();
    expect(f.queue.acceptedWork.get(work.receipt.command.commandId)?.state).toBe("closed");
  });

  it("only_acknowledged_immutable_work_survives_disconnect", async () => {
    const f = await fixture(), pending = deferred<unknown>(), request = f.input();
    f.enroll.mockReturnValue(pending.promise);
    const accepting = f.authority.accept(request);
    void accepting.catch(() => {});
    await vi.waitFor(() => expect(f.enroll).toHaveBeenCalledOnce());
    expect(f.snapshot(request.mutation.conversationId).pending).toHaveLength(0);
    expect(f.queue.pendingActorSessions().has(f.actorSessionId)).toBe(true);
    pending.resolve(f.receipt(f.enroll.mock.calls[0]![0]));
    const result = await accepting;
    expect(isCloudAcceptedWork(result.work)).toBe(true);
    expect(isCloudAcceptedWork({ ...result.work })).toBe(false);
    expect(result.snapshot.pending).toHaveLength(1);
    expect(f.queue.pendingActorSessions().has(f.actorSessionId)).toBe(false);
    expect(() => f.actors.assertActor(result.work as never)).toThrow();
    f.auth.closeClient(f.clientSessionId); f.actors.dispose();
    expect(() => result.work.assertLive()).not.toThrow();
    // Until all execution consumers explicitly adopt the new principal in
    // 4C, the legacy claim path must park this row, never borrow its actor.
    expect(f.queue.handle({ kind: "claim", conversationId: request.mutation.conversationId, executionId: request.executionId },
      { writerEpoch: f.scope.writerEpoch })).toBeNull();
    const db = openSqlite(f.file);
    try {
      expect(f.queue.durability()).toEqual({ journalMode: "wal", synchronous: "full" });
      const saved = JSON.stringify(db.prepare("SELECT * FROM local_accepted_work").all());
      expect(saved).not.toContain(f.capability); expect(saved).not.toContain(request.auth.proof.signature);
    } finally { db.close(); }
  });

  it("acceptance_expiring_during_enrollment_is_rejected and a late response cannot ACK or enqueue", async () => {
    const f = await fixture(), pending = deferred<unknown>(), request = f.input();
    f.enroll.mockReturnValue(pending.promise);
    const accepting = f.authority.accept(request).catch(error => error);
    await vi.waitFor(() => expect(f.enroll).toHaveBeenCalledOnce());
    // Construct the real exact response before the hard deadline passes.
    const receipt = f.receipt(f.enroll.mock.calls[0]![0]);
    f.advance(300_000); pending.resolve(receipt);
    expect(await accepting).toBeInstanceOf(Error);
    expect(f.authority.get(receipt.command.commandId)).toBeUndefined();
    const db = openSqlite(f.file);
    try { expect(db.prepare("SELECT count(*) AS n FROM local_commands").get()).toEqual({ n: 0 }); }
    finally { db.close(); }
  });

  it("expired_token_cannot_accept_new_command while the ordinary socket has outage grace", async () => {
    const f = await fixture(); f.advance(300_000);
    await expect(f.authority.accept(f.input())).rejects.toThrow(); expect(f.enroll).not.toHaveBeenCalled();
  });

  it("same_id_changed_payload_conflicts and an identical fresh-proof retry retains the original receipt", async () => {
    const f = await fixture(), request = f.input(), first = await f.authority.accept(request);
    const replay = await f.authority.accept({ ...request, auth: f.input(request.mutation).auth });
    expect(replay.work).toBe(first.work); expect(f.enroll).toHaveBeenCalledOnce();
    const changed = structuredClone(request);
    if (changed.mutation.action.kind !== "enqueue") throw new Error("fixture command");
    changed.mutation.action.payload.prompt = [{ type: "text", text: "different immutable work" }];
    changed.auth.proof = f.proof();
    await expect(f.authority.accept(changed)).rejects.toThrow();
    expect(() => first.work.assertLive()).not.toThrow();
  });

  it.each(["key", "sid", "did", "epoch"])("%s invalidation immediately ends the independent accepted principal", async kind => {
    const f = await fixture(), { work } = await f.authority.accept(f.input());
    if (kind === "key") await f.auth.applyKeys([]);
    if (kind === "sid") f.auth.verifier.revoke("sid", f.claims.sid!);
    if (kind === "did") f.auth.verifier.revoke("did", f.claims.did!);
    if (kind === "epoch") {
      const [subject, epoch] = capabilityEpochEntries(f.scope, { wa: f.claims.ep.wa })[0]!;
      f.auth.verifier.mergeKnown([[subject, epoch + 1]]);
    }
    expect(work.signal.aborted).toBe(true); expect(() => work.assertLive()).toThrow();
    expect(f.authority.get(work.receipt.command.commandId)).toBeUndefined();
  });

  it("a backward wall clock cannot extend the original provider deadline", async () => {
    const f = await fixture(), { work } = await f.authority.accept(f.input());
    f.clock.monotonic += 3_600_000; f.clock.wall -= 60_000;
    expect(() => work.assertLive()).toThrow(); expect(work.signal.aborted).toBe(true);
  });

  it("a socket lost before the acceptance commit leaves no runnable work", async () => {
    const f = await fixture(), pending = deferred<unknown>(), request = f.input();
    f.enroll.mockReturnValue(pending.promise);
    const accepting = f.authority.accept(request).catch(error => error);
    await vi.waitFor(() => expect(f.enroll).toHaveBeenCalledOnce());
    const receipt = f.receipt(f.enroll.mock.calls[0]![0]); f.auth.closeClient(f.clientSessionId); pending.resolve(receipt);
    expect(await accepting).toBeInstanceOf(Error); expect(f.authority.get(receipt.command.commandId)).toBeUndefined();
    expect(f.snapshot(request.mutation.conversationId).pending).toHaveLength(0);
  });

  it("grant_funded_work_keeps_legacy_confirmation", async () => {
    const f = await fixture({ fundedByGrant: true });
    await expect(f.authority.accept(f.input())).rejects.toThrow(); expect(f.enroll).not.toHaveBeenCalled();
    f.advance(9_999); expect(() => f.legacy.assertLive()).not.toThrow();
    f.advance(1); expect(() => f.legacy.assertLive()).toThrow();
  });

  it("disabled accepted-work authority refuses enrollment", async () => {
    const f = await fixture(); f.enabled.mockReturnValue(false);
    await expect(f.authority.accept(f.input())).rejects.toThrow(); expect(f.enroll).not.toHaveBeenCalled();
  });

  it("a mismatched CP runtime cannot enqueue or retain an actor hold", async () => {
    const f = await fixture();
    f.enroll.mockImplementation(async request => ({ ...f.receipt(request), runtimeId: `r1-${"c".repeat(64)}` }));
    await expect(f.authority.accept(f.input())).rejects.toThrow();
    expect(f.enroll).toHaveBeenCalledOnce();
    expect(f.queue.pendingActorSessions().size).toBe(0);
    const db = openSqlite(f.file);
    try { expect(db.prepare("SELECT count(*) AS n FROM local_commands").get()).toEqual({ n: 0 }); }
    finally { db.close(); }
  });

  it("reopening the same writer quarantines accepted records instead of reconstructing authority", async () => {
    const f = await fixture(), request = f.input(), { work } = await f.authority.accept(request);
    f.queue.close();
    const reopened = new CloudLocalCommandQueue(f.queueOptions); cleanup.push(() => reopened.close());
    const authority = new CloudAcceptedWorkAuthority({ ledger: reopened.acceptedWork, auth: f.auth, runtimeId: f.runtimeId,
      engineLive: f.engineLive, enabled: f.enabled, enroll: f.enroll, time: f.time }); cleanup.push(() => authority.dispose());
    expect(authority.get(work.receipt.command.commandId)).toBeUndefined();
    await expect(authority.accept({ ...request, auth: f.input(request.mutation).auth })).rejects.toThrow();
    expect(f.enroll).toHaveBeenCalledOnce();
  });

  it("refuses capacity without evicting a live authority fence", async () => {
    const f = await fixture({ maxEntries: 2 });
    const first = await f.authority.accept(f.input()); await f.authority.accept(f.input());
    await expect(f.authority.accept(f.input())).rejects.toThrow(); expect(f.enroll).toHaveBeenCalledTimes(2);
    expect(() => first.work.assertLive()).not.toThrow();
  });

  it("a mismatched actor device cannot retain a reservation or pending actor hold", async () => {
    const f = await fixture({ actorDeviceId: randomUUID() }), input = f.input();
    await expect(f.authority.accept(input)).rejects.toThrow();
    expect(f.enroll).not.toHaveBeenCalled();
    expect(f.queue.pendingActorSessions().size).toBe(0);
    expect(f.queue.acceptedWork.reservedCount()).toBe(0);
  });

  it.each(["stop", "remove"])("%s immediately retires only the exact accepted work", async kind => {
    const f = await fixture(), input = f.input(), { work, snapshot } = await f.authority.accept(input);
    const other = await f.authority.accept(f.input());
    const context = { writerEpoch: f.scope.writerEpoch, actorSessionId: f.actorSessionId };
    if (kind === "stop") f.queue.handle({ kind: "stop", conversationId: input.mutation.conversationId, operationId: randomUUID() }, context);
    else f.queue.handle({ kind: "mutate", admissionError: null, mutation: { conversationId: input.mutation.conversationId,
      expectedRevision: snapshot.revision, operationId: randomUUID(), action: { kind: "remove", commandId: work.receipt.command.commandId } } }, context);
    expect(work.signal.aborted).toBe(true);
    expect(f.queue.acceptedWork.get(work.receipt.command.commandId)?.state).toBe("closed");
    expect(() => work.assertLive()).toThrow();
    expect(() => other.work.assertLive()).not.toThrow();
    expect(f.snapshot(input.mutation.conversationId).pending).toHaveLength(0);
  });

  it("Stop during enrollment releases its hold and a late CP response cannot ACK", async () => {
    const f = await fixture(), pending = deferred<unknown>(), input = f.input();
    f.enroll.mockReturnValue(pending.promise);
    const accepting = f.authority.accept(input).catch(error => error);
    await vi.waitFor(() => expect(f.enroll).toHaveBeenCalledOnce());
    const receipt = f.receipt(f.enroll.mock.calls[0]![0]);
    f.queue.handle({ kind: "stop", conversationId: input.mutation.conversationId, operationId: randomUUID() },
      { writerEpoch: f.scope.writerEpoch, actorSessionId: f.actorSessionId });
    expect(f.enroll.mock.calls[0]![1].aborted).toBe(true);
    expect(f.queue.pendingActorSessions().size).toBe(0);
    pending.resolve(receipt);
    expect(await accepting).toBeInstanceOf(Error);
    expect(f.snapshot(input.mutation.conversationId).pending).toHaveLength(0);
  });

  it.each(["fence", "close"])("queue %s immediately ends accepted authority", async kind => {
    const f = await fixture(), { work } = await f.authority.accept(f.input());
    if (kind === "fence") f.queue.fenceAcceptance(); else f.queue.close();
    expect(work.signal.aborted).toBe(true);
    expect(() => work.assertLive()).toThrow();
  });

  it("a rolled-back Stop never publishes retirement from its nested transaction", async () => {
    const f = await fixture(), input = f.input(), { work } = await f.authority.accept(input);
    const db = openSqlite(f.file);
    try {
      db.exec(`CREATE TRIGGER refuse_stop BEFORE UPDATE OF paused ON local_command_controls
        WHEN NEW.paused=1 BEGIN SELECT RAISE(ABORT,'synthetic stop failure'); END;`);
      expect(() => f.queue.handle({ kind: "stop", conversationId: input.mutation.conversationId, operationId: randomUUID() },
        { writerEpoch: f.scope.writerEpoch, actorSessionId: f.actorSessionId })).toThrow();
      expect(work.signal.aborted).toBe(false);
      expect(() => work.assertLive()).not.toThrow();
      expect(f.queue.acceptedWork.get(work.receipt.command.commandId)?.state).toBe("accepted");
      expect(f.snapshot(input.mutation.conversationId).pending).toHaveLength(1);
    } finally { db.exec("DROP TRIGGER refuse_stop"); db.close(); }
  });

  it("canceled enrollment I/O stays bounded until it settles, then frees its slot", async () => {
    const f = await fixture({ maxEntries: 1 }), pending = deferred<unknown>(), input = f.input();
    f.enroll.mockReturnValueOnce(pending.promise);
    const accepting = f.authority.accept(input).catch(error => error);
    await vi.waitFor(() => expect(f.enroll).toHaveBeenCalledOnce());
    f.queue.handle({ kind: "stop", conversationId: input.mutation.conversationId, operationId: randomUUID() },
      { writerEpoch: f.scope.writerEpoch, actorSessionId: f.actorSessionId });
    expect(await accepting).toBeInstanceOf(Error);
    await expect(f.authority.accept(f.input())).rejects.toThrow("accepted_work_limit");
    pending.resolve(f.receipt(f.enroll.mock.calls[0]![0]));
    await vi.waitFor(async () => expect((await f.authority.accept(f.input())).work).toBeDefined());
    expect(f.enroll).toHaveBeenCalledTimes(2);
  });
});
