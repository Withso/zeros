import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloudScopedId, parseCloudScopedId, isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { BLANK, useSessionsStore } from "../sessions-store";
import { reconcileHistoryMessages } from "../history-message-identity";
import { seedPersistedMessageRefs } from "../message-persistence-tracker";
import { isCurrentTranscriptRequest, releaseTranscriptRequest } from "../transcript-retention";
import type { AgentMessage } from "../use-agent-session";
import { cloudHistoryFenceHasTranscript, cloudHistoryFencesMatch, type CloudHistoryRestoreFence } from "../../../platform/cloud-transcript-cache-contract";
const ast = ts.createSourceFile("sessions-provider.tsx", readFileSync(new URL("../sessions-provider.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "";
function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "hydrateChat" && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0]!.getText(ast);
  ts.forEachChild(node, collect);
}
collect(ast);
const code = ts.transpileModule(`globalThis.hydrate = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const cloudId = cloudScopedId(target, "chat-a");
const message = (text: string): AgentMessage => ({ id: "m-1", kind: "text", role: "agent", text, createdAt: 1 });
function harness(chatId = cloudId, native = false) {
  let restoreHead: CloudHistoryRestoreFence | undefined;
  let resolve!: (rows: AgentMessage[]) => void;
  const server = new Promise<AgentMessage[]>(done => { resolve = done; });
  const history = vi.fn((_id: string, _limit: number, _before?: number, onCached?: (rows: AgentMessage[]) => void) => {
    queueMicrotask(() => onCached?.([message("cached")])); return server;
  });
  const requests = new Map<string, Promise<void>>();
  const repair = vi.fn(async () => {});
  const context: Record<string, unknown> = { console: { warn: vi.fn() }, BLANK, parseCloudScopedId, isCloudWorkspace, cloudComputerV2: true,
    HYDRATE_WINDOW: 200, reconcileHistoryMessages, seedPersistedMessageRefs, isCurrentTranscriptRequest, releaseTranscriptRequest,
    getStore: useSessionsStore.getState, bridge: { status: "connected" }, reconcileChatMessages: vi.fn(), persistWindowMessages: history,
    cloudHistoryRestoreHead: () => restoreHead, cloudHistoryFenceHasTranscript, cloudHistoryFencesMatch, cloudHasNativeTranscript: () => native,
    hydrateCloudSendRef: { current: repair },
    hydrateInFlightRef: { current: requests }, pendingHydratesRef: { current: new Set() }, persistedMessageRefsRef: { current: new Map() } };
  vm.runInNewContext(code, context);
  return { resolve, requests, history, repair, hydrate: context.hydrate as (id: string) => Promise<void>, chatId,
    setHead: (head: CloudHistoryRestoreFence) => { restoreHead = head; } };
}
beforeEach(() => { useSessionsStore.getState().clearAll(); });
const incomplete: CloudHistoryRestoreFence = { conversationId: "chat-a", projection: { ...target, generation: 2,
  engineInstanceId: "33333333-3333-4333-8333-333333333333", bootId: "44444444-4444-4444-8444-444444444444",
  writerEpoch: "55555555-5555-4555-8555-555555555555", fundingOwnerUserId: "66666666-6666-4666-8666-666666666666",
  fundingOwnerEpoch: 1, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", mirroredSequence: 10, sealedSequence: null, complete: false },
  head: { conversationId: "chat-a", originWriterEpoch: "55555555-5555-4555-8555-555555555555",
    source: { kind: "mutation", mutationId: "77777777-7777-4777-8777-777777777777", operation: "edit" }, restoreRevision: 2, deleted: false,
    recordSequence: null, eventSequence: null, manifestSha256: null, incompleteReason: "history_limit" } };
describe("production initial transcript hydration", () => {
  it("does not install complete page A after a newer complete repair B crosses the outer await", async () => {
    const a: CloudHistoryRestoreFence = { ...incomplete, head: { ...incomplete.head!, recordSequence: 4, eventSequence: 8,
      manifestSha256: "a".repeat(64), incompleteReason: null } };
    const b: CloudHistoryRestoreFence = { ...a, projection: { ...a.projection, mirroredSequence: 20 },
      head: { ...a.head!, restoreRevision: 3, recordSequence: 5, eventSequence: 9, manifestSha256: "b".repeat(64) } };
    const h = harness(); h.setHead(a);
    const result = h.hydrate(h.chatId); await Promise.resolve();
    h.setHead(b); useSessionsStore.getState().applyCloudHistoryRestoreHead(h.chatId, b);
    h.resolve([message("old page A")]); await result;
    expect(useSessionsStore.getState().cloudHistoryRestoreHeads[h.chatId]).toEqual(b);
    expect(useSessionsStore.getState().sessions[h.chatId]?.messages).toEqual([]);
    expect(h.repair).toHaveBeenCalledExactlyOnceWith(h.chatId);
  });
  it("accepts the current complete head without an extra retry or comparing VM revisions", async () => {
    const b: CloudHistoryRestoreFence = { ...incomplete, head: { ...incomplete.head!, recordSequence: 1, eventSequence: 2,
      manifestSha256: "b".repeat(64), incompleteReason: null } };
    const h = harness(); h.setHead(b);
    const result = h.hydrate(h.chatId); h.resolve([message("current page B")]); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]).toMatchObject({ messages: [message("current page B")], transcriptState: "resident" });
    expect(h.repair).not.toHaveBeenCalled();
  });
  it("does not relabel an older read after a VM repair on the same warm native execution", async () => {
    const a: CloudHistoryRestoreFence = { ...incomplete, head: { ...incomplete.head!, recordSequence: 4, eventSequence: 8,
      manifestSha256: "a".repeat(64), incompleteReason: null } };
    const b: CloudHistoryRestoreFence = { ...a, head: { ...a.head!, restoreRevision: 3,
      recordSequence: 5, eventSequence: 9, manifestSha256: "b".repeat(64) } };
    const h = harness(cloudId, true); h.setHead(a);
    const result = h.hydrate(h.chatId); await Promise.resolve();
    h.setHead(b); useSessionsStore.getState().applyCloudHistoryRestoreHead(h.chatId, b);
    h.resolve([message("old warm page A")]); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]?.messages).toEqual([]);
    expect(h.repair).toHaveBeenCalledExactlyOnceWith(h.chatId);
  });
  it("keeps an authoritative incomplete head unknown after an empty older read resolves", async () => {
    const h = harness(), result = h.hydrate(h.chatId); await Promise.resolve();
    h.setHead(incomplete); useSessionsStore.getState().applyCloudHistoryRestoreHead(h.chatId, incomplete);
    h.resolve([]); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]).toMatchObject({ messages: [], transcriptState: "loading", hasTranscript: true });
  });
  it("cannot repaint a provisional old window after the newer head is already known", async () => {
    const h = harness(); h.setHead(incomplete);
    const result = h.hydrate(h.chatId); await Promise.resolve();
    expect(useSessionsStore.getState().sessions[h.chatId]?.messages).toEqual([]);
    h.resolve([]); await result;
  });
  it("paints cached cloud rows before the server resolves, then replaces them atomically", async () => {
    const h = harness(), result = h.hydrate(h.chatId);
    await Promise.resolve();
    expect(useSessionsStore.getState().sessions[h.chatId]?.messages).toEqual([message("cached")]);
    expect(useSessionsStore.getState().sessions[h.chatId]?.transcriptState).toBe("loading");
    h.resolve([message("new server")]); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]?.messages).toEqual([message("new server")]);
    expect(useSessionsStore.getState().sessions[h.chatId]?.transcriptState).toBe("resident");
  });
  it("keeps newer runtime-streamed messages when the older projection finishes", async () => {
    const h = harness(), result = h.hydrate(h.chatId); await Promise.resolve();
    useSessionsStore.getState().patchSession(h.chatId, { messages: [message("live stream")], transcriptState: "resident", status: "streaming" });
    h.resolve([message("older projection")]); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]?.messages).toEqual([message("live stream")]);
  });
  it("cannot resurrect a slot retired during account switch or apply into a replacement request", async () => {
    const h = harness(), result = h.hydrate(h.chatId);
    h.requests.delete(h.chatId); useSessionsStore.getState().removeSession(h.chatId);
    await Promise.resolve(); h.resolve([message("old account")]); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]).toBeUndefined();
  });
  it("leaves Personal Local and organization Local hydration on the authoritative path", async () => {
    for (const folder of ["/personal/checkout", "/organization/checkout"]) {
      const h = harness("local-chat"); useSessionsStore.getState().setSession(h.chatId, { ...BLANK, cwd: folder, transcriptState: "cold" });
      const result = h.hydrate(h.chatId); await Promise.resolve();
      expect(h.history.mock.calls[0]?.[3]).toBeUndefined();
      expect(useSessionsStore.getState().sessions[h.chatId]?.messages).toEqual([]);
      h.resolve([message("local disk")]); await result;
      expect(useSessionsStore.getState().sessions[h.chatId]?.messages).toEqual([message("local disk")]);
    }
  });
});
