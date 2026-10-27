import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatSummaryWire } from "../agent-history-client";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";

const fixture = vi.hoisted(() => ({ read: vi.fn(), backend: "https://api.example.test", workspaceKnown: true }));
vi.mock("../agent-history-client", async original => ({
  ...await original<typeof import("../agent-history-client")>(), listChatSummariesForFolder: fixture.read,
}));
vi.mock("../../team/control-plane", async original => ({
  ...await original<typeof import("../../team/control-plane")>(), get CONTROL_PLANE_URL() { return fixture.backend; },
}));
vi.mock("../../../state/use-projects", () => ({
  useProjectForFolder: () => ({ repoSlug: "fixture" }),
  useWorkspacesFor: () => ({ workspaces: fixture.workspaceKnown ? [{ path: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", id: "fixture", branch: "work", baseBranch: "main" }] : [] }),
}));
vi.mock("../../../shell/conversation/conversation-header", () => ({ OpenInBadgeMenu: () => "Workspace" }));
vi.mock("../../../shell/workbench/tabs/setup-tab", () => ({ useOpenScriptsSettings: () => () => {} }));
vi.mock("../use-workspace-setup-summary", () => ({ useWorkspaceSetupSummary: () => ({ hasCommand: null, state: null }) }));
vi.mock("dompurify", () => ({ default: { addHook: vi.fn(), sanitize: (value: string) => value } }));

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const folder = cloudWorkspaceKey(target), id = (name: string) => cloudScopedId(target, name);
const user = { sub: "account-a", email: "fixture@example.test", name: null, provider: "workos" as const };
const row = (name = "saved", cwd = folder): ChatSummaryWire => ({
  chatId: id(name), title: "Untitled", folder: cwd, summary: "Research the project", summaryAt: 0,
  agentId: "codex", agentName: "Codex", userMessageCount: 1, lastMessageAt: 1,
});
const storage = new Map<string, string>();
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(100_000);
  fixture.backend = "https://api.example.test"; fixture.workspaceKnown = true; fixture.read.mockReset().mockResolvedValue([row()]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage, setTimeout, clearTimeout }));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); storage.clear(); });
async function modules() {
  const [summaries, identity, workspace, sessions, transcript, boot] = await Promise.all([
    import("../use-chat-transcript-summaries"), import("../../../state/account-presentation"),
    import("../../../state/workspace-store"), import("../sessions-store"),
    import("../../../state/local-transcript-cache"), import("../../../state/chat-boot-cache"),
  ]);
  identity.installAccountPresentationIdentity(user);
  return { ...summaries, ...identity, ...workspace, ...sessions, ...transcript, ...boot };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function render(m: Awaited<ReturnType<typeof modules>>, chatId: string) {
  const [{ ChatProvenance }, { ChatTranscriptPills }, { TooltipProvider }] = await Promise.all([
    import("../chat-provenance"), import("../chat-transcript-pills"), import("../../../shared/ui/primitives/tooltip"),
  ]);
  function Provenance() {
    const value = m.useChatTranscriptSummaries(folder, chatId);
    return createElement(ChatProvenance, { folder, hasTranscripts: value.loaded ? value.summaries.length > 0 : null },
      createElement(ChatTranscriptPills, { summaries: value.summaries, attachedChatIds: new Set<string>(), pendingChatIds: new Set<string>(),
        onAttach: vi.fn(), onRemove: vi.fn(), onCancel: vi.fn(), onOpenChat: vi.fn() }));
  }
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Provenance)));
}

it("shares a cloud folder read and paints its persisted pills in two new tabs on the first render after restart", async () => {
  let m = await modules();
  m.warmChatTranscriptSummaries(folder, id("new-a"));
  m.warmChatTranscriptSummaries(folder, id("new-b"));
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.read).toHaveBeenCalledExactlyOnceWith({ folder });
  m.flushPersistedTranscriptSummaries();
  vi.resetModules(); m = await modules();
  const held = deferred<ChatSummaryWire[]>(); fixture.read.mockReturnValue(held.promise);
  m.warmChatTranscriptSummaries(folder, id("new-a"));
  for (const name of ["new-a", "new-b"]) {
    const html = await render(m, id(name));
    expect(html).toContain("Add chat transcripts");
    expect(html).toContain("Research the project");
    expect(html).not.toContain(">Created<"); expect(html).not.toContain(">Branched<");
  }
  held.reject(new Error("Stopped VM")); await vi.advanceTimersByTimeAsync(0);
  expect(await render(m, id("new-b"))).toContain("Research the project");
});

it.each(["resident", "cached"])("seeds both new cloud tabs from a %s user prompt while every summary read is held", async source => {
  const m = await modules(), held = deferred<ChatSummaryWire[]>(); fixture.read.mockReturnValue(held.promise);
  const chats = ["saved", "new-a", "new-b"].map(name => m.sanitizeCachedChat({ id: id(name), folder, title: "Untitled" })!);
  m.useWorkspaceStore.setState({ chats });
  const messages = [{ id: "prompt", kind: "text" as const, role: "user" as const, text: "Research the project", createdAt: 1 }];
  if (source === "resident") m.useSessionsStore.getState().setSession(id("saved"), { ...m.BLANK, cwd: folder, transcriptState: "resident", messages });
  else m.cloudTranscriptCache.remember(id("saved"), folder, { messages, leadingPrompt: null });
  m.warmChatTranscriptSummaries(folder, id("new-a"));
  for (const name of ["new-a", "new-b"]) {
    const html = await render(m, id(name));
    expect(html).toContain("Add chat transcripts"); expect(html).not.toContain(">Created<"); expect(html).not.toContain(">Branched<");
  }
  held.resolve([]); await vi.advanceTimersByTimeAsync(0);
});

it("does not invent history for untouched Untitled tabs", async () => {
  const m = await modules(); fixture.read.mockResolvedValue([]);
  m.useWorkspaceStore.setState({ chats: ["new-a", "new-b"].map(name => m.sanitizeCachedChat({ id: id(name), folder, title: "Untitled" })!) });
  m.warmChatTranscriptSummaries(folder, id("new-a")); await vi.advanceTimersByTimeAsync(0);
  const html = await render(m, id("new-b"));
  expect(html).toContain(">Created<"); expect(html).toContain(">Branched<"); expect(html).not.toContain("Add chat transcripts");
});

it("paints known cloud pills even while the workspace-detail read is held", async () => {
  const m = await modules(); fixture.workspaceKnown = false;
  m.noteLocalChatPrompt({ chatId: id("saved"), folder, text: "Research the project" });
  expect(await render(m, id("new-a"))).toContain("Add chat transcripts");
  const { ChatProvenance } = await import("../chat-provenance");
  expect(renderToStaticMarkup(createElement(ChatProvenance, { folder: "/local", hasTranscripts: true }, "Local child"))).toBe("");
});

it("overlays a cloud first prompt immediately and reconciles by chat id and count", async () => {
  const m = await modules();
  m.noteLocalChatPrompt({ chatId: id("saved"), folder, text: "Research the project", at: 100_000 });
  expect(m.visibleTranscriptSummaries(folder, [], id("new-a"))).toMatchObject([{ chatId: id("saved"), userMessageCount: 1 }]);
  expect(m.visibleTranscriptSummaries(folder, [], id("saved"))).toEqual([]);
  fixture.read.mockResolvedValue([{ ...row(), lastMessageAt: 100_000 }]);
  m.warmChatTranscriptSummaries(folder, id("new-a")); await vi.advanceTimersByTimeAsync(0);
  expect(m.visibleTranscriptSummaries(folder, [], id("new-a"))).toEqual([]);
});

it("restores a confirmed cloud folder list synchronously without a read", async () => {
  let m = await modules();
  m.warmChatTranscriptSummaries(folder, id("new-a")); await vi.advanceTimersByTimeAsync(0);
  m.flushPersistedTranscriptSummaries(); vi.resetModules(); m = await modules();
  expect(m.transcriptSummariesSnapshotForTesting(folder, id("new-a")).data).toEqual([row()]);
  expect(fixture.read).toHaveBeenCalledOnce();
});

it.each(["sign-out", "account", "backend"])("purges cloud summary presentation on %s and keeps Local", async boundary => {
  const m = await modules();
  fixture.read.mockImplementation(async ({ folder: cwd }) => [cwd === folder ? row() : { ...row("local", cwd), chatId: "local" }]);
  m.warmChatTranscriptSummaries(folder, id("new-a")); m.warmChatTranscriptSummaries("/local", "new");
  await vi.advanceTimersByTimeAsync(0); m.flushPersistedTranscriptSummaries();
  if (boundary === "backend") fixture.backend = "https://replacement.example.test";
  m.installAccountPresentationIdentity(boundary === "sign-out" ? null : boundary === "account" ? { ...user, sub: "account-b" } : user);
  expect(m.transcriptSummariesSnapshotForTesting(folder, id("new-a")).data).toBeUndefined();
  expect(m.transcriptSummariesSnapshotForTesting("/local", "new").data).toHaveLength(1);
  expect([...storage.values()].some(value => value.includes('"summary":"Research the project"') && value.includes(id("saved")))).toBe(false);
});

it("fences a held cloud summary response across A → B → A", async () => {
  const m = await modules(), held = deferred<ChatSummaryWire[]>(); fixture.read.mockReturnValue(held.promise);
  m.warmChatTranscriptSummaries(folder, id("new-a")); await vi.advanceTimersByTimeAsync(0);
  m.installAccountPresentationIdentity({ ...user, sub: "account-b" }); m.installAccountPresentationIdentity(user);
  held.resolve([row()]); await vi.advanceTimersByTimeAsync(0); m.flushPersistedTranscriptSummaries();
  expect(m.transcriptSummariesSnapshotForTesting(folder, id("new-a")).data).toBeUndefined();
  expect([...storage.values()].some(value => value.includes(id("saved")))).toBe(false);
});

it.each(["chat", "workspace", "confirmed list"])("prunes persisted cloud summaries on %s deletion", async boundary => {
  const m = await modules();
  m.warmChatTranscriptSummaries(folder, id("new-a")); await vi.advanceTimersByTimeAsync(0);
  m.noteLocalChatPrompt({ chatId: id("saved"), folder, text: "Second prompt" });
  const dispatch = m.useWorkspaceStore.getState().dispatch;
  if (boundary === "chat") dispatch({ type: "DELETE_CHAT", id: id("saved") });
  else if (boundary === "workspace") dispatch({ type: "PRUNE_CLOUD_WORKSPACES", folders: [folder] });
  else dispatch({ type: "HYDRATE_CHATS", chats: [], activeChatId: null, confirmedCloudWorkspaces: [folder] });
  m.flushPersistedTranscriptSummaries();
  expect(m.transcriptSummariesSnapshotForTesting(folder, id("new-a")).data ?? []).toEqual([]);
  expect(m.visibleTranscriptSummaries(folder, [], id("new-a"))).toEqual([]);
  vi.resetModules(); const restarted = await modules();
  expect(restarted.transcriptSummariesSnapshotForTesting(folder, id("new-b")).data ?? []).toEqual([]);
});

it("cannot recreate a deleted workspace snapshot from a held first read", async () => {
  const m = await modules(), held = deferred<ChatSummaryWire[]>(); fixture.read.mockReturnValue(held.promise);
  m.warmChatTranscriptSummaries(folder, id("new-a")); await vi.advanceTimersByTimeAsync(0);
  m.useWorkspaceStore.getState().dispatch({ type: "PRUNE_CLOUD_WORKSPACES", folders: [folder] });
  held.resolve([row()]); await vi.advanceTimersByTimeAsync(0); m.flushPersistedTranscriptSummaries();
  vi.resetModules(); const restarted = await modules();
  expect(restarted.transcriptSummariesSnapshotForTesting(folder, id("new-a")).data ?? []).toEqual([]);
});

it("keeps the confirmed array reference after an unchanged refresh and after a failed read", async () => {
  const m = await modules();
  m.warmChatTranscriptSummaries(folder, id("new-a")); await vi.advanceTimersByTimeAsync(0);
  const confirmed = m.transcriptSummariesSnapshotForTesting(folder, id("new-a")).data;
  await vi.advanceTimersByTimeAsync(31_000);
  fixture.read.mockResolvedValue([{ ...row() }]);
  m.warmChatTranscriptSummaries(folder, id("new-b")); await vi.advanceTimersByTimeAsync(0);
  expect(m.transcriptSummariesSnapshotForTesting(folder, id("new-b")).data).toBe(confirmed);
  await vi.advanceTimersByTimeAsync(31_000); fixture.read.mockRejectedValue(new Error("Disconnected"));
  m.warmChatTranscriptSummaries(folder, id("new-a")); await vi.advanceTimersByTimeAsync(0);
  expect(m.transcriptSummariesSnapshotForTesting(folder, id("new-a")).data).toBe(confirmed);
});

it("bounds the cloud envelope independently at 24 folders, 32 rows and 120 summary characters", async () => {
  const m = await modules();
  const folders = Array.from({ length: 26 }, (_, index) => cloudWorkspaceKey({ ...target, workspaceId: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}` }));
  fixture.read.mockImplementation(async ({ folder: cwd }: { folder: string }) => Array.from({ length: 34 }, (_, index) => ({
    ...row(String(index), cwd), chatId: `cloud:${target.organizationId}:${cwd.split("/").at(-1)}:${index}`, summary: "x".repeat(200),
  })));
  for (const cwd of folders) { m.warmChatTranscriptSummaries(cwd, null); await vi.advanceTimersByTimeAsync(0); }
  const saved = JSON.parse(storage.get("zeros-cloud-transcript-summaries:v1")!);
  expect(saved.version).toBe(1); expect(saved.value).toHaveLength(24);
  expect(saved.value.map((entry: { folder: string }) => entry.folder)).toEqual(folders.slice(2));
  for (const entry of saved.value) {
    expect(entry.rows).toHaveLength(32);
    expect(entry.rows.every((summary: ChatSummaryWire) => summary.summary.length === 120)).toBe(true);
  }
});

it("drops malformed, foreign-folder and zero-prompt cloud rows at the persisted boundary", async () => {
  const m = await modules();
  const account = await import("../../../platform/account-presentation-cache");
  const foreign = { ...target, organizationId: "33333333-3333-4333-8333-333333333333" };
  account.writeAccountPresentation(account.CLOUD_TRANSCRIPT_SUMMARIES_PRESENTATION_KEY, account.getAccountPresentationOwner()!, [
    { folder, updatedAt: 1, rows: [row(), row(), { ...row("bad"), summary: null }, { ...row("empty"), userMessageCount: 0 },
      { ...row("foreign"), chatId: cloudScopedId(foreign, "saved") }] },
    { folder: "/local", updatedAt: 1, rows: [row()] },
    { folder: `${folder}/nested`, updatedAt: 1, rows: [row()] },
  ], 1024 * 1024);
  expect(m.transcriptSummariesSnapshotForTesting(folder, id("new-a")).data).toEqual([row()]);
  expect(m.transcriptSummariesSnapshotForTesting(cloudWorkspaceKey(foreign), id("new-a")).data).toBeUndefined();
});

it("bounds cloud pending overlays without reducing Local retention", async () => {
  const m = await modules();
  const folders = Array.from({ length: 26 }, (_, index) => cloudWorkspaceKey({ ...target, workspaceId: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}` }));
  for (const cwd of folders) for (let index = 0; index < 34; index++) {
    m.noteLocalChatPrompt({ folder: cwd, chatId: `cloud:${target.organizationId}:${cwd.split("/").at(-1)}:${index}`, text: "Prompt", promptId: String(index) });
  }
  expect(folders.filter(cwd => m.visibleTranscriptSummaries(cwd, [], null).length)).toHaveLength(24);
  expect(m.visibleTranscriptSummaries(folders.at(-1)!, [], null)).toHaveLength(32);
  for (let index = 0; index < 34; index++) m.noteLocalChatPrompt({ folder: "/local", chatId: `local-${index}`, text: "Prompt" });
  expect(m.visibleTranscriptSummaries("/local", [], null)).toHaveLength(34);
});
