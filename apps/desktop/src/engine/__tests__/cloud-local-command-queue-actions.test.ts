import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudActionReceiptSchema, type CloudAction } from "@zeros/protocol/cloud-actions";
import { CloudActorAuthorityRegistry } from "../agents/cloud-actor-authority";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { CloudLocalCommandActionStore, isCloudLocalCommandActionStore } from "../cloud-local-command-queue-actions";
import { CloudActionRuntime } from "../cloud-action-runtime";
import { openSqlite } from "../db/sqlite";
import { ZerosEngine } from "../zeros-engine";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(maxReceipts?: number) {
  const directory = mkdtempSync(join(tmpdir(), "zeros-local-actions-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "queue.sqlite"), now = 1_000_000, actorSessionId = randomUUID();
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const engineLive = vi.fn(() => true), actor = { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 1,
    fingerprint: "a".repeat(64), role: "owner" as const };
  const wall = vi.fn(() => now);
  const actors = new CloudActorAuthorityRegistry({ scope, engineLive, time: { wall, monotonic: () => 0 } });
  const confirm = (session = actorSessionId) => actors.confirm({ scope, actorSessionId: session, actor, authorityEpoch: 1,
    confirmedUntilMs: now + 9_000, fundingConsentVersion: 1, fundingGrant: { kind: "owner" } });
  confirm(); cleanup.push(() => actors.dispose());
  const queue = new CloudLocalCommandQueue({ file, scope, actors, engineLive, history: () => ({ recordSequence: 0, eventSequence: 0 }), ready: () => true });
  cleanup.push(() => queue.close());
  const authorize = vi.fn((session: string, capability: "read" | "run") => actors.authorizeCurrent(session, capability));
  const options = { file, queue, engineLive, authorize, ...(maxReceipts === undefined ? {} : { maxReceipts }) };
  const store = new CloudLocalCommandActionStore(options); cleanup.push(() => store.close());
  const action: CloudAction = { operationId: randomUUID(), conversationId: "chat", executionId: "native-execution", requestId: randomUUID(),
    kind: "permission", payload: { response: { outcome: { outcome: "selected", optionId: "allow" } } } };
  return { file, scope, queue, actors, authorize, engineLive, store, options, action, actorSessionId, confirm, wall };
}
const receipt = (value: unknown) => CloudActionReceiptSchema.parse(value);
function runtime(f: ReturnType<typeof fixture>) {
  const dispatch = vi.fn(async () => ({ outcome: "delivered" as const, turnId: "turn" }));
  const rt = new CloudActionRuntime({ request: (input, actorSessionId) => f.store.request(input, actorSessionId), validate: () => true,
    authorize: async (_action, session) => { f.actors.authorizeCurrent(session!, "run"); }, dispatch, changed: () => {} });
  cleanup.push(() => rt.close()); return { rt, dispatch };
}

describe("FULL local native action receipts", () => {
  it("mints only a genuine store on the original live WAL/FULL queue file", () => {
    const f = fixture(); expect(isCloudLocalCommandActionStore(f.store)).toBe(true);
    expect(isCloudLocalCommandActionStore({ ...f.store })).toBe(false);
    const db = openSqlite(f.file, { readonly: true });
    try { expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" }); }
    finally { db.close(); }
    expect(f.store.hasActiveWork()).toBe(false);
  });
  it("refuses a copied ledger with matching boot metadata", async () => {
    const f = fixture(), copied = join(f.file, "..", "copied.sqlite"); f.store.close();
    const db = openSqlite(f.file); try { await db.backup(copied); } finally { db.close(); }
    expect(() => new CloudLocalCommandActionStore({ ...f.options, file: copied })).toThrow("engine_authority_rejected");
  });
  it("refuses concurrent action stores for the same original queue", () => {
    const f = fixture(); expect(() => new CloudLocalCommandActionStore(f.options)).toThrow("engine_authority_rejected");
  });
  it.each(["permission", "question", "steer"] as const)("persists exact %s identity and actor before a native callback", async kind => {
    const f = fixture(), action: CloudAction = kind === "permission" ? f.action : kind === "question" ? { ...f.action, kind,
      payload: { response: { outcome: { outcome: "dismissed" } } } } : { ...f.action, kind, requestId: "steer-message",
      payload: { agentId: "claude", turnId: "turn", userMessageId: "steer-message", prompt: [{ type: "text", text: "Synthetic steering" }] } };
    const { rt, dispatch } = runtime(f);
    dispatch.mockImplementationOnce(async () => {
      const saved = receipt(await f.store.request({ kind: "read", operationId: action.operationId }, f.actorSessionId));
      expect(saved).toMatchObject({ state: "dispatching", claimId: expect.any(String), replayed: true });
      expect(f.store.hasActiveWork()).toBe(true);
      return { outcome: "delivered", turnId: "turn" };
    });
    const result = await rt.handle({ kind: "submit", action }, f.actorSessionId);
    expect(result).toMatchObject({ state: "settled", outcome: "delivered", kind, turnId: "turn" });
    expect(f.store.hasActiveWork()).toBe(false); expect(dispatch).toHaveBeenCalledOnce();
    expect(await rt.handle({ kind: "submit", action }, f.actorSessionId)).toMatchObject({ replayed: true, state: "settled" });
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it("replays an ambiguous begin without dispatching it again", async () => {
    const f = fixture(); await f.store.request({ kind: "begin", action: f.action, admissible: true }, f.actorSessionId);
    const { rt, dispatch } = runtime(f);
    expect(await rt.handle({ kind: "submit", action: f.action }, f.actorSessionId)).toMatchObject({ state: "settled", outcome: "interrupted", replayed: false });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("quarantines inherited dispatching receipts on reopen, including the same writer", async () => {
    const f = fixture(), initial = receipt(await f.store.request({ kind: "begin", action: f.action, admissible: true }, f.actorSessionId));
    f.store.close(); const reopened = new CloudLocalCommandActionStore(f.options); cleanup.push(() => reopened.close());
    expect(await reopened.request({ kind: "begin", action: f.action, admissible: true }, f.actorSessionId)).toMatchObject({
      state: "uncertain", outcome: "interrupted", replayed: true, claimId: initial.claimId });
    await expect(reopened.request({ kind: "settle", operationId: f.action.operationId, claimId: initial.claimId,
      outcome: "delivered", turnId: null })).rejects.toThrow("command_conflict");
  });
  it("keeps terminal retries exact and engine-private after actor source revocation", async () => {
    const f = fixture(), first = receipt(await f.store.request({ kind: "begin", action: f.action, admissible: true }, f.actorSessionId));
    const settlement = { kind: "settle" as const, operationId: first.operationId, claimId: first.claimId, outcome: "delivered" as const, turnId: "turn" };
    f.actors.revoke(f.actorSessionId);
    expect(await f.store.request(settlement)).toMatchObject({ state: "settled", replayed: false });
    expect(await f.store.request(settlement)).toMatchObject({ state: "settled", replayed: true });
    await expect(f.store.request({ ...settlement, outcome: "queued" })).rejects.toThrow("command_conflict");
    await expect(f.store.request({ ...settlement, turnId: "other" })).rejects.toThrow("command_conflict");
    await expect(f.store.request({ ...settlement, claimId: randomUUID() })).rejects.toThrow("command_conflict");
    await expect(f.store.request({ kind: "read", operationId: first.operationId }, f.actorSessionId)).rejects.toThrow("cloud_actor_authority_rejected");
  });
  it("never overwrites changed action content or another actor's immutable operation", async () => {
    const f = fixture(); await f.store.request({ kind: "begin", action: f.action, admissible: true }, f.actorSessionId);
    await expect(f.store.request({ kind: "begin", action: { ...f.action, requestId: randomUUID() }, admissible: true }, f.actorSessionId)).rejects.toThrow("command_conflict");
    const session = randomUUID();
    f.actors.confirm({ scope: f.scope, actorSessionId: session, authorityEpoch: 1, confirmedUntilMs: 1_009_000,
      fundingConsentVersion: 1, fundingGrant: { kind: "share", grantId: randomUUID(), grantRevision: 1 }, actor: {
        userId: randomUUID(), deviceId: randomUUID(), deviceKeyVersion: 1, fingerprint: "b".repeat(64), role: "developer" } });
    await expect(f.store.request({ kind: "begin", action: f.action, admissible: true }, session)).rejects.toThrow("command_conflict");
  });
  it("allows read authority without granting viewers action dispatch", async () => {
    const f = fixture(); await f.store.request({ kind: "begin", action: f.action, admissible: true }, f.actorSessionId);
    const session = randomUUID(); f.actors.confirm({ scope: f.scope, actorSessionId: session, authorityEpoch: 1, confirmedUntilMs: 1_009_000,
      fundingConsentVersion: null, fundingGrant: null, actor: { userId: randomUUID(), deviceId: randomUUID(), deviceKeyVersion: 1,
        fingerprint: "b".repeat(64), role: "viewer" } });
    expect(await f.store.request({ kind: "read", operationId: f.action.operationId }, session)).toMatchObject({ replayed: true });
    await expect(f.store.request({ kind: "begin", action: { ...f.action, operationId: randomUUID() }, admissible: true }, session)).rejects.toThrow("cloud_actor_authority_rejected");
  });
  it("rolls back the whole begin when FULL storage fails and never reaches native", async () => {
    const f = fixture(), { rt, dispatch } = runtime(f), db = openSqlite(f.file);
    try {
      db.exec("CREATE TRIGGER deny_action BEFORE INSERT ON local_command_actions BEGIN SELECT RAISE(ABORT,'Synthetic'); END");
      await expect(rt.handle({ kind: "submit", action: f.action }, f.actorSessionId)).rejects.toThrow("command_storage_unavailable");
      expect(dispatch).not.toHaveBeenCalled(); expect(f.store.hasActiveWork()).toBe(false);
      db.exec("DROP TRIGGER deny_action"); await rt.handle({ kind: "submit", action: f.action }, f.actorSessionId);
      expect(dispatch).toHaveBeenCalledOnce();
    } finally { db.close(); }
  });
  it("retains the dispatch claim across a failed settlement and retries only the exact terminal", async () => {
    const f = fixture(), first = receipt(await f.store.request({ kind: "begin", action: f.action, admissible: true }, f.actorSessionId)), db = openSqlite(f.file);
    const result = { kind: "settle" as const, operationId: first.operationId, claimId: first.claimId, outcome: "delivered" as const, turnId: null };
    try {
      db.exec("CREATE TRIGGER deny_terminal BEFORE UPDATE ON local_command_actions BEGIN SELECT RAISE(ABORT,'Synthetic'); END");
      await expect(f.store.request(result)).rejects.toThrow("command_storage_unavailable");
      expect(await f.store.request({ kind: "read", operationId: first.operationId }, f.actorSessionId)).toMatchObject({ state: "dispatching" });
      db.exec("DROP TRIGGER deny_terminal"); expect(await f.store.request(result)).toMatchObject({ state: "settled", outcome: "delivered" });
    } finally { db.close(); }
  });
  it("bounds retained receipts without losing an existing exact retry", async () => {
    const f = fixture(1); await f.store.request({ kind: "begin", action: f.action, admissible: true }, f.actorSessionId);
    await expect(f.store.request({ kind: "begin", action: { ...f.action, operationId: randomUUID() }, admissible: true }, f.actorSessionId)).rejects.toThrow("command_limit");
    expect(await f.store.request({ kind: "begin", action: f.action, admissible: true }, f.actorSessionId)).toMatchObject({ replayed: true });
  });
  it("refuses missing actor, inadmissible target and replaced writer without a receipt", async () => {
    const f = fixture(); await expect(f.store.request({ kind: "begin", action: f.action, admissible: true })).rejects.toThrow("cloud_actor_authority_rejected");
    await expect(f.store.request({ kind: "begin", action: f.action, admissible: false }, f.actorSessionId)).rejects.toThrow("command_context_changed");
    const db = openSqlite(f.file); try {
      db.prepare("UPDATE local_command_metadata SET value=? WHERE key='writer'").run(JSON.stringify({ ...f.scope, writerEpoch: randomUUID() }));
      await expect(f.store.request({ kind: "begin", action: f.action, admissible: true }, f.actorSessionId)).rejects.toThrow("engine_authority_rejected");
      expect(db.prepare("SELECT count(*) AS n FROM local_command_actions").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });
  it("refuses forged original actors, foreign scope and dead engine before admitting work", async () => {
    const f = fixture(), original = f.actors.authorizeCurrent(f.actorSessionId,"run");
    f.authorize.mockImplementationOnce(() => ({ ...original }));
    await expect(f.store.request({ kind: "begin", action: f.action, admissible: true }, f.actorSessionId)).rejects.toThrow("cloud_actor_authority_rejected");
    f.engineLive.mockReturnValue(false);
    await expect(f.store.request({ kind: "begin", action: f.action, admissible: true }, f.actorSessionId)).rejects.toThrow("engine_authority_rejected");
  });
  it("does not retain sensitive action prose, while payload hashes keep decisions immutable", async () => {
    const f = fixture(), action: CloudAction = { ...f.action, kind: "question", payload: { response: { outcome: { outcome: "answered",
      answers: [{ questionId: "question", selectedOptionIds: [], freeText: "Synthetic private answer marker" }] } } } };
    await f.store.request({ kind: "begin", action, admissible: true }, f.actorSessionId);
    const db = openSqlite(f.file, { readonly: true });
    try { expect(JSON.stringify(db.prepare("SELECT * FROM local_command_actions").all())).not.toContain("Synthetic private answer marker"); }
    finally { db.close(); }
    await expect(f.store.request({ kind: "begin", action: { ...action, payload: { response: { outcome: { outcome: "dismissed" } } } },
      admissible: true }, f.actorSessionId)).rejects.toThrow("command_conflict");
  });
  it("keeps successful terminal receipts exact after closing and reopening the private source", async () => {
    const f = fixture(), first = receipt(await f.store.request({ kind: "begin", action: f.action, admissible: true }, f.actorSessionId));
    const terminal = { kind: "settle" as const, operationId: first.operationId, claimId: first.claimId, outcome: "delivered" as const, turnId: null };
    await f.store.request(terminal); f.store.close(); const reopened = new CloudLocalCommandActionStore(f.options); cleanup.push(() => reopened.close());
    expect(await reopened.request(terminal)).toMatchObject({ state: "settled", outcome: "delivered", replayed: true });
    expect(await reopened.request({ kind: "begin", action: f.action, admissible: false }, f.actorSessionId)).toMatchObject({ state: "settled", replayed: true });
  });
  it("rolls back an expired authority after the receipt write without calling it a storage failure", async () => {
    const f = fixture(); let reads = 0;
    f.wall.mockImplementation(() => ++reads < 4 ? 1_000_000 : 1_010_000);
    await expect(f.store.request({ kind: "begin", action: f.action, admissible: true }, f.actorSessionId)).rejects.toThrow("cloud_actor_authority_rejected");
    const db = openSqlite(f.file, { readonly: true });
    try { expect(db.prepare("SELECT count(*) AS n FROM local_command_actions").get()).toEqual({ n: 0 }); }
    finally { db.close(); }
  });
  it("fences new native actions before writer drain while preserving exact passive reads", async () => {
    const f = fixture(), first = receipt(await f.store.request({ kind: "begin", action: f.action, admissible: true }, f.actorSessionId));
    f.queue.fenceAcceptance();
    await expect(f.store.request({ kind: "begin", action: { ...f.action, operationId: randomUUID() }, admissible: true }, f.actorSessionId))
      .rejects.toThrow("cloud_command_writer_retired");
    expect(await f.store.request({ kind: "read", operationId: first.operationId }, f.actorSessionId)).toMatchObject({ claimId: first.claimId });
    expect(await f.store.request({ kind: "settle", operationId: first.operationId, claimId: first.claimId, outcome: "delivered", turnId: "turn" }))
      .toMatchObject({ state: "settled", outcome: "delivered" });
  });
  it.each(["begin", "settle"] as const)("refuses every %s mutation after a writer is sealed", async kind => {
    const f = fixture(), first = receipt(await f.store.request({ kind: "begin", action: f.action, admissible: true }, f.actorSessionId));
    f.queue.fenceAcceptance();
    // Exact persisted sealed-writer state. This guard fixture does not supply
    // or claim the separate native quiescence or CP seal acceptance proof.
    const db = openSqlite(f.file);
    try { db.prepare("INSERT INTO local_command_metadata(key,value) VALUES('sealedWriter',?)").run(f.scope.writerEpoch); }
    finally { db.close(); }
    await expect(kind === "begin" ? f.store.request({ kind, action: f.action, admissible: true }, f.actorSessionId) :
      f.store.request({ kind, operationId: first.operationId, claimId: first.claimId, outcome: "delivered", turnId: "turn" }))
      .rejects.toThrow("cloud_command_writer_retired");
    expect(await f.store.request({ kind: "read", operationId: first.operationId }, f.actorSessionId)).toMatchObject({ state: "dispatching", claimId: first.claimId });
  });
});

type ActionDependencies = ConstructorParameters<typeof CloudActionRuntime>[0];
const actionMethods = ZerosEngine.prototype as unknown as {
  validateCloudAction: ActionDependencies["validate"];
  authorizeCloudAgentAction(executionId: string, actorSessionId?: string): ReturnType<ActionDependencies["authorize"]>;
  dispatchCloudAction: ActionDependencies["dispatch"];
};
function nativeActionFixture(kind: "permission" | "question" | "steer" = "permission", afterAuthorize?: () => void) {
  const f = fixture(), controller = new AbortController();
  const action: CloudAction = kind === "permission" ? f.action : kind === "question" ?
    { ...f.action, kind, payload: { response: { outcome: { outcome: "dismissed" } } } } :
    { ...f.action, kind, requestId: "steer-message", payload: { agentId: "claude", turnId: "turn", userMessageId: "steer-message",
      prompt: [{ type: "text", text: "Synthetic steering" }] } };
  const claim = { commandId: randomUUID(), executionId: action.executionId, actor: { userId: f.scope.fundingOwnerUserId } };
  const record = { claim, controller };
  const answerPermission = vi.fn(() => true), answerQuestion = vi.fn(() => true);
  let scheduled = false;
  const engine = {
    cloudRuntimeRegistration: { agentExecutionRequest: vi.fn(async () => {}) },
    cloudAgentBoot: { active: true, authorizeActor: vi.fn((id: string, capability: "read" | "run") => {
      const principal = f.actors.authorizeCurrent(id, capability);
      if (!scheduled) { scheduled = true; if (afterAuthorize) queueMicrotask(afterAuthorize); }
      return principal;
    }) },
    cloudLocalNativePump: { claimForExecution: vi.fn(() => claim), record: vi.fn(() => record) },
    validateCloudCommand: vi.fn(), validateCloudAction: actionMethods.validateCloudAction,
    conversationExecution: new Map([[action.conversationId, action.executionId]]), sessionAgent: new Map([[action.executionId, "claude"]]),
    pendingPermissionRequests: new Map([[action.requestId, { request: { sessionId: action.executionId, options: [{ optionId: "allow" }] } }]]),
    pendingQuestionRequests: new Map([[action.requestId, { request: { sessionId: action.executionId } }]]),
    permissionOwner: new Map(), questionOwner: new Map(), activeTurnSnapshots: new Map([[action.executionId, { turnId: "turn" }]]),
    agents: { answerPermission, answerQuestion, steer: vi.fn(async (_provider: string, _execution: string, _prompt: unknown, canDeliver: () => boolean) =>
      canDeliver() ? "delivered" as const : "interrupted" as const) }, cancelRequested: new Set<string>(),
    assertAgentSessionProcessStartAllowed: vi.fn(), workspaceIdForAgentSession: vi.fn(() => f.scope.workspaceId), persistSteeredUserPrompt: vi.fn(),
  };
  const rt = new CloudActionRuntime({ request: async () => { throw new Error("Unexpected CP action request"); }, changed: () => {},
    validate: input => actionMethods.validateCloudAction.call(engine, input),
    authorize: (input, id) => actionMethods.authorizeCloudAgentAction.call(engine, input.executionId, id),
    dispatch: (...args) => actionMethods.dispatchCloudAction.apply(engine, args) });
  cleanup.push(() => rt.close()); rt.installLocalStore(f.store);
  return { ...f, action, engine, record, claim, controller, answerPermission, answerQuestion, rt };
}
describe("original native action delivery authority", () => {
  it.each(["revocation", "stop"] as const)("does not deliver permission after %s crosses the local authorization await", async cause => {
    const f = nativeActionFixture("permission", () => {
      if (cause === "revocation") f.actors.revoke(f.actorSessionId);
      else f.controller.abort();
    });
    expect(await f.rt.handle({ kind: "submit", action: f.action }, f.actorSessionId)).toMatchObject({ state: "settled", outcome: "interrupted" });
    expect(f.answerPermission).not.toHaveBeenCalled();
    expect(f.engine.pendingPermissionRequests.has(f.action.requestId)).toBe(true);
    expect(f.engine.cloudRuntimeRegistration.agentExecutionRequest).not.toHaveBeenCalled();
  });
  it.each(["permission", "question"] as const)("delivers the current original %s exactly once without a CP call", async kind => {
    const f = nativeActionFixture(kind);
    expect(await f.rt.handle({ kind: "submit", action: f.action }, f.actorSessionId)).toMatchObject({ state: "settled", outcome: "delivered", turnId: "turn" });
    expect(kind === "permission" ? f.answerPermission : f.answerQuestion).toHaveBeenCalledOnce();
    expect(await f.rt.handle({ kind: "submit", action: f.action }, f.actorSessionId)).toMatchObject({ replayed: true, outcome: "delivered" });
    expect(kind === "permission" ? f.answerPermission : f.answerQuestion).toHaveBeenCalledOnce();
    expect(f.engine.cloudRuntimeRegistration.agentExecutionRequest).not.toHaveBeenCalled();
  });
  it("refuses an expired captured principal at the question callback", async () => {
    const f = nativeActionFixture("question", () => f.wall.mockReturnValue(1_010_000));
    expect(await f.rt.handle({ kind: "submit", action: f.action }, f.actorSessionId)).toMatchObject({ outcome: "interrupted" });
    expect(f.answerQuestion).not.toHaveBeenCalled(); expect(f.engine.pendingQuestionRequests.has(f.action.requestId)).toBe(true);
  });
  it("does not transfer an authorized action to a replacement claim on the same native execution", async () => {
    const f = nativeActionFixture("permission", () => {
      const replacement = { ...f.claim, commandId: randomUUID() };
      f.engine.cloudLocalNativePump.claimForExecution.mockReturnValue(replacement);
      f.engine.cloudLocalNativePump.record.mockReturnValue({ claim: replacement, controller: new AbortController() });
    });
    expect(await f.rt.handle({ kind: "submit", action: f.action }, f.actorSessionId)).toMatchObject({ outcome: "interrupted" });
    expect(f.answerPermission).not.toHaveBeenCalled();
  });
  it.each(["revocation", "stop"] as const)("keeps original authority at a delayed native steering callback after %s", async cause => {
    const f = nativeActionFixture("steer");
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), finished = new Promise<void>(resolve => { finish = resolve; });
    f.engine.agents.steer.mockImplementationOnce(async (_provider, _execution, _prompt, canDeliver) => {
      enter(); await finished;
      return canDeliver() ? "delivered" : "interrupted";
    });
    const pending = f.rt.handle({ kind: "submit", action: f.action }, f.actorSessionId);
    await entered;
    if (cause === "revocation") f.actors.revoke(f.actorSessionId); else f.controller.abort();
    finish();
    expect(await pending).toMatchObject({ state: "settled", outcome: "interrupted" });
  });
  it("honors the final Stop fence without relying on resolver disposal", async () => {
    const f = nativeActionFixture("permission", () => f.engine.cancelRequested.add(f.action.executionId));
    expect(await f.rt.handle({ kind: "submit", action: f.action }, f.actorSessionId)).toMatchObject({ outcome: "interrupted" });
    expect(f.answerPermission).not.toHaveBeenCalled();
  });
  it("does not consume a resolver under a missing or asynchronous boot delivery guard", async () => {
    const f = nativeActionFixture();
    expect(await actionMethods.dispatchCloudAction.call(f.engine, f.action)).toMatchObject({ outcome: "interrupted" });
    expect(await actionMethods.dispatchCloudAction.call(f.engine, f.action, async () => { throw new Error("Synthetic async authority"); }))
      .toMatchObject({ outcome: "interrupted" });
    expect(f.answerPermission).not.toHaveBeenCalled(); expect(f.engine.pendingPermissionRequests.has(f.action.requestId)).toBe(true);
  });
  it("retains real legacy CP authorization and its void native delivery contract", async () => {
    const f = nativeActionFixture(), legacy = { ...f.engine, cloudAgentBoot: null, cloudLocalNativePump: null };
    expect(await actionMethods.authorizeCloudAgentAction.call(legacy, f.action.executionId, f.actorSessionId)).toBeUndefined();
    expect(legacy.cloudRuntimeRegistration.agentExecutionRequest).toHaveBeenCalledOnce();
    expect(legacy.cloudRuntimeRegistration.agentExecutionRequest).toHaveBeenCalledWith(
      { kind: "authorize-action", executionId: f.action.executionId, actorSessionId: f.actorSessionId }, expect.any(AbortSignal));
    expect(await actionMethods.dispatchCloudAction.call(legacy, f.action)).toMatchObject({ outcome: "delivered" });
    expect(f.answerPermission).toHaveBeenCalledOnce();
  });
});
