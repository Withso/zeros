import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloudScopedId, parseCloudScopedId, isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { BLANK, mergeWindowedTail, useSessionsStore } from "../sessions-store";
import { reconcileHistoryMessages } from "../history-message-identity";
import { messageSnapshotsEqual, retainMessageReferences } from "../message-persistence-tracker";
import { canApplyTranscriptRead, isCurrentTranscriptRequest, releaseTranscriptRequest, NativeTranscriptSnapshots } from "../transcript-retention";
import type { AgentMessage } from "../use-agent-session";
import { useWorkspaceStore } from "../../../state/workspace-store";
import { forgetFreshCloudChat } from "../fresh-cloud-chats";
import { consumeFreshCloudChat } from "../fresh-cloud-chats";
import { localTranscriptCache } from "../../../state/local-transcript-cache";
import { presentCachedLocalTranscript, presentKnownEmptyLocalTranscript, takeFreshLocalChat } from "../local-transcript-presentation";
import { cloudHistoryFenceHasTranscript, cloudHistoryFencesMatch, type CloudHistoryRestoreFence } from "../../../platform/cloud-transcript-cache-contract";
const ast = ts.createSourceFile("sessions-provider.tsx", readFileSync(new URL("../sessions-provider.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "", reconcileCallback = "";
function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "hydrateChat" && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0]!.getText(ast);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "reconcileChatMessages" && node.initializer && ts.isCallExpression(node.initializer)) reconcileCallback = node.initializer.arguments[0]!.getText(ast);
  ts.forEachChild(node, collect);
}
collect(ast);
const code = ts.transpileModule(`globalThis.hydrate = ${callback};\nglobalThis.reconcile = ${reconcileCallback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const cloudId = cloudScopedId(target, "chat-a");
const message = (text: string): AgentMessage => ({ id: "m-1", kind: "text", role: "agent", text, createdAt: 1 });
// The callback harnesses share one mounted provider's native confirmations.
const nativeTranscriptSnapshotsRef = { current: new NativeTranscriptSnapshots() };
function harness(chatId = cloudId, native = false, source = native ? "native" : "control-plane") {
  let current = true;
  let restoreHead: CloudHistoryRestoreFence | undefined;
  let requestedHead: CloudHistoryRestoreFence | undefined, responseHead: CloudHistoryRestoreFence | undefined;
  let resolve!: (rows: AgentMessage[]) => void, reject!: (error: Error) => void;
  const server = new Promise<AgentMessage[]>((done, fail) => { resolve = done; reject = fail; });
  const history = vi.fn((_id: string, _limit: number, _before?: number, onCached?: (rows: AgentMessage[]) => void) => {
    requestedHead = restoreHead;
    queueMicrotask(() => onCached?.([message("cached")])); return server;
  });
  const snapshotHistory = vi.fn(async (id: string, limit: number, before?: number,
    onCached?: (page: { messages: AgentMessage[]; source: "cache"; restoreHead?: CloudHistoryRestoreFence }) => void) => {
    const cachedHead = restoreHead;
    const messages = await history(id, limit, before, onCached ? rows => onCached({ messages: rows, source: "cache", restoreHead: cachedHead }) : undefined);
    return { messages, source, restoreHead: responseHead ?? requestedHead, isCurrent: () => current };
  });
  const requests = new Map<string, Promise<void>>();
  const repair = vi.fn(async () => {});
  const retry = vi.fn(async () => {});
  const context: Record<string, unknown> = { console: { warn: vi.fn() }, BLANK, parseCloudScopedId, isCloudWorkspace, cloudComputerV2: true,
    HYDRATE_WINDOW: 200, reconcileHistoryMessages, messageSnapshotsEqual, retainMessageReferences, isCurrentTranscriptRequest, releaseTranscriptRequest,
    canApplyTranscriptRead, mergeWindowedTail, canBackgroundSyncCloudWorkspace: () => true, reconcileInFlightRef: { current: new Map() },
    getStore: useSessionsStore.getState, bridge: { status: "connected" }, reconcileChatMessages: vi.fn(), persistWindowMessages: history,
    persistMessageWindow: snapshotHistory,
    cloudHistoryRestoreHead: () => restoreHead, cloudHistoryFenceHasTranscript, cloudHistoryFencesMatch, cloudHasNativeTranscript: () => native,
    hydrateCloudSendRef: { current: repair }, reconcileChatMessagesRef: { current: retry }, nativeTranscriptSnapshotsRef,
    hydrateInFlightRef: { current: requests }, pendingHydratesRef: { current: new Set() },
    localTranscriptCache, presentCachedLocalTranscript, presentKnownEmptyLocalTranscript, takeFreshLocalChat, consumeFreshCloudChat,
    useWorkspaceStore: { getState: () => ({ chats: [] }) } };
  vm.runInNewContext(code, context);
  return { resolve: (rows: AgentMessage[], head?: CloudHistoryRestoreFence) => { responseHead = head; resolve(rows); },
    reject, requests, history, repair, retry, hydrate: context.hydrate as (id: string) => Promise<void>, reconcile: context.reconcile as (id: string) => Promise<void>, chatId,
    retireRead: () => { current = false; },
    setHead: (head: CloudHistoryRestoreFence) => { restoreHead = head; } };
}
beforeEach(() => { useSessionsStore.getState().clearAll(); nativeTranscriptSnapshotsRef.current = new NativeTranscriptSnapshots(); });
const incomplete: CloudHistoryRestoreFence = { conversationId: "chat-a", projection: { ...target, generation: 2,
  engineInstanceId: "33333333-3333-4333-8333-333333333333", bootId: "44444444-4444-4444-8444-444444444444",
  writerEpoch: "55555555-5555-4555-8555-555555555555", fundingOwnerUserId: "66666666-6666-4666-8666-666666666666",
  fundingOwnerEpoch: 1, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", mirroredSequence: 10, sealedSequence: null, complete: false },
  head: { conversationId: "chat-a", originWriterEpoch: "55555555-5555-4555-8555-555555555555",
    source: { kind: "mutation", mutationId: "77777777-7777-4777-8777-777777777777", operation: "edit" }, restoreRevision: 2, deleted: false,
    recordSequence: null, eventSequence: null, manifestSha256: null, incompleteReason: "history_limit" } };
describe("production initial transcript hydration", () => {
  it("uses the actual ADD_CHAT lifecycle to hydrate a new cloud chat as empty", async () => {
    const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {} });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    try {
      useWorkspaceStore.setState({ chats: [] }); forgetFreshCloudChat(cloudId);
      useWorkspaceStore.getState().dispatch({ type: "ADD_CHAT", chat: { id: cloudId, folder, agentId: "codex", agentName: "Codex",
        model: null, effort: "high", permissionMode: "auto", title: "New chat", createdAt: 1, updatedAt: 1 } });
      useSessionsStore.getState().setSession(cloudId, { ...BLANK, cwd: folder, transcriptState: "cold" });
      const h = harness(); await h.hydrate(cloudId);
      expect(h.history).not.toHaveBeenCalled();
      expect(useSessionsStore.getState().sessions[cloudId]).toMatchObject({ transcriptState: "resident", messages: [], hasTranscript: false });
      expect(consumeFreshCloudChat(cloudId, folder)).toBe(false);
    } finally { forgetFreshCloudChat(cloudId); vi.unstubAllGlobals(); }
  });

  it("keeps the last confirmed transcript and optimistic send when provisional cache precedes a conflict", async () => {
    const confirmed = [message("Confirmed answer"), { id: "queued", kind: "text" as const, role: "user" as const,
      text: "New request", queued: true, createdAt: 2 }];
    useSessionsStore.getState().setSession(cloudId, { ...BLANK,
      cwd: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
      transcriptState: "loading", hasTranscript: true, messages: confirmed });
    const h = harness(), pending = h.hydrate(cloudId);
    await Promise.resolve();
    const during = useSessionsStore.getState().sessions[cloudId].messages;
    h.reject(Object.assign(new Error("command_conflict"), { code: "command_conflict" }));
    await pending;
    expect(during).toBe(confirmed);
    expect(useSessionsStore.getState().sessions[cloudId].messages).toBe(confirmed);
    expect(useSessionsStore.getState().sessions[cloudId].transcriptState).toBe("loading");
  });

  it("retains cached history when a legacy cloud projection returns an empty window after resume", async () => {
    const h = harness(), result = h.hydrate(h.chatId);
    await Promise.resolve();
    const cached = useSessionsStore.getState().sessions[h.chatId]!.messages;
    expect(cached).toEqual([message("cached")]);
    h.resolve([]); await result;
    const slot = useSessionsStore.getState().sessions[h.chatId]!;
    expect(slot.messages).toBe(cached);
    expect(slot.transcriptState).toBe("loading");
    expect(slot.transcriptPresentation?.source).toBe("cache");
    expect(slot.hasTranscript).toBe(true);
  });

  it("still accepts a confirmed empty native history window", async () => {
    const h = harness(cloudId, true), result = h.hydrate(h.chatId);
    await Promise.resolve();
    h.resolve([]); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]).toMatchObject({ messages: [], transcriptState: "resident", hasTranscript: false });
  });

  it("cannot borrow successor authority from a global head that the returned page did not verify", async () => {
    const a: CloudHistoryRestoreFence = { ...incomplete, head: { ...incomplete.head!, recordSequence: 4, eventSequence: 8,
      manifestSha256: "a".repeat(64), incompleteReason: null } };
    const b = { ...a, projection: { ...a.projection, bootId: "88888888-8888-4888-8888-888888888888" } };
    const h = harness(); h.setHead(a);
    const result = h.hydrate(h.chatId); await Promise.resolve();
    expect(useSessionsStore.getState().sessions[h.chatId]?.transcriptPresentation?.restoreHead).toEqual(a);
    // A global observation may come from disk; only the page's own receipt or
    // the authenticated head subscriber can establish boot continuity.
    h.setHead(b); h.resolve([message("old page A")], a); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]).toMatchObject({ messages: [], transcriptPresentation: null, transcriptState: "loading" });
    expect(h.repair).toHaveBeenCalledExactlyOnceWith(h.chatId);
  });
  it("does not relabel an incomplete CP result as native because a native execution exists after the await", async () => {
    const h = harness(cloudId, true, "control-plane"); h.setHead(incomplete);
    const result = h.hydrate(h.chatId); h.resolve([]); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]).toMatchObject({ messages: [], transcriptState: "loading", hasTranscript: true });
  });
  it("keeps an empty resumed native window unknown when its current restore head is incomplete", async () => {
    const h = harness(cloudId, true); h.setHead(incomplete);
    const result = h.hydrate(h.chatId); h.resolve([]); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]).toMatchObject({ messages: [], transcriptState: "loading", hasTranscript: true });
  });
  it("keeps preserved current native rows without promoting an incomplete FULL head", async () => {
    const h = harness(cloudId, true);
    const head: CloudHistoryRestoreFence = { ...incomplete, head: { ...incomplete.head!, incompleteReason: "capture_unavailable" } };
    h.setHead(head);
    const result = h.hydrate(h.chatId);
    useSessionsStore.getState().applyCloudHistoryRestoreHead(h.chatId, head);
    const rows = Array.from({ length: 17 }, (_, index) => ({ ...message(`Preserved native row ${index}`), id: `preserved-${index}` }));
    h.resolve(rows); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]).toMatchObject({
      messages: rows, transcriptState: "resident", transcriptPresentation: null, hasTranscript: true,
    });
    const retained = useSessionsStore.getState().cloudHistoryRestoreHeads[h.chatId];
    expect(retained).toEqual(head);
    expect(cloudHistoryFenceHasTranscript(retained!)).toBe(false);
    expect(retained?.head?.manifestSha256).toBeNull();
  });
  it("repairs an already resident empty slot when a revalidation proves its native restore is incomplete", async () => {
    const h = harness(cloudId, true); h.setHead(incomplete);
    useSessionsStore.getState().setSession(h.chatId, { ...BLANK, transcriptState: "resident", messages: [] });
    const result = h.reconcile(h.chatId); h.resolve([]); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]).toMatchObject({ messages: [], transcriptState: "loading", hasTranscript: true });
  });
  it("installs the first page's own verified head without a second history read", async () => {
    const head: CloudHistoryRestoreFence = { ...incomplete, head: { ...incomplete.head!, recordSequence: 1, eventSequence: 2,
      manifestSha256: "b".repeat(64), incompleteReason: null } };
    const h = harness(), result = h.hydrate(h.chatId); await Promise.resolve();
    h.setHead(head); useSessionsStore.getState().applyCloudHistoryRestoreHead(h.chatId, head);
    h.resolve([message("verified first page")], head); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]).toMatchObject({ messages: [message("verified first page")], transcriptState: "resident" });
    expect(h.repair).not.toHaveBeenCalled();
  });
  it("preserves message references when validation confirms the cached presentation unchanged", async () => {
    const h = harness(), result = h.hydrate(h.chatId); await Promise.resolve();
    const messages = useSessionsStore.getState().sessions[h.chatId]!.messages;
    h.resolve([message("cached")]); await result;
    expect(useSessionsStore.getState().sessions[h.chatId]!.messages).toBe(messages);
    expect(useSessionsStore.getState().sessions[h.chatId]!.transcriptState).toBe("resident");
  });
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
    expect(useSessionsStore.getState().sessions[h.chatId]).toMatchObject({ transcriptPresentation: { source: "cache" } });
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


it("ARCH: retains positive native rows when an empty same-head revalidation remains incomplete", async () => {
  const h = harness(cloudId, true); h.setHead(incomplete);
  const messages = [message("Preserved sealed native row")];
  const hydrated = h.hydrate(h.chatId);
  useSessionsStore.getState().applyCloudHistoryRestoreHead(h.chatId, incomplete);
  h.resolve(messages); await hydrated;
  expect(useSessionsStore.getState().sessions[h.chatId]).toMatchObject({ messages, transcriptState: "resident", transcriptPresentation: null });
  const reread = harness(cloudId, true); reread.setHead(incomplete);
  const result = reread.reconcile(reread.chatId); reread.resolve([]); await result;
  expect(useSessionsStore.getState().sessions[h.chatId]!.messages).toEqual(messages);
  expect(cloudHistoryFenceHasTranscript(useSessionsStore.getState().cloudHistoryRestoreHeads[h.chatId]!)).toBe(false);
});

it.each(["streaming", "ready"] as const)("ARCH189: empty same-head native reply cannot erase a newer %s turn", async status => {
  const first = harness(cloudId, true); first.setHead(incomplete);
  const hydration = first.hydrate(cloudId);
  useSessionsStore.getState().applyCloudHistoryRestoreHead(cloudId, incomplete);
  first.resolve([message("Prior confirmed native history")]); await hydration;
  const reread = harness(cloudId, true); reread.setHead(incomplete);
  const result = reread.reconcile(cloudId);
  const before = useSessionsStore.getState().sessions[cloudId]!;
  useSessionsStore.getState().patchSession(cloudId, { status, messages: [
    ...before.messages, { ...message("New native turn output"), id: "m-live" },
  ] });
  const current = useSessionsStore.getState().sessions[cloudId]!;
  reread.resolve([]); await result;
  expect(useSessionsStore.getState().sessions[cloudId]!.messages).toEqual(current.messages);
  expect(useSessionsStore.getState().sessions[cloudId]).toBe(current);
  expect(reread.retry).toHaveBeenCalledTimes(status === "ready" ? 1 : 0);
});

describe("confirmed native snapshot revalidation", () => {
  async function confirmed() {
    const h = harness(cloudId, true); h.setHead(incomplete);
    const result = h.hydrate(h.chatId);
    useSessionsStore.getState().applyCloudHistoryRestoreHead(h.chatId, incomplete);
    h.resolve([message("Confirmed native history")]); await result;
    return h;
  }

  it("retains the exact array through repeated empty same-head reads without completing the projection", async () => {
    await confirmed();
    const before = useSessionsStore.getState().sessions[cloudId]!;
    for (let index = 0; index < 3; index++) {
      const h = harness(cloudId, true); h.setHead(incomplete);
      const result = h.reconcile(cloudId); h.resolve([]); await result;
      expect(useSessionsStore.getState().sessions[cloudId]).toBe(before);
      expect(cloudHistoryFenceHasTranscript(useSessionsStore.getState().cloudHistoryRestoreHeads[cloudId]!)).toBe(false);
    }
  });

  it("keeps confirmed native rows when local queued intent has changed the resident array", async () => {
    await confirmed();
    const store = useSessionsStore.getState();
    const messages: AgentMessage[] = [...store.sessions[cloudId]!.messages,
      { id: "queued-next", kind: "text", role: "user", text: "Continue", createdAt: 2, queued: true }];
    store.patchSession(cloudId, { messages });
    const h = harness(cloudId, true); h.setHead(incomplete);
    const result = h.reconcile(cloudId); h.resolve([]); await result;
    expect(useSessionsStore.getState().sessions[cloudId]!.messages).toBe(messages);
  });

  it.each(["executionId", "sessionId"] as const)("an old empty read cannot clear a replacement native %s", async field => {
    await confirmed();
    const h = harness(cloudId, true); h.setHead(incomplete);
    const result = h.reconcile(cloudId);
    const before = useSessionsStore.getState().sessions[cloudId]!;
    useSessionsStore.getState().patchSession(cloudId, { [field]: "replacement", status: "streaming", messages: [
      ...before.messages, { ...message("New execution output"), id: "m-replacement" },
    ] });
    const current = useSessionsStore.getState().sessions[cloudId]!;
    h.resolve([]); await result;
    expect(useSessionsStore.getState().sessions[cloudId]).toBe(current);
    expect(h.retry).not.toHaveBeenCalled();
  });

  it("rechecks a ready successor after the stale read without detaching its waiters", async () => {
    await confirmed();
    const h = harness(cloudId, true); h.setHead(incomplete);
    let finishRetry!: () => void;
    h.retry.mockImplementationOnce(() => new Promise<void>(resolve => { finishRetry = resolve; }));
    const result = h.reconcile(cloudId);
    let settled = false;
    void result.then(() => { settled = true; });
    const before = useSessionsStore.getState().sessions[cloudId]!;
    useSessionsStore.getState().patchSession(cloudId, { messages: [
      ...before.messages, { ...message("Settled native output"), id: "m-settled" },
    ] });
    const current = useSessionsStore.getState().sessions[cloudId]!;
    h.resolve([]);
    await vi.waitFor(() => expect(h.retry).toHaveBeenCalledExactlyOnceWith(cloudId));
    expect(settled).toBe(false);
    expect(useSessionsStore.getState().sessions[cloudId]).toBe(current);
    finishRetry(); await result;
    expect(settled).toBe(true);
  });

  it("does not infer native confirmation from an already resident CP or legacy presentation", async () => {
    for (const presentation of [null, { source: "control-plane" as const, restoreHead: incomplete }]) {
      useSessionsStore.getState().setSession(cloudId, { ...BLANK, messages: [message("Unconfirmed projection")],
        transcriptState: "resident", transcriptPresentation: presentation });
      useSessionsStore.setState({ cloudHistoryRestoreHeads: { [cloudId]: incomplete } });
      const h = harness(cloudId, true); h.setHead(incomplete);
      const result = h.reconcile(cloudId); h.resolve([]); await result;
      expect(useSessionsStore.getState().sessions[cloudId]).toMatchObject({ messages: [], transcriptState: "loading" });
    }
  });

  it.each(["edit", "prune", "delete", "repair"] as const)("honors a newer %s head after native confirmation", async operation => {
    await confirmed();
    const next: CloudHistoryRestoreFence = { ...incomplete, head: { ...incomplete.head!, restoreRevision: 3,
      deleted: operation === "delete", source: { kind: "mutation", mutationId: "99999999-9999-4999-8999-999999999999", operation } } };
    const h = harness(cloudId, true); h.setHead(next);
    const result = h.reconcile(cloudId); h.resolve([]); await result;
    expect(useSessionsStore.getState().sessions[cloudId]).toMatchObject({ messages: [],
      transcriptState: operation === "delete" ? "resident" : "loading" });
    expect(useSessionsStore.getState().cloudHistoryRestoreHeads[cloudId]).toEqual(next);
  });

  it.each(["edit", "prune", "delete", "repair"] as const)("a concurrent native update does not bypass a newer %s fence", async operation => {
    await confirmed();
    const h = harness(cloudId, true); h.setHead(incomplete);
    const result = h.reconcile(cloudId);
    const before = useSessionsStore.getState().sessions[cloudId]!;
    useSessionsStore.getState().patchSession(cloudId, { status: "streaming", messages: [
      ...before.messages, { ...message("Native output before the fence"), id: "m-before-fence" },
    ] });
    const next: CloudHistoryRestoreFence = { ...incomplete, head: { ...incomplete.head!, restoreRevision: 3,
      deleted: operation === "delete", source: { kind: "mutation", mutationId: "99999999-9999-4999-8999-999999999999", operation } } };
    h.setHead(next); h.resolve([]); await result;
    expect(useSessionsStore.getState().sessions[cloudId]!.messages).toEqual([]);
    expect(useSessionsStore.getState().cloudHistoryRestoreHeads[cloudId]).toEqual(next);
  });

  it.each(["bootId", "writerEpoch", "fundingOwnerEpoch"] as const)("does not carry native confirmation across %s", async field => {
    await confirmed();
    const next: CloudHistoryRestoreFence = { ...incomplete, projection: { ...incomplete.projection,
      [field]: field === "fundingOwnerEpoch" ? 2 : "99999999-9999-4999-8999-999999999999" } };
    const h = harness(cloudId, true); h.setHead(next);
    const result = h.reconcile(cloudId); h.resolve([]); await result;
    expect(useSessionsStore.getState().sessions[cloudId]).toMatchObject({ messages: [], transcriptState: "loading" });
  });

  it("does not reuse a positive native read after its account or access receipt retires", async () => {
    const first = await confirmed(); first.retireRead();
    const h = harness(cloudId, true); h.setHead(incomplete);
    const result = h.reconcile(cloudId); h.resolve([]); await result;
    expect(useSessionsStore.getState().sessions[cloudId]).toMatchObject({ messages: [], transcriptState: "loading" });
  });

  it("ignores an empty read whose own access receipt retires before delivery", async () => {
    await confirmed();
    const before = useSessionsStore.getState().sessions[cloudId];
    const h = harness(cloudId, true); h.setHead(incomplete);
    const result = h.reconcile(cloudId); h.retireRead(); h.resolve([]); await result;
    expect(useSessionsStore.getState().sessions[cloudId]).toBe(before);
    expect(h.repair).toHaveBeenCalledExactlyOnceWith(cloudId);
  });

  it.each(["executionId", "sessionId", "cwd"] as const)("native confirmation remains bound to %s", field => {
    const snapshots = new NativeTranscriptSnapshots();
    const slot = { ...BLANK, transcriptState: "resident" as const, messages: [message("Confirmed row")] };
    snapshots.confirm(cloudId, slot, incomplete, () => true);
    expect(snapshots.matches(cloudId, slot, incomplete)).toBe(true);
    expect(snapshots.matches(cloudId, { ...slot, [field]: "other" }, incomplete)).toBe(false);
    expect(snapshots.matches(cloudScopedId(target, "chat-b"), slot, incomplete)).toBe(false);
  });
});
