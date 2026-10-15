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
import { SendQueue } from "../send-queue";
import { CloudSendWait, CloudSendWaitError } from "../cloud-send-wait";
import { CloudSendPreparation } from "../cloud-send-preparation";
import { cloudQueuedPrompt } from "../cloud-queued-prompt";
import { isRecoverable } from "../../../platform/bridge/failure";
import { CloudWorkspaceWakeEndedError } from "../../../state/cloud-workspace-wake";
import { classifyCloudAdmissionFailure, cloudAdmissionFailureCode } from "../cloud-admission-failure";
import { isCloudWorkspaceLifecyclePending } from "../../../state/cloud-workspace-catalog";
import { notifyAgentSendFailure } from "../agent-send-failure-toast";
import { hasBackgroundAgentWork } from "../background-task-state";
import { getFollowUpBehavior } from "../../settings/follow-up-behavior";

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
const composerCode = callbacks(ast, ["runSend", "handleSend"]);
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
    setSession: (id: string, value: typeof slot) => { store.sessions[id] = value; }, setPendingLocalTurn: vi.fn(), hydrateChatPolicies: vi.fn(async () => {}) };
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

  const provider: any = { ...lifecycle, ...retention, hasBackgroundAgentWork, Error, BLANK: {}, useCallback: (fn: unknown) => fn, isCloudWorkspace, parseCloudWorkspaceKey, parseCloudScopedId,
    hasCloudWorkspaceAccountAccess: (organizationId: string) => cloudWorkspaceAccountAccess(account.me, organizationId),
    cloudComputerV2: cloud && cloudWorkspaceAccountAccess(account.me), bridge: { status: "connected" }, getStore: () => store, useWorkspaceStore: { getState: () => workspace },
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
    ControlPlaneError: class extends Error {}, classifyCloudAdmissionFailure, cloudAdmissionFailureCode, performance,
    notifyAgentSendFailure: failureNotice,
    reportCloudAgentRuntimeUpgrade: vi.fn(), invalidateCloudAgentRegistry: vi.fn(),
    redactLogSecrets: (s: string) => s, crypto: { randomUUID: () => `message-${++sequence}` },
    capUserAppend: (messages: unknown[], message: unknown) => [...messages, message], evictUnretainedTranscripts: vi.fn(),
    hasPromptAttachmentReferences: () => false, refreshPromptAttachments: vi.fn(), toast: toasts, drainOrDropQueue: vi.fn(), persistAuthPrompt: vi.fn(),
    HYDRATE_WINDOW: 100, hydrateInFlightRef: { current: new Map() }, pendingHydratesRef: { current: new Set() }, persistedMessageRefsRef: { current: new Map() },
    persistMessageWindow: vi.fn(async () => ({ source: "control-plane", messages: [{ id: "past", kind: "text", role: "user", text: "History" }] })),
    reconcileHistoryMessages: (messages: unknown[]) => messages, messageSnapshotsEqual: (a: unknown[], b: unknown[]) => JSON.stringify(a) === JSON.stringify(b),
    seedPersistedMessageRefs: vi.fn(), reconcileChatMessages: vi.fn(),
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
  const composer: any = { ...lifecycle, getFollowUpBehavior, chatId: "chat", readOnly: false, runtimeUpgradeRequired: false, cloudComputerV2: cloud, chatThread: workspace.chats[0], workspaceProvisioning: false,
    session: { transcriptState: resident ? "resident" : "loading", status: "reconnecting", agentId: "codex", startSession: vi.fn(async () => {}),
      sendPrompt: cloud ? (...args: unknown[]) => provider.actions.sendPrompt("chat", ...args.slice(0, 5), undefined, args[5], args[6], args[7], args[8]) : localSend },
    agentSessions: { getSendGeneration: () => cancellation }, cloudWorkspaceDocument: () => doc, parseCloudWorkspaceKey, isCloudWorkspace,
    cloudQueuedPrompt, redactLogSecrets: (s: string) => s, setCloudSendError: cloudError,
    notifyAgentSendFailure: failureNotice, crypto: provider.crypto,
    designFrameContext: { capture: () => null, pin: vi.fn() }, hasPendingTextAttachmentDelivery: () => false, transcriptAttachesRef: { current: new Set() },
    useSessionsStore: { getState: () => store }, useWorkspaceStore: { getState: () => workspace }, transcriptParkedChatRef: { current: null },
    serializeComposerState: () => current, sendPastPermission: () => "send", planReview: null, bareInlineSlashCommand: () => null,
    composerLiveRef: { current: null }, dispatch, recordWorkspaceActivity: vi.fn(), agentsList: null, envForChat: () => ({}),
    setCloudSendPreparing: vi.fn(), setSendPreparing: vi.fn(), encodeComposerAttachments: encoding.run, reportSkippedAttachments: vi.fn(),
    expandMentionsInText: (text: string) => text, browserPickerSelection: null, toMessageSegments: () => draft.segments, isSubmittedComposerDocument,
    clearComposer: clear, pendingSendScrollCountRef: { current: 0 }, sendInFlightRef: { current: false }, startCloudSubmitSpan: () => vi.fn(), toast: toasts,
  };
  vm.runInNewContext(composerCode, composer);
  return { account, provider, composer, queue, store, prepare, delivered, clear, dispatch, cloudError, toasts, draft, failureNotice,
    send: () => composer.actions.handleSend(), ready: () => { doc.status = "ready"; wake.resolve(); initialize.resolve(); },
    type: (text: string) => { current = { ...draft, displayText: text, json: { text }, attachments: [], segments: [{ type: "text", text }] }; },
    finish: () => { sending.clear(); store.sessions.chat.status = "ready"; provider.actions.drainNextQueued("chat"); },
    stop: () => { cancellation++; provider.cancelGenerationsRef.current.set("chat", cancellation); wait.cancel("chat"); },
  };
}

describe("cloud composer readiness queue", () => {
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

  it("retains one wake intent across seven settled readiness attempts and final preparation", async () => {
    const h = harness(true, "ready");
    h.prepare.mockResolvedValue(undefined);
    h.provider.ensureSessionRef.current.mockResolvedValue(undefined);
    await h.send(); await vi.advanceTimersByTimeAsync(12_000);
    expect(h.prepare).toHaveBeenCalledTimes(7);
    const intent = h.prepare.mock.calls[0][1];
    expect(intent?.id).toEqual(expect.any(String));
    for (const call of h.prepare.mock.calls) expect(call[1]).toBe(intent);
    Object.assign(h.store.sessions.chat, { status: "ready", sessionId: "admitted" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.delivered).toHaveBeenCalledOnce();
    expect(h.prepare).toHaveBeenCalledTimes(9);
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
  it.each(["stopped", "ready"])("retains the draft and notifies once without preparing or queueing on a known runtime block in %s", async status => {
    mocks.failureToast.mockClear();
    const h = harness(true, status);
    h.composer.chatId = `runtime-blocked-${status}`;
    h.composer.runtimeUpgradeRequired = true;
    h.failureNotice.mockImplementation(notifyAgentSendFailure);
    await h.send(); await h.send();
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.queue.size).toBe(0); expect(h.delivered).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled(); expect(h.dispatch).not.toHaveBeenCalled();
    expect(mocks.failureToast).toHaveBeenCalledExactlyOnceWith("This workspace is on an older runtime", expect.objectContaining({
      description: "Gets the new cloud runtime the next time this workspace wakes",
    }));
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
  it("preserves Local sends' existing runtime availability guard", async () => {
    const h = harness(false); h.composer.runtimeUpgradeRequired = true; await h.send();
    expect(h.composer.session.sendPrompt).not.toHaveBeenCalled(); expect(h.clear).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.cloudError).not.toHaveBeenCalled();
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
    await vi.advanceTimersByTimeAsync(179_999); expect(h.store.sessions.chat.cloudSendWait.state).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1); expect(h.store.sessions.chat.cloudSendWait).toMatchObject({ state: "failed", message: expect.stringContaining("three minutes") });
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
  it("consumes a closed readiness refusal without errors, then dispatches once", async () => {
    const h = harness(); h.prepare.mockRejectedValueOnce(new Error("cloud_workspace_not_ready"));
    await h.send(); await vi.advanceTimersByTimeAsync(0);
    expect(h.store.sessions.chat.cloudSendWait.state).toBe("waiting"); h.ready();
    await vi.advanceTimersByTimeAsync(2_000); expect(h.delivered).toHaveBeenCalledOnce(); expect(h.toasts.error).not.toHaveBeenCalled();
  });
  it("uses AG's human reason for a closed terminal refusal without retrying admission", async () => {
    const h = harness(); h.prepare.mockRejectedValue(new Error("cloud_agent_credential_expired"));
    await h.send(); await vi.advanceTimersByTimeAsync(5_000);
    expect(h.prepare).toHaveBeenCalledOnce(); expect(h.store.sessions.chat.cloudSendWait).toMatchObject({ state: "failed", message: "Your Codex connection expired. Reconnect to continue" });
    expect(h.store.sessions.chat.cloudAdmissionFailure).toMatchObject({ action: "reconnect", turnId: h.queue.get("chat")![0].bubbleId });
    expect(h.queue.get("chat")).toHaveLength(1); expect(h.delivered).not.toHaveBeenCalled(); expect(h.toasts.error).not.toHaveBeenCalled();
    expect(h.failureNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ error: expect.objectContaining({ message: "cloud_agent_credential_expired" }),
      attemptId: h.queue.get("chat")![0].bubbleId }));
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
  it.each([150_000, 360_000])("delivers once after a %i ms wake/replacement with no readiness failure", async duration => {
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
  it("reports a terminal document error while a wake preparation is still hung", async () => {
    const h = harness(); await h.send();
    const doc = h.provider.cloudWorkspaceDocument(); doc.status = "setting_up"; doc.error = { message: "Setup failed" };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.failureNotice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "workspace_unavailable", error: expect.objectContaining({ message: "Setup failed" }) }));
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
  it("suppresses readiness toasts only for cloud queued waits and preserves Local initialization errors", () => {
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
    expect(effects[0]).toContain("toast.error");
    const code = ts.transpileModule(`(() => { ${effects[0]!} })();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    for (const folder of ["cloud://fixture", "/local/personal", "/organization/local"]) {
      const refs: Array<{ current: unknown }> = [];
      let cursor = 0;
      const toast = { error: vi.fn() }, env = { interactive: true, cloudComputerV2: true, isCloudWorkspace,
        chatThread: { folder }, session: { status: "warming", agentId: "codex", cloudSendWait: { state: "waiting" } },
        isErrorState: false, cloudCatalogGeneration: () => 1, labelForFailure: () => "Agent failed",
        useRef: (initial: unknown) => refs[cursor++] ?? (refs[cursor - 1] = { current: initial }),
        useEffect: (run: () => void) => run(), isTransportShaped: () => false, agentSessions: {}, toast, chatId: "chat" };
      vm.runInNewContext(code, env);
      // Observe a new failure, not a historical failed snapshot on mount.
      env.session.status = "failed";
      env.isErrorState = true;
      cursor = 0;
      vm.runInNewContext(code, env);
      expect(toast.error).toHaveBeenCalledTimes(isCloudWorkspace(folder) ? 0 : 1);
    }
  });
});
