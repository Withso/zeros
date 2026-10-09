import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessage } from "@zeros/protocol/messages";
import { CloudAgentBootConversationSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudBootCommandClaimSchema } from "@zeros/protocol/cloud-commands";
import { CloudLocalCommandMirrorBatchSchema } from "@zeros/protocol/cloud-local-mirror";
import { testCloudBootFixture } from "../agents/__tests__/helpers/test-cloud-boot";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { CloudActorAuthorityRegistry } from "../agents/cloud-agent-lease";
import { CloudLocalCommandEventStore } from "../cloud-local-command-queue-events";
import { CloudEventRuntime } from "../cloud-event-runtime";
import { openSqlite } from "../db/sqlite";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(maxEntries = 8192,install = true) {
  const directory = mkdtempSync(path.join(tmpdir(),"zeros-local-events-")); cleanups.push(() => rmSync(directory,{ recursive: true,force: true }));
  const f = await testCloudBootFixture(directory); cleanups.push(f.close);
  const file = path.join(directory,"queue.sqlite"), history = () => ({ recordSequence: 1,eventSequence: 0 });
  const actors = new CloudActorAuthorityRegistry({ scope: f.scope,engineLive: () => true });
  actors.confirm(f.provenance); cleanups.push(() => actors.dispose());
  const queue = new CloudLocalCommandQueue({ file,scope: f.scope,actors,engineLive: () => true,history,ready: () => true });
  cleanups.push(() => queue.close());
  const store = new CloudLocalCommandEventStore({ file,queue,engineLive: () => true,maxEntries }); cleanups.push(() => store.close());
  const request = vi.fn(async (): Promise<unknown> => { throw new Error("Unexpected CP event request"); });
  const runtime = new CloudEventRuntime(f.scope.engineInstanceId,{ request,onFailure: vi.fn() }); runtime.start();
  if (install) await runtime.installLocalStore(store); cleanups.push(() => runtime.close());
  const binding = CloudAgentBootConversationSchema.parse(f.credentials.metadata);
  const commandId = randomUUID(), turnId = randomUUID();
  queue.handle({ kind: "mutate",mutation: { conversationId: f.input.conversationId,operationId: randomUUID(),expectedRevision: 0,
    action: { kind: "enqueue",commandId,payload: { agentId: "cursor",model: "test-model",modeRevision: 0,userMessageId: turnId,
      prompt: [{ type: "text",text: "Synthetic" }] } } },admissionError: null },{ writerEpoch: f.scope.writerEpoch,actorSessionId: f.provenance.actorSessionId });
  const claim = CloudBootCommandClaimSchema.parse(queue.handle({ kind: "claim",conversationId: f.input.conversationId,
    claimId: randomUUID(),executionId: f.selection.executionId },{ writerEpoch: f.scope.writerEpoch }));
  queue.recordCredentialSelection(claim,f.selection.credentialRun);
  return { f,file,queue,store,runtime,request,binding,claim };
}
describe("FULL VM-local event replay and compact controls", () => {
  it("rejects a copied ledger even when its writer metadata is identical", async () => {
    const f = await fixture(),copied = path.join(path.dirname(f.file),"copied.sqlite"),db = openSqlite(f.file);
    try { db.prepare("VACUUM main INTO ?").run(copied); } finally { db.close(); }
    const copy = openSqlite(copied); try { copy.pragma("journal_mode = WAL"); copy.pragma("synchronous = FULL"); } finally { copy.close(); }
    expect(() => new CloudLocalCommandEventStore({ file: copied,queue: f.queue,engineLive: () => true }))
      .toThrow("engine_authority_rejected");
  });
  it("cuts over a confirmed legacy prefix monotonically and requires an explicit snapshot for it", async () => {
    const f = await fixture(8192,false);
    f.request.mockResolvedValue({ streamId: f.f.scope.engineInstanceId,head: 1,replayed: false });
    f.runtime.capture(createMessage({ type: "DB_CHANGED",source: "engine",kinds: ["messages"] }));
    await f.runtime.installLocalStore(f.store);
    f.runtime.capture(createMessage({ type: "DB_CHANGED",source: "engine",kinds: ["messages"] }));
    expect(f.runtime.cursor.sequence).toBe(2); expect(f.request).toHaveBeenCalledTimes(1);
    await expect(f.runtime.replay({ streamId: f.f.scope.engineInstanceId,sequence: 0 })).rejects.toMatchObject({ code: "event_snapshot_required" });
    expect(await f.runtime.replay({ streamId: f.f.scope.engineInstanceId,sequence: 1 })).toMatchObject({ head: 2,cursor: 2 });
  });
  it("recovers exact committed replay and credential-use bytes without reopening runnable intent", async () => {
    const f = await fixture(),use = f.store.credentialUse(f.claim,f.binding,"sdk_run_created")!;
    f.runtime.capture(createMessage({ type: "CLOUD_AGENT_CREDENTIAL_USED",source: "engine",use }));
    f.runtime.close(); f.store.close();
    const store = new CloudLocalCommandEventStore({ file: f.file,queue: f.queue,engineLive: () => true }); cleanups.push(() => store.close());
    const runtime = new CloudEventRuntime(f.f.scope.engineInstanceId,{ request: f.request,onFailure: vi.fn() }); runtime.start();
    cleanups.push(() => runtime.close()); await runtime.installLocalStore(store);
    expect(runtime.cursor.sequence).toBe(1); expect(store.credentialUses(f.claim.conversationId)).toEqual([use]);
    expect((await runtime.replay({ streamId: f.f.scope.engineInstanceId,sequence: 0 })).events[0]?.frame).toMatchObject({ use });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("refuses altered claim ownership and a foreign boot before creating a resolver or use", async () => {
    const f = await fixture();
    for (const claim of [{ ...f.claim,commandId: randomUUID() },{ ...f.claim,claimId: randomUUID() },
      { ...f.claim,payload: { ...f.claim.payload,userMessageId: randomUUID() } }])
      expect(() => f.store.bindControlOwner(randomUUID(),"permission",claim)).toThrow("event_conflict");
    expect(() => f.store.credentialUse(f.claim,{ ...f.binding,writerEpoch: randomUUID() },"native_write")).toThrow("event_conflict");
    expect(f.store.credentialUses(f.claim.conversationId)).toEqual([]); expect(f.store.controls(f.claim.conversationId)).toEqual([]);
  });
  it("serves live/reconnect deltas and snapshots without an event CP request", async () => {
    const f = await fixture();
    for (let i = 0; i < 100; i++) f.runtime.capture(createMessage({ type: "DB_CHANGED",source: "engine",kinds: ["messages"] }));
    await expect(f.runtime.snapshot(() => ({ text: "current" }))).resolves.toMatchObject({ cursor: { sequence: 100 } });
    expect(await f.runtime.replay({ streamId: f.f.scope.engineInstanceId,sequence: 0 })).toMatchObject({ head: 100,cursor: 100,events: expect.any(Array) });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.queue.peekMirrorBatch()!.changes.some(change => change.event)).toBe(false);
  });
  it("requires a snapshot for an evicted prefix and preserves the monotonic cursor", async () => {
    const f = await fixture(2);
    for (let i = 0; i < 3; i++) f.runtime.capture(createMessage({ type: "DB_CHANGED",source: "engine",kinds: ["messages"] }));
    await expect(f.runtime.replay({ streamId: f.f.scope.engineInstanceId,sequence: 0 })).rejects.toMatchObject({ code: "event_snapshot_required" });
    expect(await f.runtime.replay({ streamId: f.f.scope.engineInstanceId,sequence: 1 })).toMatchObject({ head: 3,firstRetained: 2,cursor: 3 });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("retains actual original first use once, independently of a later native ACK", async () => {
    const f = await fixture();
    const use = f.store.credentialUse(f.claim,f.binding,"native_write")!;
    f.runtime.capture(createMessage({ type: "CLOUD_AGENT_CREDENTIAL_USED",source: "engine",use }));
    expect(f.store.credentialUse(f.claim,f.binding,"native_write")).toBeNull();
    expect(f.store.credentialUses(f.claim.conversationId)).toEqual([use]);
    expect(f.runtime.cursor.sequence).toBe(use.firstUseSequence);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("mirrors only exact request/settled controls using the original resolver owner", async () => {
    const f = await fixture(), permissionId = randomUUID();
    const request = createMessage({ type: "AGENT_PERMISSION_REQUEST",source: "engine",agentId: "cursor",chatId: f.claim.conversationId,
      permissionId,request: { sessionId: f.claim.executionId,options: [{ optionId: "allow",kind: "allow_once",name: "Allow" }],toolCall: { toolCallId: "tool",title: "Synthetic",kind: "read" } } });
    f.store.bindControlOwner(permissionId,"permission",f.claim);
    f.runtime.capture(request);
    f.runtime.capture(createMessage({ type: "AGENT_PERMISSION_SETTLED",source: "engine",agentId: "cursor",permissionId,
      sessionId: f.claim.executionId,executionId: f.claim.executionId,chatId: f.claim.conversationId }));
    const controls = f.store.controls(f.claim.conversationId);
    expect(controls).toHaveLength(2);
    expect(controls.every(control => control.commandId === f.claim.commandId && control.turnId === f.claim.payload.userMessageId)).toBe(true);
    const batch = CloudLocalCommandMirrorBatchSchema.parse(f.queue.peekMirrorBatch());
    expect(batch.changes.filter(change => change.event)).toHaveLength(2);
    expect(f.request).not.toHaveBeenCalled();
  });
});
