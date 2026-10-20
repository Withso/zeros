import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudAgentBootConversationSchema } from "@zeros/protocol/cloud-agent-bootstrap";

const h = vi.hoisted(() => ({ invoke: vi.fn(), allowed: true }));
vi.mock("../runtime", async original => ({ ...await original<typeof import("../runtime")>(), isElectron: () => true, nativeInvoke: h.invoke }));
vi.mock("../observability/logging/renderer-log", () => ({ logEvent: vi.fn() }));
vi.mock("../../state/cloud-workspace-catalog", () => ({ canReadCloudWorkspace: () => h.allowed, cloudWorkspaceCatalogConfirmed: () => true,
  cloudWorkspaceDocument: () => ({ status: "running" }), getCloudWorkspaceRows: () => [] }));

import { CloudTranscriptCacheStore } from "../../../../electron/cloud-transcript-cache-store";
import { setCloudTranscriptCacheOwner, onCloudHistoryRestoreHead, cloudHistoryRestoreHead, installCloudHistoryRestoreMetadata,
  readCachedCloudTranscriptWindow, peekCloudTranscriptWindow } from "../cloud-transcript-cache";
import { cloudHistoryFenceHasTranscript, cloudHistoryFencesMatch, type CloudHistoryRestoreFence,
  type CloudTranscriptOwner, type CloudTranscriptPrune, type CachedTranscriptWindow } from "../cloud-transcript-cache-contract";
import { WorkspaceRuntimeClient } from "../bridge/workspace-runtime-client";
import type { RuntimeClient } from "../bridge/ws-client";
import { setActiveBridge } from "../bridge/active-bridge";
import { cloudScopedId, cloudWorkspaceKey, parseCloudScopedId, isCloudWorkspace } from "../bridge/cloud-workspace-key";
import { windowMessagesSnapshot, fromPersistedMessage } from "../../features/agent/agent-history-client";
import { BLANK, useSessionsStore, mergeWindowedTail } from "../../features/agent/sessions-store";
import { reconcileHistoryMessages } from "../../features/agent/history-message-identity";
import { messageSnapshotsEqual, retainMessageReferences } from "../../features/agent/message-persistence-tracker";
import { isCurrentTranscriptRequest, releaseTranscriptRequest, NativeTranscriptSnapshots } from "../../features/agent/transcript-retention";
import { consumeFreshCloudChat } from "../../features/agent/fresh-cloud-chats";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const owner = { accountId: "account-a", ...target, chatId: "chat-a" };
const chatId = cloudScopedId(target, owner.chatId);
const cacheEpoch = "99999999-9999-4999-8999-999999999999";
const projection = { ...target, generation: 2, engineInstanceId: "33333333-3333-4333-8333-333333333333",
  bootId: "44444444-4444-4444-8444-444444444444", writerEpoch: "55555555-5555-4555-8555-555555555555",
  fundingOwnerUserId: "66666666-6666-4666-8666-666666666666", fundingOwnerEpoch: 1,
  version: 1 as const, mode: "boot-owner-v1" as const, fundingScope: "workspace-roles-v1" as const,
  mirroredSequence: 10, sealedSequence: null, complete: false };
const head: NonNullable<CloudHistoryRestoreFence["head"]> = { conversationId: owner.chatId, originWriterEpoch: projection.writerEpoch,
  source: { kind: "mutation", mutationId: "77777777-7777-4777-8777-777777777777", operation: "repair" },
  restoreRevision: 2, deleted: false, recordSequence: null, eventSequence: null, manifestSha256: null, incompleteReason: "capture_unavailable" };
const row = (text = "Previously read native transcript") => ({ msgId: "reply", kind: "text", createdAt: 1,
  payload: JSON.stringify({ id: "reply", kind: "text", role: "agent", text, createdAt: 1 }) });
const metadata = (incomplete = true) => ({ projection, historyHeads: [{ ...head, ...(incomplete ? {} : {
  recordSequence: 4, eventSequence: 8, manifestSha256: "a".repeat(64), incompleteReason: null }) }] });
const clients: WorkspaceRuntimeClient[] = [];
let directory: string, disk: CloudTranscriptCacheStore;
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function runtime(read: () => Promise<Record<string, unknown>>, native = true, incomplete = true) {
  const { mirroredSequence: _mirrored, sealedSequence: _sealed, complete: _complete, ...identity } = projection;
  const binding = CloudAgentBootConversationSchema.parse({ ...identity, authorityEpoch: 1, cacheRevision: 1, desiredCacheRevision: 1,
    initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })) });
  const handlers = new Map<string, Set<(event: never) => void>>();
  const nativeClient = { status: "connected", activatedCloudAgentBootBinding: binding,
    executionIdentity: { kind: "cloud", ...target, generation: 2, engineInstanceId: projection.engineInstanceId, authorityEpoch: 1, bootScope: identity },
    request: vi.fn(async (request: { op: string }) => ({ type: "WORKSPACE_RESPONSE", op: request.op,
      result: request.op === "chats.list" ? { chats: [{ id: owner.chatId, folder: "/workspace/repo" }], chatDeletions: [], ...metadata(incomplete) } : await read() })),
    on: (type: string, handler: (event: never) => void) => { const set = handlers.get(type) ?? new Set(); set.add(handler); handlers.set(type, set); return () => set.delete(handler); },
    onStatusChange: () => () => {} } as unknown as RuntimeClient;
  const open = vi.fn(async () => ({ client: nativeClient, scope: { ...target, root: "/workspace/repo", engineWorkspaceId: "main" },
    generation: 2, runtimeId: "admitted-native", release: vi.fn() }));
  const client = new WorkspaceRuntimeClient({ open, readHistory: native ? async () => ({ chats: [], chatDeletions: [] }) : read,
    workspaces: () => [], canAccess: () => h.allowed });
  clients.push(client); setActiveBridge(client);
  return { client, open, emit: (event: Record<string, unknown>) => { for (const callback of handlers.get(String(event.type)) ?? []) callback(event as never); } };
}

// Execute the production hydrate callback against the actual shared reader and
// sessions store; a stubbed cache callback cannot exercise restart persistence.
const source = ts.createSourceFile("sessions-provider.tsx", readFileSync(new URL("../../features/agent/sessions-provider.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let hydrateCode = "";
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "hydrateChat" && node.initializer && ts.isCallExpression(node.initializer))
    hydrateCode = ts.transpileModule(`globalThis.hydrate = ${node.initializer.arguments[0]!.getText(source)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  ts.forEachChild(node, visit);
}
visit(source);
function hydrator(bridge: WorkspaceRuntimeClient | null) {
  const requests = new Map<string, Promise<void>>(), pending = new Set<string>();
  const context: Record<string, unknown> = { console: { warn: vi.fn() }, BLANK, parseCloudScopedId, isCloudWorkspace, cloudComputerV2: true,
    HYDRATE_WINDOW: 200, reconcileHistoryMessages, messageSnapshotsEqual, retainMessageReferences, isCurrentTranscriptRequest, releaseTranscriptRequest,
    mergeWindowedTail, getStore: useSessionsStore.getState, bridge, reconcileChatMessages: vi.fn(), persistMessageWindow: windowMessagesSnapshot,
    cloudHistoryRestoreHead, cloudHistoryFenceHasTranscript, cloudHistoryFencesMatch, cloudHasNativeTranscript: () => false,
    readCachedCloudTranscriptWindow, peekCloudTranscriptWindow, fromPersistedMessage,
    hydrateCloudSendRef: { current: vi.fn(async () => {}) }, nativeTranscriptSnapshotsRef: { current: new NativeTranscriptSnapshots() },
    hydrateInFlightRef: { current: requests }, pendingHydratesRef: { current: pending }, consumeFreshCloudChat,
    useWorkspaceStore: { getState: () => ({ chats: [] }) } };
  vm.runInNewContext(hydrateCode, context);
  return { hydrate: context.hydrate as (id: string) => Promise<void>, pending };
}
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "zeros-native-transcript-test-")); disk = new CloudTranscriptCacheStore(directory);
  h.allowed = true; useSessionsStore.getState().clearAll(); setCloudTranscriptCacheOwner(owner.accountId);
  h.invoke.mockReset().mockImplementation(async (command: string, input: CloudTranscriptOwner & CloudTranscriptPrune & { window?: CachedTranscriptWindow; historyEpoch?: string }) => {
    const exactOwner = { accountId: input.accountId, organizationId: input.organizationId, workspaceId: input.workspaceId, chatId: input.chatId };
    if (command === "cloud_transcript_cache_read") return { cacheEpoch, ...disk.readReceipt(exactOwner) };
    if (command === "cloud_transcript_cache_write") { disk.write(exactOwner, input.window, input.historyEpoch); return; }
    if (command === "cloud_transcript_cache_prune") { disk.prune(input); return { cacheEpoch, ...disk.readReceipt(exactOwner) }; }
  });
});
afterEach(() => { setActiveBridge(null); setCloudTranscriptCacheOwner(null); for (const client of clients.splice(0)) client.dispose();
  useSessionsStore.getState().clearAll(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("native cloud transcript persistence across app restart", () => {
  it("paints an existing disk window while startup is still waiting for a bridge", async () => {
    const fence = { projection, conversationId: owner.chatId, head: metadata(false).historyHeads[0]! };
    disk.prune({ ...owner, restoreHead: fence, historyEpoch: disk.readReceipt(owner).historyEpoch });
    disk.write(owner, { recordEpoch: null, revision: 4, cursor: "reply", messages: [row()], restoreHead: fence }, disk.readReceipt(owner).historyEpoch);
    expect(disk.read(owner)?.messages.map(message => JSON.parse(message.payload))).toEqual([JSON.parse(row().payload)]);
    disk = new CloudTranscriptCacheStore(directory); setActiveBridge(null);
    useSessionsStore.getState().setSession(chatId, { ...BLANK, cwd: cloudWorkspaceKey(target), hasTranscript: true, transcriptState: "cold" });
    const hydrate = hydrator(null); await hydrate.hydrate(chatId);
    await vi.waitFor(() => expect(useSessionsStore.getState().sessions[chatId]?.messages).toMatchObject([{ text: "Previously read native transcript" }]));
    expect(hydrate.pending.has(chatId)).toBe(true);
    expect(useSessionsStore.getState().sessions[chatId]).toMatchObject({ transcriptState: "loading", transcriptPresentation: { source: "cache" } });
  });

  it.each([true, false])("saves a verified native read and paints disk while revalidation is held (incomplete=%s)", async incomplete => {
    const first = runtime(async () => ({ messages: [row()], ...metadata(incomplete) }), true, incomplete);
    await first.client.warmWorkspace(target);
    const original = await windowMessagesSnapshot(chatId, 200);
    expect(original.source).toBe("native"); expect(original.isCurrent?.()).toBe(true);
    await vi.waitFor(() => expect(disk.read(owner)?.messages.map(message => JSON.parse(message.payload))).toEqual([JSON.parse(row().payload)]));
    expect(disk.read(owner)?.restoreHead?.head).toEqual(metadata(incomplete).historyHeads[0]);
    first.client.dispose(); setCloudTranscriptCacheOwner(owner.accountId);
    disk = new CloudTranscriptCacheStore(directory); useSessionsStore.getState().clearAll();
    const server = deferred<Record<string, unknown>>(), restarted = runtime(() => server.promise, false);
    useSessionsStore.getState().setSession(chatId, { ...BLANK, cwd: cloudWorkspaceKey(target), hasTranscript: true, transcriptState: "cold" });
    const unsubscribe = onCloudHistoryRestoreHead((id, fence, origin) => useSessionsStore.getState().applyCloudHistoryRestoreHead(id, fence, false, origin !== "disk"), true);
    try {
      const hydrate = hydrator(restarted.client); let settled = false;
      const loading = hydrate.hydrate(chatId).then(() => { settled = true; });
      await vi.waitFor(() => expect(useSessionsStore.getState().sessions[chatId]?.messages).toMatchObject([{ text: "Previously read native transcript" }]));
      const painted = useSessionsStore.getState().sessions[chatId]!.messages;
      expect(settled).toBe(false);
      expect(useSessionsStore.getState().sessions[chatId]).toMatchObject({ transcriptState: "loading", transcriptPresentation: { source: "cache" } });
      expect(restarted.open).not.toHaveBeenCalled();
      // A CP observation of this exact incomplete head cannot blank the native
      // presentation or promote it to restored/complete history.
      await installCloudHistoryRestoreMetadata(target, metadata(incomplete), [owner.chatId]);
      server.resolve({ messages: incomplete ? [] : [row()], ...metadata(incomplete) }); await loading;
      expect(useSessionsStore.getState().sessions[chatId]!.messages).toBe(painted);
      expect(cloudHistoryFenceHasTranscript(cloudHistoryRestoreHead(chatId)!)).toBe(!incomplete);
      expect(useSessionsStore.getState().sessions[chatId]!.transcriptState).toBe(incomplete ? "loading" : "resident");
    } finally { unsubscribe(); server.resolve({ messages: [], ...metadata(incomplete) }); }
  });

  it("does not persist an incomplete CP page as a native observation", async () => {
    runtime(async () => ({ messages: [row()], ...metadata() }), false);
    expect((await windowMessagesSnapshot(chatId, 200)).source).toBe("control-plane");
    expect(disk.read(owner)).toBeNull();
  });

  it("keeps disk paint when fast CP revalidation installs the exact incomplete head during the disk read", async () => {
    const first = runtime(async () => ({ messages: [row()], ...metadata() }));
    await first.client.warmWorkspace(target); await windowMessagesSnapshot(chatId, 200);
    await vi.waitFor(() => expect(disk.read(owner)?.messages).toHaveLength(1));
    first.client.dispose(); setCloudTranscriptCacheOwner(owner.accountId); disk = new CloudTranscriptCacheStore(directory);
    const release = deferred<void>(), invoke = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (command, args) => {
      const result = await invoke(command, args);
      if (command === "cloud_transcript_cache_read") await release.promise;
      return result;
    });
    const restarted = runtime(async () => {
      await installCloudHistoryRestoreMetadata(target, metadata(), [owner.chatId]);
      return { messages: [], ...metadata() };
    }, false);
    useSessionsStore.getState().setSession(chatId, { ...BLANK, cwd: cloudWorkspaceKey(target), hasTranscript: true, transcriptState: "cold" });
    h.invoke.mockClear();
    const loading = hydrator(restarted.client).hydrate(chatId);
    try {
      await vi.waitFor(() => expect(h.invoke.mock.calls.filter(([command]) => command === "cloud_transcript_cache_read")).toHaveLength(2));
    } finally { release.resolve(); }
    await loading;
    expect(useSessionsStore.getState().sessions[chatId]).toMatchObject({ messages: [{ text: "Previously read native transcript" }],
      transcriptState: "loading", transcriptPresentation: { source: "cache" } });
    expect(restarted.open).not.toHaveBeenCalled();
  });

  it("refuses a native response after its original peer retires", async () => {
    const server = deferred<Record<string, unknown>>(), first = runtime(() => server.promise);
    await first.client.warmWorkspace(target);
    const read = windowMessagesSnapshot(chatId, 200), rejected = expect(read).rejects.toThrow();
    first.client.clearCloudConnections(); server.resolve({ messages: [row()], ...metadata() });
    await rejected; expect(disk.read(owner)).toBeNull();
    expect(await readCachedCloudTranscriptWindow(chatId)).toBeNull();
  });

  it.each(["edit", "delete", "absent", "boot", "writer", "funding"] as const)("retires native disk bytes and their old write nonce after %s", async change => {
    const first = runtime(async () => ({ messages: [row()], ...metadata(false) }), true, false);
    await first.client.warmWorkspace(target); await windowMessagesSnapshot(chatId, 200);
    await vi.waitFor(() => expect(disk.read(owner)?.messages).toHaveLength(1));
    const old = disk.readReceipt(owner), next = metadata(false);
    if (change === "edit") next.historyHeads[0] = { ...next.historyHeads[0]!, restoreRevision: 3,
      source: { kind: "mutation", mutationId: cacheEpoch, operation: "edit" } };
    if (change === "delete") next.historyHeads[0] = { ...next.historyHeads[0]!, restoreRevision: 3, deleted: true };
    if (change === "absent") next.historyHeads = [];
    if (change === "boot") next.projection = { ...projection, bootId: cacheEpoch };
    if (change === "writer") next.projection = { ...projection, writerEpoch: cacheEpoch };
    if (change === "funding") next.projection = { ...projection, fundingOwnerEpoch: 2 };
    await installCloudHistoryRestoreMetadata(target, next, [owner.chatId]);
    disk.write(owner, old.window, old.historyEpoch);
    expect(disk.read(owner)).toBeNull();
    expect(new CloudTranscriptCacheStore(directory).read(owner)).toBeNull();
    expect(await readCachedCloudTranscriptWindow(chatId)).toBeNull();
  });

  it.each(["peer", "account", "access"] as const)("rechecks the original native receipt after held cache I/O and %s retirement", async retirement => {
    const first = runtime(async () => ({ messages: [row()], ...metadata() }));
    const release = deferred<void>(), invoke = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (command, args) => {
      const result = await invoke(command, args);
      if (command === "cloud_transcript_cache_read") await release.promise;
      return result;
    });
    h.invoke.mockClear();
    try {
      // Hold the first head installation too: warming must not finish that
      // disk receipt before the native read joins the pending cache fence.
      await first.client.warmWorkspace(target);
      const page = await windowMessagesSnapshot(chatId, 200);
      expect(page.isCurrent?.()).toBe(true);
      expect(h.invoke.mock.calls.some(([command]) => command === "cloud_transcript_cache_read")).toBe(true);
      if (retirement === "peer") first.client.clearCloudConnections();
      if (retirement === "account") { setCloudTranscriptCacheOwner("account-b"); setCloudTranscriptCacheOwner(owner.accountId); }
      if (retirement === "access") h.allowed = false;
      expect(page.isCurrent?.()).toBe(false);
    } finally { release.resolve(); }
    // The held native read above establishes the race. Drain the released
    // finite IPC promise chain before checking that no write was admitted.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.invoke.mock.calls.filter(([command]) => command === "cloud_transcript_cache_write")).toHaveLength(0);
    expect(disk.read(owner)).toBeNull();
  });

  it("replaces an earlier native observation under the same head and keeps later CP cache writes from regressing it", async () => {
    let text = "Earlier native window";
    const first = runtime(async () => ({ messages: [row(text)], ...metadata(false) }), true, false);
    first.client.on("DB_CHANGED", () => {});
    await first.client.warmWorkspace(target); await windowMessagesSnapshot(chatId, 200);
    await vi.waitFor(() => expect(disk.read(owner)?.messages).toHaveLength(1));
    text = "Newest native window";
    first.emit({ type: "DB_CHANGED", kinds: ["messages"], chatIds: [owner.chatId] });
    await windowMessagesSnapshot(chatId, 200);
    await vi.waitFor(() => expect(JSON.parse(disk.read(owner)!.messages[0]!.payload).text).toBe(text));
    const saved = disk.readReceipt(owner);
    disk.write(owner, { recordEpoch: null, revision: 1000, cursor: "reply", messages: [row("Older CP capture")], restoreHead: saved.restoreHead }, saved.historyEpoch);
    expect(JSON.parse(disk.read(owner)!.messages[0]!.payload).text).toBe(text);
  });
});
