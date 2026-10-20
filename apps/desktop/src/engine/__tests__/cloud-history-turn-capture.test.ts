import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudBootCommandClaimSchema } from "@zeros/protocol/cloud-commands";
import { createMessage } from "@zeros/protocol/messages";
import { assembleCloudHistoryDocument } from "../../../../control-plane/src/cloud-workspaces/history-local-contract";
vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));
const native = vi.hoisted(() => ({ execution: null as unknown }));
vi.mock("../agents/cloud-provider-execution", async original => ({
  ...await original<typeof import("../agents/cloud-provider-execution")>(), cloudProviderExecution: () => native.execution,
}));
import { ZerosEngine } from "../zeros-engine";
import { AgentGateway } from "../agents/gateway";
import { CloudCustomizationRedactor } from "../agents/cloud-customization-redaction";
import { closeZerosDb, openZerosDb, setZerosDbPathForTesting } from "../db";
import { upsertChat } from "../db/chats";
import { getTurn } from "../db/turns";
import { closeState, setStateRootForTesting } from "../git";
import { CloudActorAuthorityRegistry } from "../agents/cloud-actor-authority";
import { CloudLocalAgentBootRuntime } from "../cloud-local-command-queue-boot";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { CloudLocalCommandEventStore } from "../cloud-local-command-queue-events";
import { CloudEventRuntime } from "../cloud-event-runtime";
import type { CloudLocalCommandHistoryCapture } from "../cloud-local-command-queue-history";

const methods = ZerosEngine.prototype as unknown as Record<
  "initializeCloudAgentBoot" | "persistUserPrompt" | "persistSessionUpdate" | "beginTurn" | "finishTurn",
  (this: unknown, ...args: unknown[]) => unknown
>;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  native.execution = null;
  closeState(); setStateRootForTesting(null); closeZerosDb(); setZerosDbPathForTesting(null);
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(provider: "claude" | "codex" | "cursor", secrets: string[] = []) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "zeros-turn-capture-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "workspace"); mkdirSync(root);
  setZerosDbPathForTesting(path.join(directory, "normal.sqlite"));
  setStateRootForTesting(path.join(directory, "git-state"));
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1,
    engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(),
    fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const conversationId = randomUUID(), actorSessionId = randomUUID(), executionId = randomUUID();
  const commandId = randomUUID(), userMessageId = randomUUID(), now = Date.now();
  const redactor = new CloudCustomizationRedactor(secrets);
  native.execution = { provider, executionId, redactor };
  const pin = AgentGateway.prototype.pinCloudHistoryRedactor as
    (this: unknown, provider: string, executionId: string) => ReturnType<AgentGateway["pinCloudHistoryRedactor"]>;
  const filter = pin.call({ executionBoundary: { backend: "cloud-worker" }, disposed: false,
    executionBoundaries: new Map([[executionId, {}]]) }, provider, executionId);
  expect(filter).not.toBeNull();
  // Only selection of the original run is modeled. Its production pinned
  // filter, NORMAL writes, turn settlement and FULL capture remain real.
  native.execution = null;
  upsertChat({ id: conversationId, folder: root, agentId: provider, agentName: provider, model: "fixture-model",
    effort: "", permissionMode: "default", lastModeId: null, prePlanModeId: null, fast: false,
    additionalDirectories: [], title: "Synthetic history", createdAt: now, updatedAt: now, sessionId: null,
    pinned: false, archived: false, sourceChatId: null, kind: null });
  const actors = new CloudActorAuthorityRegistry({ scope, engineLive: () => true });
  cleanups.push(() => actors.dispose());
  actors.confirm({ scope, actorSessionId, authorityEpoch: 1, confirmedUntilMs: now + 9_000,
    fundingConsentVersion: 1, fundingGrant: { kind: "owner" }, actor: { userId: scope.fundingOwnerUserId,
      deviceId: randomUUID(), deviceKeyVersion: 1, fingerprint: "a".repeat(64), role: "owner" } });
  const state = { root, cloudWorker: { version: 4 }, cloudAgentBoot: null as CloudLocalAgentBootRuntime | null,
    cloudAgentLegacyFactory: {}, cloudRuntimeConfig: { execution: scope, engine: { instanceId: scope.engineInstanceId } },
    cloudRuntimeRegistration: { runtimeBootId: scope.bootId, localCommandsNegotiated: () => true, acceptedWorkNegotiated: () => false },
    restoreCloudLocalHistory: vi.fn(async () => {}), cloudLocalEvents: null as CloudLocalCommandEventStore | null,
    cloudEvents: null as CloudEventRuntime | null,
    cloudHistoryRedactors: new Map<string, NonNullable<ReturnType<AgentGateway["pinCloudHistoryRedactor"]>>>([[commandId, filter!]]),
    sessionAgent: new Map([[executionId, provider]]), sessionChat: new Map([[executionId, conversationId]]),
    sessionMessages: new Map(), sessionUpdateBatcher: { flush: vi.fn() }, scheduleMessagesChanged: vi.fn(), broadcast: vi.fn() };
  Object.setPrototypeOf(state, ZerosEngine.prototype);
  // Use the production engine adapter callbacks without booting a provider or
  // changing any source persistence method, queue or capture implementation.
  vi.spyOn(CloudLocalAgentBootRuntime.prototype, "initialize").mockResolvedValue(true);
  await methods.initializeCloudAgentBoot.call(state);
  const options = (state.cloudAgentBoot as unknown as { options: ConstructorParameters<typeof CloudLocalAgentBootRuntime>[0] }).options;
  const captures: CloudLocalCommandHistoryCapture[] = [];
  const file = path.join(directory, "queue.sqlite");
  const queue = new CloudLocalCommandQueue({ file, scope, actors, engineLive: () => true, ready: () => true,
    history: options.history, captureHistory: input => {
      const capture = options.captureHistory!(input); captures.push(capture); return capture;
    } });
  cleanups.push(() => queue.close());
  state.cloudLocalEvents = new CloudLocalCommandEventStore({ file, queue, engineLive: () => true });
  cleanups.push(() => state.cloudLocalEvents!.close());
  const request = vi.fn(async () => { throw new Error("Unexpected CP event request"); });
  state.cloudEvents = new CloudEventRuntime(scope.engineInstanceId, { request, onFailure: vi.fn() });
  cleanups.push(() => state.cloudEvents!.close());
  await state.cloudEvents.installLocalStore(state.cloudLocalEvents);
  queue.handle({ kind: "mutate", admissionError: null, mutation: { conversationId, operationId: randomUUID(), expectedRevision: 0,
    action: { kind: "enqueue", commandId, payload: { agentId: provider, model: "fixture-model", modeRevision: 0,
      userMessageId, prompt: [{ type: "text", text: "Synthetic prompt" }] } } } }, { actorSessionId, writerEpoch: scope.writerEpoch });
  const claim = CloudBootCommandClaimSchema.parse(queue.handle({ kind: "claim", conversationId,
    claimId: randomUUID(), executionId }, { writerEpoch: scope.writerEpoch }));
  async function turn(reply = "Synthetic reply") {
    methods.persistUserPrompt.call(state, executionId, claim.payload.prompt, undefined, userMessageId, now);
    const turnContext = await methods.beginTurn.call(state, executionId, userMessageId, now);
    expect(turnContext).not.toBeNull();
    methods.persistSessionUpdate.call(state, executionId, { sessionId: executionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } });
    await methods.finishTurn.call(state, turnContext, "completed", "end_turn");
    expect(getTurn(conversationId, userMessageId)).toMatchObject({ status: "completed", agentId: provider });
  }
  function controls() {
    const permissionId = randomUUID();
    state.cloudLocalEvents!.bindControlOwner(permissionId, "permission", claim);
    state.cloudEvents!.capture(createMessage({ type: "AGENT_PERMISSION_REQUEST", source: "engine", agentId: provider,
      chatId: conversationId, permissionId, request: { sessionId: executionId, executionId,
        toolCall: { toolCallId: "synthetic-tool", title: "Read source" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } }));
    state.cloudEvents!.capture(createMessage({ type: "AGENT_PERMISSION_SETTLED", source: "engine", agentId: provider,
      chatId: conversationId, permissionId, sessionId: executionId, executionId }));
  }
  function settle() {
    queue.handle({ kind: "settle", result: { commandId, claimId: claim.claimId, state: "succeeded", resultCode: null,
      result: { version: 1, terminal: { commandId, conversationId, executionId, turnId: userMessageId, agentId: provider,
        status: "completed", stopReason: "end_turn", startedAt: now, endedAt: Date.now(), response: { stopReason: "end_turn" } } } } },
    { writerEpoch: scope.writerEpoch });
    return queue.currentHistoryHead(conversationId)!;
  }
  return { state, queue, claim, captures, turn, controls, settle, request };
}

describe("cloud history captured after the production turn persistence path", () => {
  it.each(["claude", "codex", "cursor"] as const)("publishes a complete %s transcript after a normal turn", async provider => {
    const f = await fixture(provider); await f.turn();
    const head = f.settle();
    expect(head.history).toHaveProperty("manifestSha256");
    expect(f.captures).toHaveLength(1);
    expect(f.captures[0]!.manifest?.source).toMatchObject({ commandId: f.claim.commandId,
      intent: { userMessageId: f.claim.payload.userMessageId, agentId: provider } });
    expect(f.captures[0]!.documents.map(value => value.canonicalDocument).join("\n")).toContain("Synthetic reply");
    expect(openZerosDb().pragma("synchronous", { simple: true })).toBe(1);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("includes actual compact controls under the same event head at settlement", async () => {
    const f = await fixture("claude"); await f.turn(); f.controls();
    expect(f.state.cloudEvents!.cursor.sequence).toBe(f.state.cloudLocalEvents!.head);
    const head = f.settle();
    expect(head.history).toHaveProperty("manifestSha256");
    expect(f.captures[0]!.manifest?.records.filter(row => row.entityKind === "control")).toHaveLength(2);
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(["e-synthetic-private-value", "claude"])("keeps exact routing proof when a configured literal overlaps it (%s)", async literal => {
    const f = await fixture("claude", [literal]); await f.turn(`Synthetic reply: ${literal}`); f.controls();
    const head = f.settle();
    expect(head.history).toHaveProperty("manifestSha256");
    expect(f.captures[0]!.manifest?.source).toMatchObject({ commandId: f.claim.commandId,
      intent: { userMessageId: f.claim.payload.userMessageId, agentId: "claude" } });
    const messages = f.captures[0]!.documents.map(value => JSON.parse(value.canonicalDocument) as { entityKind?: string; document?: { payload?: string } })
      .filter(value => value.entityKind === "message").map(value => value.document?.payload).join("\n");
    expect(messages).toContain("[redacted]");
    expect(messages).not.toContain(literal);
    for (const document of f.captures[0]!.documents)
      expect(assembleCloudHistoryDocument(document.parts).canonicalDocument).toBe(document.canonicalDocument);
  });
  it.each(["chat", "message", "turn", "control"] as const)("still refuses changed %s proof after content redaction", async kind => {
    const f = await fixture("claude"); await f.turn(); f.controls();
    const original = f.state.cloudHistoryRedactors.get(f.claim.commandId)!;
    f.state.cloudHistoryRedactors.set(f.claim.commandId, (value, entityKind) => {
      const document = original(value, entityKind) as Record<string, unknown>;
      if (kind === "chat" && document.chat) return { ...document, chat: { ...document.chat as object, id: "foreign" } };
      if (kind === "message" && document.msgId) return { ...document, msgId: "foreign" };
      if (kind === "turn" && document.row) return { ...document, row: { ...document.row as object, agent_id: "foreign" } };
      if (kind === "control" && document.frame) return { ...document, frame: { ...document.frame as object, agentId: "foreign" } };
      return document;
    });
    const head = f.settle();
    expect(head.history).toMatchObject({ incompleteReason: "capture_conflict" });
    expect(f.captures[0]!.documents).toEqual([]);
    expect(f.captures[0]!.nativeResult).toMatchObject({ terminal: { status: "completed", agentId: "claude" } });
  });
  it("keeps a known native success but refuses unsupported history payloads", async () => {
    const f = await fixture("claude"); await f.turn();
    openZerosDb().prepare("UPDATE chat_messages SET payload=? WHERE msg_id=?")
      .run('{"kind":"unknown","text":"Synthetic content"}', f.claim.payload.userMessageId);
    const head = f.settle();
    expect(head.history).toMatchObject({ incompleteReason: "capture_unavailable" });
    expect(f.captures[0]!.documents).toEqual([]);
    expect(f.captures[0]!.nativeResult).toMatchObject({ terminal: { status: "completed" } });
  });
});
