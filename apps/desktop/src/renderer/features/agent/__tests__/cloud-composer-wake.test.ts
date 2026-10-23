import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../../team/control-plane";
import { cloudWorkspaceAccountAccess } from "../../team/cloud-workspace-account-access";
import { isCloudWorkspace, parseCloudWorkspaceKey, parseCloudScopedId } from "../../../platform/bridge/cloud-workspace-key";
import { isSubmittedComposerDocument } from "../composer-submission";
import * as lifecycle from "../session-reload-lifecycle";
import * as retention from "../transcript-retention";
import { BLANK, useSessionsStore } from "../sessions-store";
import { SendQueue } from "../send-queue";
import { CloudSendWait, CloudSendWaitError } from "../cloud-send-wait";
import { CloudSendPreparation } from "../cloud-send-preparation";
import { cloudQueuedPrompt } from "../cloud-queued-prompt";
import { isRecoverable } from "../../../platform/bridge/failure";
import { CloudWorkspaceWakeEndedError } from "../../../state/cloud-workspace-wake";
import { isCloudWorkspaceLifecyclePending } from "../../../state/cloud-workspace-catalog";
import { notifyAgentSendFailure } from "../agent-send-failure-toast";
import { hasBackgroundAgentWork } from "../background-task-state";
import { getFollowUpBehavior } from "../../settings/follow-up-behavior";
import { queuedTranscriptPresentation } from "./helpers/queued-transcript-presentation";
import { recoverPendingAutoSend } from "../../../state/persist-composer-drafts";
import { hasDesignFrameAttachmentSelection } from "../design-frame-selection";

const encoding = vi.hoisted(() => ({ run: vi.fn() }));
const mocks = vi.hoisted(() => ({ failureToast: vi.fn() }));
vi.mock("../../../shared/ui/primitives/elements/toast", () => ({ toast: { error: mocks.failureToast } }));
vi.mock("../encode-attachments", async original => ({ ...await original<typeof import("../encode-attachments")>(), encodeAttachments: encoding.run }));

const source = readFileSync(new URL("../agent-chat.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("composer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callbacks(sourceFile: ts.SourceFile, names: readonly string[]) {
  const declarations: string[] = [];
  function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text)) declarations.push(`const ${node.getText(sourceFile)};`);
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);
  return ts.transpileModule(declarations.join("\n") + `\nglobalThis.actions = {${names.join(",")}};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}
const composerCode = callbacks(ast, ["parkUnreadableTranscriptSend", "runSend", "handleSend", "saveQueuedEdit"]);
const providerSource = readFileSync(new URL("../sessions-provider.tsx", import.meta.url), "utf8");
const providerAst = ts.createSourceFile("provider.tsx", providerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const providerCode = callbacks(providerAst, ["pauseQueue", "resumeQueue", "retryCloudQueuedPrompt", "markQueuedDelivery", "refreshQueuedAttachments", "flushQueuedPrompt", "drainNextQueued",
  "sendPrompt", "beginCloudSendWait", "removeQueued", "editQueued", "getQueuedDraft", "holdQueue", "releaseQueue", "hydrateChat"]);

const waits: CloudSendWait[] = [];
beforeEach(() => {
  vi.useFakeTimers(); encoding.run.mockReset().mockResolvedValue({ blocks: [{ type: "text", text: "confirmed-file" }],
    bubbleAttachments: [{ name: "image.png", kind: "image", delivery: "reference", diskPath: ".context/image.png" }], bubbleAttachmentById: new Map(), skipped: [] });
});
afterEach(() => { for (const wait of waits.splice(0)) wait.clear(); vi.useRealTimers(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

function harness(cloud = true, status = "stopped", resident = true) {
  const folder = cloud ? "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222" : "/local";
  const wake = deferred(), initialize = deferred(), queue = new SendQueue<any>(), flush = new Map<string, string>();
  const doc = { status, generation: { number: 7 }, capabilities: { canWrite: true }, deletedAt: null, error: null as { message: string } | null };
  const slot: any = { agentId: "codex", cwd: folder, status: "warming", transcriptState: resident ? "resident" : "loading", messages: [], sessionId: null };
  const store = { sessions: { chat: slot } as Record<string, typeof slot>, patchSession: (id: string, patch: object) => Object.assign(store.sessions[id], patch),
    pendingLocalTurns: {} as Record<string, string>,
    setSession: (id: string, value: typeof slot) => { store.sessions[id] = value; },
    setPendingLocalTurn: vi.fn((id: string, turnId: string | null) => {
      if (turnId) store.pendingLocalTurns[id] = turnId; else delete store.pendingLocalTurns[id];
    }), hydrateChatPolicies: vi.fn(async () => {}) };
  const wait = new CloudSendWait(); waits.push(wait);
  const prepare = vi.fn<(chatId: string, wakeIntent?: { id: string }) => Promise<void>>(() => wake.promise), delivered = vi.fn(), toasts = { error: vi.fn(), warning: vi.fn(), info: vi.fn() };
  const failureNotice = vi.fn();
  let cancellation = 0, sequence = 0;
  const sending = new Set<string>();
  const workspace = { chats: [{ id: "chat", folder, agentId: "codex" }], pendingAutoSend: {} };
  const account = { me: {
    user: { id: "nonstaff-member", email: "fixture@example.test", displayName: null, staffRole: null },
    organizations: [{ id: "11111111-1111-4111-8111-111111111111", slug: "fixture", name: "Fixture organization", logo: null,
      isPersonal: false, role: "member", defaultTeamId: null, workspaceCapabilities: { local: false, cloud: true },
      teamCapabilities: { multiple: false, canCreate: false } }],
    teams: [],
  } as Me | null };
  let connectionStatus = "connected";
  const connectionListeners = new Set<() => void>();
  class WorkspaceRuntimeClient {
    status = "connected";
    statusForWorkspace() { return connectionStatus; }
    onWorkspaceStatusChange(_folder: string, changed: () => void) {
      connectionListeners.add(changed); return () => connectionListeners.delete(changed);
    }
  }
  const connection = (status: string) => { connectionStatus = status; for (const changed of connectionListeners) changed(); };

  const provider: any = { ...lifecycle, ...retention, hasBackgroundAgentWork, Error, BLANK: {}, useCallback: (fn: unknown) => fn, isCloudWorkspace, parseCloudWorkspaceKey, parseCloudScopedId,
    cloudPrompts: { available: () => false, send: vi.fn() }, migrateCloudSends: vi.fn(async () => {}),
    hasCloudWorkspaceAccountAccess: (organizationId: string) => cloudWorkspaceAccountAccess(account.me, organizationId),
    cloudComputerV2: cloud && cloudWorkspaceAccountAccess(account.me), WorkspaceRuntimeClient, bridge: new WorkspaceRuntimeClient(), getStore: () => store, useWorkspaceStore: { getState: () => workspace },
    refreshModelCatalog: vi.fn(), cloudCatalogGeneration: () => 1, cloudWorkspaceDocument: () => doc, prepareForSend: prepare, cloudSendWaitRef: { current: wait },
    subscribeCloudWorkspaces: () => () => {}, cloudWorkspaceStopVersion: () => 0, isCloudWorkspaceLifecyclePending,
    cloudSendPreparationRef: { current: { cancel: vi.fn() } }, beginCloudSendWaitRef: { current: null }, hydrateCloudSendRef: { current: null },
    sendQueueRef: { current: queue }, sendingChatsRef: { current: sending }, queueHeldRef: { current: new Set() },
    cancelGenerationsRef: { current: new Map() }, flushBubbleRef: { current: flush }, cloudFlushRef: { current: new Map() },
    ensureSessionRef: { current: vi.fn(async () => { await initialize.promise; Object.assign(store.sessions.chat, { status: "ready", sessionId: "replacement-route" }); }) },
    sendPromptRef: { current: (...args: unknown[]) => {
      const id = flush.get("chat"); flush.delete("chat"); provider.cloudFlushRef.current.delete("chat"); delivered(id, args); sending.add("chat"); store.sessions.chat.status = "streaming";
      store.sessions.chat.messages = store.sessions.chat.messages.map((m: any) => m.id === id ? { ...m, queued: false } : m);
    } },
    chatComposerEnv: () => undefined, chatEnvDriftKey: () => "", CloudSendWaitError, CloudWorkspaceWakeEndedError, isRecoverable,
    ControlPlaneError: class extends Error {}, performance, Date,
    notifyAgentSendFailure: failureNotice,
    redactLogSecrets: (s: string) => s, crypto: { randomUUID: () => `message-${++sequence}` },
    capUserAppend: (messages: unknown[], message: unknown) => [...messages, message], evictUnretainedTranscripts: vi.fn(),
    hasPromptAttachmentReferences: () => false, refreshPromptAttachments: vi.fn(), toast: toasts, drainOrDropQueue: vi.fn(), persistAuthPrompt: vi.fn(),
    HYDRATE_WINDOW: 100, hydrateInFlightRef: { current: new Map() }, pendingHydratesRef: { current: new Set() },
    takeFreshLocalChat: () => false, consumeFreshCloudChat: () => false, localTranscriptCache: { peek: () => null, read: async () => null },
    presentCachedLocalTranscript: vi.fn(), presentKnownEmptyLocalTranscript: () => false, retainMessageReferences: (_current: unknown[], next: unknown[]) => next,
    persistMessageWindow: vi.fn(async () => ({ source: "control-plane", messages: [{ id: "past", kind: "text", role: "user", text: "History" }] })),
    reconcileHistoryMessages: (messages: unknown[]) => messages, messageSnapshotsEqual: (a: unknown[], b: unknown[]) => JSON.stringify(a) === JSON.stringify(b),
    reconcileChatMessages: vi.fn(),
  };
  vm.runInNewContext(providerCode, provider);
  provider.beginCloudSendWaitRef.current = provider.actions.beginCloudSendWait;
  provider.hydrateCloudSendRef.current = provider.actions.hydrateChat;
  const draft = { displayText: "Inspect this attachment", json: { type: "doc", content: [{ type: "paragraph" }] },
    attachments: [{ id: "image", name: "image.png", kind: "image", mimeType: "image/png", size: 10, data: "", validation: { ok: true } }],
    segments: [{ type: "text", text: "Inspect this attachment" }] };
  let current: any = draft;
  const clear = vi.fn(() => { current = { ...draft, displayText: "", attachments: [], segments: [], json: {} }; });
  const dispatch = vi.fn(), localSend = vi.fn(async () => {}), cloudError = vi.fn();
  const composer: any = { ...lifecycle, getFollowUpBehavior, hasDesignFrameAttachmentSelection, chatId: "chat", readOnly: false, cloudComputerV2: cloud, chatThread: workspace.chats[0], workspaceProvisioning: false,
    session: { transcriptState: resident ? "resident" : "loading", status: "reconnecting", agentId: "codex", startSession: vi.fn(async () => {}),
      sendPrompt: cloud ? (...args: unknown[]) => provider.actions.sendPrompt("chat", ...args.slice(0, 5), undefined, args[5], args[6], args[7], args[8]) : localSend },
    agentSessions: { getSendGeneration: () => cancellation }, cloudWorkspaceDocument: () => doc, parseCloudWorkspaceKey, isCloudWorkspace,
    cloudQueuedPrompt, redactLogSecrets: (s: string) => s, setCloudSendError: cloudError,
    notifyAgentSendFailure: failureNotice, crypto: provider.crypto,
    designFrameContext: { capture: () => null, pin: vi.fn(), consume: vi.fn() }, hasPendingTextAttachmentDelivery: () => false, transcriptAttachesRef: { current: new Set() },
    composerAttachmentsReading: () => false, waitForComposerAttachmentReads: vi.fn(async () => {}), waitForPendingTextAttachmentDeliveries: vi.fn(async () => {}),
    useSessionsStore: { getState: () => store }, useWorkspaceStore: { getState: () => workspace }, transcriptParkedChatRef: { current: null },
    serializeComposerState: () => current, sendPastPermission: () => "send", planReview: null, bareInlineSlashCommand: () => null,
    composerLiveRef: { current: null }, dispatch, recordWorkspaceActivity: vi.fn(), agentsList: null, envForChat: () => ({}),
    setCloudSendPreparing: vi.fn(), setSendPreparing: vi.fn(), encodeComposerAttachments: encoding.run, reportSkippedAttachments: vi.fn(),
    expandMentionsInText: (text: string) => text, browserPickerSelection: null, toMessageSegments: () => draft.segments, isSubmittedComposerDocument,
    clearComposer: clear, clearComposerEditor: clear, pendingSendScrollCountRef: { current: 0 }, sendInFlightRef: { current: false }, startCloudSubmitSpan: () => vi.fn(), toast: toasts,
  };
  vm.runInNewContext(composerCode, composer);
  return { account, provider, composer, queue, store, prepare, delivered, clear, dispatch, cloudError, toasts, draft, failureNotice, connection,
    send: () => composer.actions.handleSend(), ready: () => { doc.status = "ready"; wake.resolve(); initialize.resolve(); },
    type: (text: string) => { current = { ...draft, displayText: text, json: { text }, attachments: [], segments: [{ type: "text", text }] }; },
    finish: () => { sending.clear(); store.sessions.chat.status = "ready"; provider.actions.drainNextQueued("chat"); },
    stop: () => { cancellation++; provider.cancelGenerationsRef.current.set("chat", cancellation); wait.cancel("chat"); },
  };
}

describe("cloud composer readiness queue", () => {
  it("submits an outbox-capable Send without waiting for a disconnected bridge or agent admission", async () => {
    const h = harness(true, "ready"), saved = deferred();
    h.connection("disconnected"); h.provider.bridge = null;
    h.provider.cloudPrompts.available = () => true;
    h.provider.cloudPrompts.send.mockImplementation(async (_chat: string, _input: unknown, options: { accepted?(): void }) => { await saved.promise; options.accepted?.(); });
    const sending = h.send(); await vi.advanceTimersByTimeAsync(0);
    expect(h.provider.cloudPrompts.send).toHaveBeenCalledWith("chat", expect.objectContaining({ text: expect.any(String), cloudQueue: expect.anything() }), expect.objectContaining({ mode: "prompt" }));
    expect(h.clear).not.toHaveBeenCalled(); saved.resolve(); await sending; await vi.advanceTimersByTimeAsync(0);
    expect(h.clear).toHaveBeenCalledOnce(); expect(h.queue.size).toBe(0);
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.provider.ensureSessionRef.current).not.toHaveBeenCalled();
    expect(h.delivered).not.toHaveBeenCalled(); expect(h.store.sessions.chat.cloudSendWait).toBeUndefined();
  });
  it("retains the draft if the durable Send fails before its private commit", async () => {
    const h = harness(true, "ready"); h.provider.cloudPrompts.available = () => true;
    h.provider.cloudPrompts.send.mockRejectedValue(new Error("Private message storage is unavailable"));
    await h.send(); expect(h.clear).not.toHaveBeenCalled(); expect(h.queue.size).toBe(0);
    expect(h.failureNotice).toHaveBeenCalledOnce(); expect(h.prepare).not.toHaveBeenCalled();
  });
  it("keeps a send queued through a 25-second drop, re-adopts its session and delivers once on reconnect", async () => {
    const h = harness(true, "ready");
    Object.assign(h.store.sessions.chat, { status: "ready", sessionId: "old-route" });
    h.connection("disconnected");
    await h.send();
    const id = h.queue.get("chat")![0].bubbleId;
    await vi.advanceTimersByTimeAsync(25_000);
    expect(h.failureNotice).not.toHaveBeenCalled();
    expect(h.queue.get("chat")).toHaveLength(1);
    expect(h.delivered).not.toHaveBeenCalled();
    h.connection("connected"); h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.provider.ensureSessionRef.current).toHaveBeenCalledOnce();
    expect(h.delivered).toHaveBeenCalledOnce();
    expect(h.delivered.mock.calls[0][0]).toBe(id);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.delivered).toHaveBeenCalledOnce(); expect(h.failureNotice).not.toHaveBeenCalled();
  });

  it("pauses the ten-second agent budget across disconnects while retaining connected time", async () => {
    const h = harness(true, "ready"); await h.send();
    await vi.advanceTimersByTimeAsync(3_500);
    h.connection("disconnected"); await vi.advanceTimersByTimeAsync(40_000);
    expect(h.failureNotice).not.toHaveBeenCalled();
    h.connection("connecting"); await vi.advanceTimersByTimeAsync(10_000);
    expect(h.failureNotice).not.toHaveBeenCalled();
    h.connection("connected"); await vi.advanceTimersByTimeAsync(6_499);
    expect(h.failureNotice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.failureNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "queued_timeout" }));
    expect(h.delivered).not.toHaveBeenCalled();
  });

  it("keeps a disconnected send cancelled by Stop from dispatching on a later reconnect", async () => {
    const h = harness(true, "ready"); h.connection("disconnected"); await h.send();
    await vi.advanceTimersByTimeAsync(25_000);
    h.stop(); h.connection("connected"); h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).not.toHaveBeenCalled(); expect(h.failureNotice).not.toHaveBeenCalled();
    expect(h.queue.get("chat")).toHaveLength(1);
  });

  it.each(["edit", "remove", "delivery"])("does not turn a queued %s into resident history", async action => {
    const h = harness(true, "ready", false);
    useSessionsStore.getState().clearAll();
    useSessionsStore.getState().setSession("chat", { ...BLANK, ...h.store.sessions.chat, transcriptState: "loading" });
    h.provider.getStore = useSessionsStore.getState;
    await h.send();
    const id = h.queue.get("chat")![0].bubbleId;
    if (action === "edit") h.provider.actions.editQueued("chat", id, { text: "Revised prompt" });
    else if (action === "remove") h.provider.actions.removeQueued("chat", id);
    else h.provider.actions.markQueuedDelivery("chat", id, "sending");
    expect(useSessionsStore.getState().sessions.chat.transcriptState).toBe("loading");
    expect(h.delivered).not.toHaveBeenCalled();
  });

  it("gives a replacement queue head its own wait and ignores the removed head's late preparation", async () => {
    const h = harness(true, "ready");
    const oldPreparation = deferred(), nextPreparation = deferred();
    h.prepare.mockImplementationOnce(() => oldPreparation.promise).mockImplementation(() => nextPreparation.promise);
    await h.send();
    const removed = h.queue.get("chat")![0].bubbleId;
    h.type("Next prompt"); await h.send();
    const next = h.queue.get("chat")![1].bubbleId;
    h.provider.actions.removeQueued("chat", removed);
    expect(h.store.sessions.chat.cloudSendWait).toMatchObject({ state: "waiting", turnId: next });
    oldPreparation.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).not.toHaveBeenCalled();
    h.ready(); nextPreparation.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).toHaveBeenCalledOnce();
    expect(h.delivered.mock.calls[0][0]).toBe(next);
  });

  it("does not turn an optimistic cloud bubble into history authority in the real session store", async () => {
    const h = harness(true, "ready", false);
    useSessionsStore.getState().clearAll();
    useSessionsStore.getState().setSession("chat", { ...BLANK, ...h.store.sessions.chat, transcriptState: "loading" });
    h.provider.getStore = useSessionsStore.getState;
    await h.send();
    const slot = useSessionsStore.getState().sessions.chat;
    expect(slot.transcriptState).toBe("loading");
    expect(slot.messages).toHaveLength(1);
    expect(slot.activeTurnStartedAt).toBeNull();
    expect(h.delivered).not.toHaveBeenCalled();
  });

  it("dispatches a freshly created cloud chat without reading nonexistent history", async () => {
    const h = harness(true, "ready", false);
    h.provider.consumeFreshCloudChat = () => true;
    h.provider.persistMessageWindow.mockRejectedValue(new Error("command_conflict"));
    await h.send(); h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.store.sessions.chat.transcriptState).toBe("resident");
    expect(h.provider.persistMessageWindow).not.toHaveBeenCalled();
    expect(h.delivered).toHaveBeenCalledOnce();
  });

  it("keeps a pre-dispatch message in the queue without starting a running-turn clock", async () => {
    const h = harness(true, "ready");
    await h.send();
    expect(queuedTranscriptPresentation(h.store.sessions.chat.messages).queuedMessages).toHaveLength(1);
    expect(h.store.pendingLocalTurns.chat).toBeUndefined();
    expect(h.store.sessions.chat.activeTurnStartedAt ?? null).toBeNull();
    expect(h.store.sessions.chat.cloudSendWait).toMatchObject({ state: "waiting", phase: "sending" });
  });

  it.each([false, true])("bounds failed history reads at ten seconds without losing confirmed or optimistic rows (hung=%s)", async hung => {
    const h = harness(true, "ready", false);
    const confirmed = { id: "confirmed", kind: "text", role: "agent", text: "Confirmed answer", createdAt: 1 };
    h.store.sessions.chat.messages = [confirmed];
    h.store.sessions.chat.hasTranscript = true;
    h.provider.persistMessageWindow.mockImplementation(() => hung ? new Promise(() => {}) : Promise.reject(new Error("command_conflict")));
    await h.send(); h.ready(); await vi.advanceTimersByTimeAsync(10_000);
    const slot = h.store.sessions.chat;
    expect(slot.cloudSendWait).toMatchObject({ state: "failed", message: "Couldn't load chat history. Retry to send your message." });
    expect(slot.messages).toContain(confirmed);
    expect(slot.messages.some((row: any) => row.text === h.draft.displayText)).toBe(true);
    expect(h.provider.persistMessageWindow.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(h.provider.persistMessageWindow.mock.calls.length).toBeLessThanOrEqual(5);
    expect(h.failureNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "history_unavailable", onRetry: expect.any(Function) }));
    expect(h.delivered).not.toHaveBeenCalled();
  });

  it("bounds workspace wake at 180 seconds without dispatching a late preparation", async () => {
    const h = harness(); await h.send();
    expect(h.store.sessions.chat.cloudSendWait).toMatchObject({ state: "waiting", phase: "starting-workspace" });
    await vi.advanceTimersByTimeAsync(179_999);
    expect(h.store.sessions.chat.cloudSendWait.state).toBe("waiting");
    expect(h.failureNotice).not.toHaveBeenCalled();
    expect(h.store.sessions.chat.activeTurnStartedAt ?? null).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.store.sessions.chat.cloudSendWait.state).toBe("failed");
    expect(h.failureNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "workspace_start_timeout" }));
    expect(h.queue.get("chat")).toHaveLength(1);
    h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).not.toHaveBeenCalled();
  });

  it("retains the original wake deadline and display origin through readiness re-entry", async () => {
    const h = harness(); await h.send();
    const startedAt = h.store.sessions.chat.cloudSendWait.startedAt;
    expect(startedAt).toBe(Date.now());
    await vi.advanceTimersByTimeAsync(80_000);
    h.provider.cloudSendWaitRef.current.cancel("chat");
    h.provider.actions.beginCloudSendWait("chat");
    expect(h.store.sessions.chat.cloudSendWait.startedAt).toBe(startedAt);
    await vi.advanceTimersByTimeAsync(99_999);
    expect(h.store.sessions.chat.cloudSendWait.state).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.failureNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "workspace_start_timeout" }));
    h.failureNotice.mock.calls[0][0].onRetry();
    expect(h.store.sessions.chat.cloudSendWait).toMatchObject({ state: "waiting", startedAt: Date.now() });
    expect(h.store.sessions.chat.cloudSendWait.startedAt).not.toBe(startedAt);
    h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).toHaveBeenCalledOnce();
  });

  it("saves an empty queued editor when its existing frozen additional payload survives, without using a new canvas selection", async () => {
    const h = harness(true, "ready");
    h.type("");
    h.composer.editingQueuedRef = { current: "queued" };
    h.composer.queueSaveInFlightRef = { current: false };
    h.composer.queueEditGenerationRef = { current: 1 };
    h.composer.exitQueuedEdit = vi.fn();
    h.composer.session.editQueued = vi.fn();
    const prepareAdditional = vi.fn(async () => h.draft.attachments);
    h.composer.session.getQueuedDraft = () => ({ prepareAdditional });
    expect(await h.composer.actions.saveQueuedEdit()).toBe(true);
    expect(h.composer.session.editQueued).toHaveBeenCalledWith("queued", expect.objectContaining({ cloudQueue: expect.objectContaining({ draft: expect.objectContaining({ prepareAdditional }) }) }));
    expect(prepareAdditional).not.toHaveBeenCalled();
    h.composer.session.editQueued.mockClear();
    h.composer.session.getQueuedDraft = () => undefined;
    h.composer.designFrameContext.hasContext = true;
    expect(await h.composer.actions.saveQueuedEdit()).toBe(false);
    expect(h.composer.session.editQueued).not.toHaveBeenCalled();
  });

  it.each(["legacy", "grouped"].flatMap(shape => [false, true].map(prepared => ({ shape, prepared }))))("parks and recovers $shape reference-only sends with prepared=$prepared", async ({ shape, prepared }) => {
    const target = { workspaceId: "local", directoryId: "design", frame: "home.html", intent: "code" };
    const references = shape === "legacy" ? target : [target, { ...target, frame: "pricing.html" }];
    const h = harness(false, "ready", prepared);
    h.composer.workspaceProvisioning = prepared;
    h.composer.session.hydrateChat = vi.fn(async () => {});
    h.composer.serializeComposerState = () => ({ isEmpty: true, displayText: "", attachments: [], json: { type: "doc", content: [] }, segments: [] });
    h.composer.designFrameContext.capture = () => references;
    h.composer.designFrameContext.pin.mockImplementation((value: unknown) => { h.composer.composerLiveRef.current = { designFrame: value }; });
    await h.send();
    const parked = h.dispatch.mock.calls.find(([action]) => action.type === "SET_CHAT_DRAFT")?.[0];
    expect(parked?.draft.designFrame).toEqual(references);
    expect(h.dispatch).toHaveBeenCalledWith({ type: "REQUEST_AUTO_SEND", chatId: "chat" });
    expect(h.toasts.info).toHaveBeenCalledOnce();
    expect(recoverPendingAutoSend({ chats: { chat: parked.draft }, edits: {}, autoSend: { chat: Date.now() } }, Date.now())).toEqual({ chat: Date.now() });
  });

  it.each([{ label: "removed", references: null }, { label: "empty group", references: [] }, { label: "invalid group", references: [{}] }])("does not arm empty sends for $label references", async ({ references }) => {
    for (const prepared of [false, true]) {
      const h = harness(false, "ready", prepared);
      h.composer.workspaceProvisioning = prepared;
      h.composer.session.hydrateChat = vi.fn(async () => {});
      h.composer.serializeComposerState = () => ({ isEmpty: true, displayText: "", attachments: [], json: { type: "doc", content: [] }, segments: [] });
      h.composer.designFrameContext.capture = () => references;
      h.composer.designFrameContext.pin.mockImplementation((value: unknown) => { h.composer.composerLiveRef.current = { designFrame: value }; });
      await h.send();
      expect(h.dispatch).not.toHaveBeenCalled();
      expect(h.toasts.info).not.toHaveBeenCalled();
    }
  });

  it("keeps the pin-owned persisted Design reference when parking a prepared workspace", async () => {
    const h = harness(false, "ready");
    const saved = { workspaceId: "local", directoryId: "design", frame: "home.html", intent: "code" };
    h.composer.workspaceProvisioning = true;
    h.composer.useWorkspaceStore.getState().pendingAutoSend = {};
    h.composer.designFrameContext.capture = () => ({ ...saved, selectionEvent: 7, ownerRevision: 3 });
    h.composer.designFrameContext.pin.mockImplementation(() => { h.composer.composerLiveRef.current = { designFrame: saved }; });
    await h.send();
    expect(h.composer.composerLiveRef.current.designFrame).toEqual(saved);
    expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "SET_CHAT_DRAFT", draft: expect.objectContaining({ designFrame: saved }) }));
  });

  it.each(["stopped", "waking", "setting_up", "ready"])("keeps the first cloud prompt in the queue before %s preparation completes", async status => {
    const h = harness(true, status);
    await h.send();
    const bubbleId = h.queue.get("chat")![0].bubbleId;
    const projected = queuedTranscriptPresentation(h.store.sessions.chat.messages);
    expect(projected.visibleMessages).toEqual([]);
    expect(projected.queuedMessages).toEqual([expect.objectContaining({ id: bubbleId, text: h.draft.displayText })]);
    expect(h.delivered).not.toHaveBeenCalled();
    expect(h.store.sessions.chat.cloudSendWait?.state).toBe("waiting");
    h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).toHaveBeenCalledExactlyOnceWith(bubbleId, expect.anything());
    expect(queuedTranscriptPresentation(h.store.sessions.chat.messages).visibleMessages).toHaveLength(1);
  });

  it.each(["ready", "busy"])("keeps a queued message while an admitted %s follow-up crosses preparation", async status => {
    const h = harness(true, status);
    Object.assign(h.store.sessions.chat, { status: "ready", sessionId: "admitted" });
    await h.send();
    expect(h.store.sessions.chat.cloudSendWait).toMatchObject({ state: "waiting", phase: "sending" });
    expect(queuedTranscriptPresentation(h.store.sessions.chat.messages).queuedMessages).toEqual([
      expect.objectContaining({ text: h.draft.displayText }),
    ]);
    h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).toHaveBeenCalledOnce();
    expect(h.provider.ensureSessionRef.current).not.toHaveBeenCalled();
  });

  it("keeps an explicit queued follow-up behind the unaccepted opening prompt in the queue", async () => {
    const h = harness(); await h.send(); h.type("After this finishes"); await h.send();
    const projected = queuedTranscriptPresentation(h.store.sessions.chat.messages);
    expect(projected.visibleMessages).toHaveLength(0);
    expect(projected.queuedMessages).toEqual([expect.objectContaining({ text: h.draft.displayText }), expect.objectContaining({ text: "After this finishes" })]);
    expect(h.queue.get("chat")).toHaveLength(2);
  });

  it.each(["task", "report", "workflow"])("waits for native background %s work before preparing and delivering a cloud queue", async work => {
    const h = harness(true, "ready");
    Object.assign(h.store.sessions.chat, { status: "ready", sessionId: "admitted" });
    if (work === "task") h.store.sessions.chat.backgroundTasks = [{ taskId: "child", name: "Verify", taskType: "local_bash", startedAt: 1, updatedAt: 1 }];
    else if (work === "report") h.store.sessions.chat.backgroundActivity = { state: "running", startedAt: 1 };
    else h.store.sessions.chat.workflows = [{ taskId: "workflow", status: "running" }];
    h.ready();
    await h.send();
    expect(h.queue.get("chat")).toHaveLength(1);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.delivered).not.toHaveBeenCalled();
    Object.assign(h.store.sessions.chat, { backgroundTasks: [], backgroundActivity: { state: "idle", startedAt: 1 }, workflows: [] });
    h.provider.actions.releaseQueue("chat");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).toHaveBeenCalledOnce();
    expect(h.queue.get("chat")).toBeUndefined();
  });

  it.each(["cloud", "personal-local", "organization-local"])("forwards the intent through the actual %s preparation callback", async placement => {
    const h = harness(placement === "cloud", "ready");
    class BridgeFixture { openWorkspace = vi.fn(async () => {}); }
    const bridge = new BridgeFixture(), wakeIntent = { id: "prepared-action" };
    const context = { ...h.provider, bridge, cloudComputerV2: true, WorkspaceRuntimeClient: BridgeFixture,
      canReadCloudWorkspace: () => true, cloudSendPreparationRef: { current: new CloudSendPreparation() } };
    vm.runInNewContext(callbacks(providerAst, ["prepareForSend"]), context);
    for (let attempt = 0; attempt < 3; attempt++) await context.actions.prepareForSend("chat", wakeIntent);
    if (placement === "cloud") {
      expect(bridge.openWorkspace).toHaveBeenCalledTimes(3);
      for (const call of bridge.openWorkspace.mock.calls) expect(call).toEqual([
        parseCloudWorkspaceKey(h.store.sessions.chat.cwd), { signal: expect.anything(), wakeIntent },
      ]);
    } else expect(bridge.openWorkspace).not.toHaveBeenCalled();
  });

  it("retains an upstream preparation's wake intent when accepting the queued message", async () => {
    const h = harness(true, "ready"), wakeIntent = { id: "upstream-action" };
    await h.provider.actions.sendPrompt("chat", "Action", undefined, undefined, undefined, undefined, undefined, undefined, undefined, wakeIntent);
    expect(h.queue.get("chat")![0].wakeIntent).toBe(wakeIntent);
    expect(h.prepare).toHaveBeenCalledExactlyOnceWith("chat", wakeIntent);
  });

  it("keeps an unrecognized slash command's preliminary wake when it becomes a prompt", async () => {
    const h = harness(true, "ready"); h.type("/unknown");
    h.composer.agentSessions.prepareForSend = h.prepare;
    h.composer.openTerminalCommand = () => false;
    h.prepare.mockResolvedValue(undefined);
    await h.send();
    const intent = h.prepare.mock.calls[0][1];
    expect(intent?.id).toEqual(expect.any(String));
    h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).toHaveBeenCalledOnce();
    for (const call of h.prepare.mock.calls) expect(call[1]).toBe(intent);
  });

  it("retains one wake intent across bounded settled readiness attempts and final preparation", async () => {
    const h = harness(true, "ready");
    h.prepare.mockResolvedValue(undefined);
    h.provider.ensureSessionRef.current.mockResolvedValue(undefined);
    await h.send(); await vi.advanceTimersByTimeAsync(6_000);
    expect(h.prepare).toHaveBeenCalledTimes(4);
    const intent = h.prepare.mock.calls[0][1];
    expect(intent?.id).toEqual(expect.any(String));
    for (const call of h.prepare.mock.calls) expect(call[1]).toBe(intent);
    Object.assign(h.store.sessions.chat, { status: "ready", sessionId: "admitted" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.delivered).toHaveBeenCalledOnce();
    expect(h.prepare).toHaveBeenCalledTimes(6);
    for (const call of h.prepare.mock.calls) expect(call[1]).toBe(intent);
  });

  it("allocates a wake intent only when a queued row reaches preparation and renews it on explicit retry", async () => {
    const h = harness(true, "ready");
    h.store.sessions.chat.status = "streaming";
    await h.send();
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.queue.get("chat")![0].wakeIntent).toBeUndefined();
    h.prepare.mockRejectedValueOnce(new CloudWorkspaceWakeEndedError("Cloud workspace was stopped"));
    h.finish(); await vi.advanceTimersByTimeAsync(0);
    const first = h.prepare.mock.calls[0]?.[1];
    expect(first?.id).toEqual(expect.any(String));
    const row = h.queue.get("chat")![0];
    expect(h.queue.isPaused("chat")).toBe(true);
    h.prepare.mockResolvedValue(undefined);
    Object.assign(h.store.sessions.chat, { status: "ready", sessionId: "admitted" });
    h.provider.actions.retryCloudQueuedPrompt("chat", row, 1, h.store.sessions.chat.cwd);
    await vi.advanceTimersByTimeAsync(0);
    const retry = h.prepare.mock.calls[1]?.[1];
    expect(retry?.id).toEqual(expect.any(String));
    expect(retry).not.toBe(first);
    expect(h.delivered).toHaveBeenCalledOnce();
  });

  it("does not dispatch cached presentation after wake until authoritative history settles", async () => {
    const h = harness(true, "stopped", false), history = deferred();
    h.store.sessions.chat.messages = [{ id: "cached", kind: "text", role: "agent", text: "Visible cached history" }];
    h.store.sessions.chat.transcriptPresentation = { source: "cache" };
    h.provider.persistMessageWindow.mockImplementationOnce(async () => { await history.promise;
      return { source: "control-plane", messages: [{ id: "past", kind: "text", role: "agent", text: "Verified history" }] }; });
    await h.send(); h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.provider.persistMessageWindow).toHaveBeenCalledOnce();
    expect(h.store.sessions.chat.transcriptState).toBe("loading");
    expect(h.delivered).not.toHaveBeenCalled(); expect(encoding.run).not.toHaveBeenCalled();
    history.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).toHaveBeenCalledOnce();
  });
  it.each(["signed-out", "no-entitlement"])("does not prepare or dispatch a cloud send for %s", async reason => {
    const h = harness();
    if (reason === "signed-out") h.account.me = null;
    else h.account.me!.organizations![0].workspaceCapabilities.cloud = false;
    await expect(h.provider.actions.sendPrompt("chat", "Blocked send")).rejects.toThrow("run access");
    expect(h.queue.get("chat")).toBeUndefined();
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.delivered).not.toHaveBeenCalled();
  });
  it("accepts a nonstaff member cloud send without a rollout preference while wake is pending", async () => {
    const h = harness(); await h.send();
    expect(h.queue.get("chat")).toHaveLength(1); expect(h.clear).toHaveBeenCalledOnce();
    expect(h.provider.actions.getQueuedDraft("chat", h.queue.get("chat")![0].bubbleId).json).toBe(h.draft.json);
    expect(h.store.sessions.chat.cloudSendWait.state).toBe("waiting"); expect(encoding.run).not.toHaveBeenCalled();
    expect(h.store.setPendingLocalTurn).not.toHaveBeenCalled();
    expect(h.delivered).not.toHaveBeenCalled(); expect(h.toasts.error).not.toHaveBeenCalled();
    expect(h.failureNotice).not.toHaveBeenCalled();
  });
  it("shares repeated Enter and preserves rich attachments across wake/engine replacement, submitting once", async () => {
    const h = harness(); await Promise.all([h.send(), h.send()]); const id = h.queue.get("chat")![0].bubbleId;
    h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).toHaveBeenCalledExactlyOnceWith(id, expect.arrayContaining(["Inspect this attachment", [{ type: "text", text: "confirmed-file" }]]));
    expect(encoding.run).toHaveBeenCalledOnce(); expect(h.queue.get("chat")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(180_000); expect(h.delivered).toHaveBeenCalledOnce(); expect(h.toasts.error).not.toHaveBeenCalled();
  });
  it("keeps several messages FIFO and accepts editing/removal before readiness", async () => {
    const h = harness(); await h.send(); h.type("Second"); await h.send(); h.type("Remove me"); await h.send();
    const [first, second, third] = h.queue.get("chat")!;
    h.provider.actions.editQueued("chat", first.bubbleId, { text: "Edited", displayText: "Edited" });
    expect(h.queue.get("chat")![0].args[1]).toBe("Edited");
    h.provider.actions.removeQueued("chat", third.bubbleId); h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).toHaveBeenCalledExactlyOnceWith(first.bubbleId, expect.arrayContaining(["Edited"]));
    h.finish(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered.mock.calls.map(([id]) => id)).toEqual([first.bubbleId, second.bubbleId]);
    expect(h.toasts.error).not.toHaveBeenCalled();
  });
  it("removing the last message cancels readiness and fences a late upgraded admission", async () => {
    const h = harness(); await h.send(); h.provider.actions.removeQueued("chat", h.queue.get("chat")![0].bubbleId);
    h.ready(); await vi.advanceTimersByTimeAsync(180_000); expect(h.delivered).not.toHaveBeenCalled();
    expect(h.store.sessions.chat.cloudSendWait).toBeUndefined(); expect(h.toasts.error).not.toHaveBeenCalled();
  });
  it("keeps edits and removal authoritative while attachment preparation is pending", async () => {
    const h = harness(); let encoded!: (value: unknown) => void;
    encoding.run.mockImplementationOnce(() => new Promise(resolve => { encoded = resolve; }));
    await h.send(); h.ready(); await vi.advanceTimersByTimeAsync(0);
    const id = h.queue.get("chat")![0].bubbleId;
    const edited = cloudQueuedPrompt({ cwd: h.store.sessions.chat.cwd, chatId: "chat", agentId: "codex",
      text: "Edited files", displayText: "Edited files", snapshot: { ...h.draft, json: { edited: true } } as any });
    h.provider.actions.editQueued("chat", id, edited);
    expect(h.provider.actions.getQueuedDraft("chat", id).json).toEqual({ edited: true });
    encoded({ blocks: [], bubbleAttachments: [], bubbleAttachmentById: new Map(), skipped: [] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.delivered).toHaveBeenCalledExactlyOnceWith(id, expect.arrayContaining(["Edited files"]));
    expect(h.toasts.error).not.toHaveBeenCalled();
  });
  it("rechecks the queued head after the final readiness boundary", async () => {
    const h = harness(), finalReady = deferred();
    h.prepare.mockImplementationOnce(async () => {}).mockImplementationOnce(() => finalReady.promise).mockImplementation(async () => {});
    await h.send(); h.ready(); await vi.advanceTimersByTimeAsync(0);
    const id = h.queue.get("chat")![0].bubbleId;
    h.provider.actions.removeQueued("chat", id); finalReady.resolve();
    await vi.advanceTimersByTimeAsync(180_000); expect(h.delivered).not.toHaveBeenCalled();
  });
  it("uses the fresh admitted agent's attachment capabilities", async () => {
    const h = harness(); h.store.sessions.chat.initialize = { agentCapabilities: { promptCapabilities: { image: false } } };
    await h.send(); h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(encoding.run).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ supportsImage: false }));
  });
  it("keeps an undispatched row editable across N to N+1 and sends it once without a failure toast", async () => {
    const h = harness(); h.prepare.mockRejectedValueOnce(new Error("Connecting"));
    await h.send(); await vi.advanceTimersByTimeAsync(0);
    const row = h.queue.get("chat")![0], doc = h.provider.cloudWorkspaceDocument();
    doc.generation.number++; doc.status = "provisioning";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.store.sessions.chat.cloudSendWait.state).toBe("waiting");
    h.provider.actions.editQueued("chat", row.bubbleId, { text: "Replacement", displayText: "Replacement" });
    doc.status = "setting_up"; h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).toHaveBeenCalledExactlyOnceWith(row.bubbleId, expect.arrayContaining(["Replacement"]));
    expect(h.failureNotice).not.toHaveBeenCalled();
  });
  it("keeps the rich queued row across a candidate rollback and dispatches once without a toast", async () => {
    const h = harness(); await h.send(); const row = h.queue.get("chat")![0];
    const doc = h.provider.cloudWorkspaceDocument();
    doc.generation.number = 8; doc.status = "provisioning";
    await vi.advanceTimersByTimeAsync(1_000); doc.status = "setting_up";
    await vi.advanceTimersByTimeAsync(1_000);
    doc.generation.number = 7; doc.status = "waking";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.queue.get("chat")![0]).toBe(row);
    expect(h.store.sessions.chat.cloudSendWait.state).toBe("waiting");
    h.provider.actions.editQueued("chat", row.bubbleId, { text: "After rollback", displayText: "After rollback" });
    h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).toHaveBeenCalledExactlyOnceWith(row.bubbleId, expect.arrayContaining(["After rollback"]));
    expect(h.failureNotice).not.toHaveBeenCalled(); expect(h.composer.toast.error).not.toHaveBeenCalled();
  });
  it.each(["archived", "deleted", "failed"])("keeps a message queued and reports %s once through the shared toast helper without waking", async status => {
    const h = harness(true, status); await h.send(); await vi.advanceTimersByTimeAsync(0);
    expect(h.store.sessions.chat.cloudSendWait.state).toBe("failed"); expect(h.queue.get("chat")).toHaveLength(1);
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.toasts.error).not.toHaveBeenCalled();
    expect(h.failureNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: "chat", attemptId: h.queue.get("chat")![0].bubbleId,
      reason: status === "failed" ? "workspace_unavailable" : "workspace_archived" }));
  });
  it("keeps a timed-out message editable and uses one shared toast with an explicit retry action", async () => {
    const h = harness(true, "ready"); await h.send(); const id = h.queue.get("chat")![0].bubbleId;
    await vi.advanceTimersByTimeAsync(9_999); expect(h.store.sessions.chat.cloudSendWait.state).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1); expect(h.store.sessions.chat.cloudSendWait).toMatchObject({ state: "failed", message: expect.stringContaining("didn't accept") });
    expect(h.store.pendingLocalTurns.chat).toBeUndefined();
    expect(h.store.sessions.chat.activeTurnStartedAt).toBeNull();
    expect(queuedTranscriptPresentation(h.store.sessions.chat.messages).queuedMessages).toEqual([expect.objectContaining({ id })]);
    expect(h.failureNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: "chat", attemptId: id, reason: "queued_timeout", onRetry: expect.any(Function) }));
    h.provider.actions.editQueued("chat", id, { text: "Retained" });
    expect(h.queue.get("chat")![0].args[1]).toBe("Retained"); h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).not.toHaveBeenCalled(); expect(h.toasts.error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(180_000); expect(h.failureNotice).toHaveBeenCalledOnce();
  });
  it("keeps the rich draft editable across file preparation and the final wake", async () => {
    const h = harness(), finalReady = deferred();
    h.prepare.mockResolvedValueOnce(undefined).mockImplementationOnce(() => finalReady.promise);
    await h.send(); h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.provider.actions.getQueuedDraft("chat", h.queue.get("chat")![0].bubbleId).json).toBe(h.draft.json);
    finalReady.resolve(); await vi.advanceTimersByTimeAsync(0); expect(h.delivered).toHaveBeenCalledOnce();
  });
  it("keeps waiting through a transient preparation error, then dispatches once", async () => {
    const h = harness(); h.prepare.mockRejectedValueOnce(new Error("Connecting"));
    await h.send(); await vi.advanceTimersByTimeAsync(0);
    expect(h.store.sessions.chat.cloudSendWait.state).toBe("waiting"); h.ready();
    await vi.advanceTimersByTimeAsync(2_000); expect(h.delivered).toHaveBeenCalledOnce(); expect(h.toasts.error).not.toHaveBeenCalled();
  });
  it("retries a timed-out queued message only through an explicit toast action and keeps its identity", async () => {
    const h = harness(true, "ready"); await h.send(); const id = h.queue.get("chat")![0].bubbleId;
    await vi.advanceTimersByTimeAsync(180_000); h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).not.toHaveBeenCalled();
    h.failureNotice.mock.calls[0][0].onRetry(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).toHaveBeenCalledExactlyOnceWith(id, expect.anything()); expect(h.failureNotice).toHaveBeenCalledOnce();
  });
  it.each(["removed", "account changed"])("ignores a stale toast retry after its queued owner is %s", async cause => {
    const h = harness(true, "ready"); await h.send(); const id = h.queue.get("chat")![0].bubbleId;
    await vi.advanceTimersByTimeAsync(180_000);
    const retry = h.failureNotice.mock.calls[0][0].onRetry;
    if (cause === "removed") h.provider.actions.removeQueued("chat", id);
    else h.provider.cloudCatalogGeneration = () => 2;
    const calls = h.prepare.mock.calls.length;
    retry(); h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.prepare).toHaveBeenCalledTimes(calls); expect(h.delivered).not.toHaveBeenCalled();
  });
  it.each([30_000, 42_000, 80_000, 150_000])("delivers once after a %i ms wake/replacement inside the bounded start window", async duration => {
    const h = harness(); await h.send(); const id = h.queue.get("chat")![0].bubbleId;
    const doc = h.provider.cloudWorkspaceDocument(); doc.status = "stopping";
    await vi.advanceTimersByTimeAsync(duration / 3);
    doc.generation.number++; doc.status = "provisioning";
    await vi.advanceTimersByTimeAsync(duration / 3); doc.status = "setting_up";
    await vi.advanceTimersByTimeAsync(duration / 3);
    expect(h.store.sessions.chat.cloudSendWait.state).toBe("waiting"); expect(h.failureNotice).not.toHaveBeenCalled();
    h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).toHaveBeenCalledExactlyOnceWith(id, expect.anything()); expect(h.failureNotice).not.toHaveBeenCalled();
  });
  it("still allows only ten ready seconds after a 150-second wake", async () => {
    const h = harness(); let changed!: () => void;
    h.provider.subscribeCloudWorkspaces = (listener: () => void) => { changed = listener; return () => {}; };
    h.prepare.mockResolvedValue(undefined);
    await h.send();
    const startedAt = h.store.sessions.chat.cloudSendWait.startedAt;
    await vi.advanceTimersByTimeAsync(150_000);
    h.provider.cloudWorkspaceDocument().status = "ready"; changed();
    expect(h.store.sessions.chat.cloudSendWait).toMatchObject({ state: "waiting", phase: "sending", startedAt });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.store.sessions.chat.cloudSendWait.state).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.failureNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "queued_timeout" }));
    h.ready(); await vi.advanceTimersByTimeAsync(0); expect(h.delivered).not.toHaveBeenCalled();
  });
  it.each([
    { status: "failed", error: null },
    { status: "error", error: null },
    { status: "setting_up", error: { message: "Setup failed" } },
  ])("reports a terminal CP $status/error immediately while wake preparation is still hung", async update => {
    const h = harness(); let changed!: () => void;
    h.provider.subscribeCloudWorkspaces = (listener: () => void) => { changed = listener; return () => {}; };
    await h.send(); await vi.advanceTimersByTimeAsync(5_000);
    Object.assign(h.provider.cloudWorkspaceDocument(), update); changed();
    expect(h.store.sessions.chat.cloudSendWait.state).toBe("failed");
    expect(h.failureNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "workspace_unavailable",
      error: expect.objectContaining({ message: update.error?.message ?? expect.stringContaining(update.status) }) }));
    h.ready(); await vi.advanceTimersByTimeAsync(0); expect(h.delivered).not.toHaveBeenCalled();
  });
  it("ends an undispatched send immediately when explicit workspace Stop supersedes pending agent admission", async () => {
    const h = harness(true, "ready"); let changed!: () => void;
    h.provider.subscribeCloudWorkspaces = (listener: () => void) => { changed = listener; return () => {}; };
    h.prepare.mockResolvedValue(undefined); await h.send(); await vi.advanceTimersByTimeAsync(0);
    h.provider.cloudWorkspaceStopVersion = () => 1; changed();
    expect(h.failureNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "workspace_stopped" }));
    h.ready(); await vi.advanceTimersByTimeAsync(0); expect(h.delivered).not.toHaveBeenCalled();
  });
  it("keeps a message queued when a later Stop wins without retrying the wake", async () => {
    const h = harness();
    h.prepare.mockRejectedValue(new CloudWorkspaceWakeEndedError("Cloud workspace is stopping. Open it again to retry."));
    await h.send(); await vi.advanceTimersByTimeAsync(5_000);
    expect(h.prepare).toHaveBeenCalledOnce(); expect(h.queue.get("chat")).toHaveLength(1);
    expect(h.store.sessions.chat.cloudSendWait).toMatchObject({ state: "failed", message: expect.stringContaining("stopping") });
    expect(h.delivered).not.toHaveBeenCalled(); expect(h.toasts.error).not.toHaveBeenCalled();
    expect(h.failureNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "workspace_stopped" }));
  });
  it("retains queued content while hydrating cloud history before dispatch", async () => {
    const h = harness(true, "setting_up", false); await h.send(); h.ready(); await vi.advanceTimersByTimeAsync(0);
    expect(h.delivered).toHaveBeenCalledOnce(); expect(h.store.sessions.chat.messages.map((m: any) => m.id)).toContain("past");
    expect(h.store.sessions.chat.messages.some((m: any) => m.text === h.draft.displayText)).toBe(true);
  });
  it.each(["Personal", "organization"])("keeps %s Local sends on the original pipeline with no cloud wait or deferred encoding", async owner => {
    const h = harness(false); h.composer.cloudComputerV2 = true; h.composer.chatThread.owner = owner; await h.send();
    expect(h.toasts.error).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.queue.size).toBe(0); expect(h.store.sessions.chat.cloudSendWait).toBeUndefined();
    expect(h.composer.session.sendPrompt).toHaveBeenCalledOnce(); expect(encoding.run).toHaveBeenCalledOnce(); expect(h.cloudError).not.toHaveBeenCalled();
    expect(h.failureNotice).not.toHaveBeenCalled();
  });
  it("uses the shared failure toast before a cloud row is accepted and preserves the editor draft", async () => {
    mocks.failureToast.mockClear();
    const h = harness(); h.composer.session.sendPrompt = vi.fn(async () => { throw new Error("Admission unavailable"); });
    h.failureNotice.mockImplementation(notifyAgentSendFailure);
    await h.send();
    expect(h.clear).not.toHaveBeenCalled(); expect(h.queue.size).toBe(0);
    expect(h.failureNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: "chat", attemptId: expect.stringContaining("send-"),
      error: expect.objectContaining({ message: "Admission unavailable" }) }));
    expect(h.toasts.error).not.toHaveBeenCalled();
    expect(mocks.failureToast).toHaveBeenCalledExactlyOnceWith("Message wasn't sent", expect.objectContaining({
      description: "Review the conversation before retrying.",
    }));
  });
  it.each(["Personal", "organization"])("preserves the existing %s Local send-error toast and draft", async owner => {
    const h = harness(false); h.composer.cloudComputerV2 = true; h.composer.chatThread.owner = owner;
    h.composer.serializeComposerState = () => { throw new Error("Editor unavailable"); };
    await h.send();
    expect(h.clear).not.toHaveBeenCalled(); expect(h.failureNotice).not.toHaveBeenCalled();
    expect(h.toasts.error).toHaveBeenCalledExactlyOnceWith("Message wasn't sent", expect.anything());
  });
  it("keeps readiness failures out of generic agent toasts for every placement", () => {
    const effects: string[] = [];
    function collect(node: ts.Node) {
      if (ts.isBlock(node)) {
        const index = node.statements.findIndex(statement => ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(declaration => /^lastError.*Ref$/.test(declaration.name.getText(ast))));
        if (index >= 0) effects.push(node.statements.slice(index, index + 2).map(statement => statement.getText(ast)).join("\n"));
      }
      ts.forEachChild(node, collect);
    }
    collect(ast);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toContain("useEffect");
    expect(effects[0]).toContain("invalidateCloudAgentRegistry");
    const code = ts.transpileModule(`(() => { ${effects[0]!} })();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    for (const folder of ["cloud://fixture", "/local/personal", "/organization/local"]) {
      const refs: Array<{ current: unknown }> = [];
      let cursor = 0;
      const toast = { error: vi.fn() }, env = { interactive: true, cloudComputerV2: true, isCloudWorkspace,
        chatThread: { folder }, session: { status: "warming", agentId: "codex", cloudSendWait: { state: "waiting" } },
        isErrorState: false, cloudCatalogGeneration: () => 1,
        useRef: (initial: unknown) => refs[cursor++] ?? (refs[cursor - 1] = { current: initial }),
        useEffect: (run: () => void) => run(), isTransportShaped: () => false, agentSessions: {}, toast, chatId: "chat" };
      vm.runInNewContext(code, env);
      // Observe a new failure, not a historical failed snapshot on mount.
      env.session.status = "failed";
      env.isErrorState = true;
      cursor = 0;
      vm.runInNewContext(code, env);
      expect(toast.error).not.toHaveBeenCalled();
    }
  });
});
