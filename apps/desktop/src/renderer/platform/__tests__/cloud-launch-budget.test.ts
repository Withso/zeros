import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Launch budget (Node level, no Playwright): the renderer's cloud history modules (WorkspaceRuntimeClient, the cloud
// transcript cache, readCloudV2History, the native cache client) driven through their launch entry points, over the
// REAL Electron-main CloudChatCacheService/store/source, against a counting fake control plane: 4 workspaces,
// 100 chats, every chat existing before migration 0252 with no upload since (revision 0, counted messageCount).
const io = vi.hoisted(() => ({ invoke: undefined as undefined | ((command: string, args: unknown) => Promise<unknown>), fetch: undefined as undefined | typeof fetch }));
vi.mock("../runtime", async original => ({ ...await original<typeof import("../runtime")>(),
  nativeInvoke: (command: string, args: unknown) => io.invoke!(command, args) }));
vi.mock("../../features/update/control-plane-fetch", () => ({ controlPlaneFetch: (url: string, init?: RequestInit) => io.fetch!(url, init) }));
vi.mock("../../features/auth/auth-store", () => ({ getSession: async () => ({ access_token: "fixture-session" }) }));
vi.mock("../../features/team/control-plane", async original => ({
  ...await original<typeof import("../../features/team/control-plane")>(), CONTROL_PLANE_URL: "https://api.example.test",
}));
vi.mock("../../config/release-channel", async original => ({
  ...await original<typeof import("../../config/release-channel")>(), isFeatureEnabled: () => true,
}));

const base = "https://api.example.test", account = "viewer-a", session = "session-a";
const owner = JSON.stringify([base, account]);
const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaces = [1, 2, 3, 4].map(n => `2222222${n}-2222-4222-8222-222222222222`);
const root = "/home/user/Owner/repo";
const CHATS_PER_WORKSPACE = 25, ROWS = 240;

type Row = { msgId: string; kind: string; payload: string; createdAt: number };
function rows(chat: string): Row[] {
  return Array.from({ length: ROWS }, (_, index) => {
    const user = index % 20 === 0, msgId = `${chat}-${index}`;
    return { msgId, kind: "text", createdAt: 1_700_000_000_000 + index,
      payload: JSON.stringify(user ? { id: msgId, kind: "text", role: "user", text: `prompt ${index}`, createdAt: 1_700_000_000_000 + index }
        : { id: msgId, kind: "text", role: "assistant", text: `answer ${index}`, createdAt: 1_700_000_000_000 + index }) };
  });
}
const chatIds = (workspaceId: string) => Array.from({ length: CHATS_PER_WORKSPACE }, (_, n) => `chat-${workspaceId.slice(7, 8)}-${n}`);
const history = new Map(workspaces.flatMap(workspaceId => chatIds(workspaceId).map(chat => [`${workspaceId}/${chat}`, rows(chat)] as const)));

/** The shipped control plane's reply shapes (history.ts, history-cache.ts, store.ts listChats) for pre-0252 chats. */
function controlPlane() {
  const counts = new Map<string, number>();
  const count = (route: string) => counts.set(route, (counts.get(route) ?? 0) + 1);
  const fetch = (async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url);
    const match = /^\/v1\/cloud-v2\/workspaces\/([0-9a-f-]{36})(\/history|\/prompts)?$/.exec(pathname);
    if (!match) { count(`other ${pathname}`); return Response.json({ error: { code: "not_found" } }, { status: 404 }); }
    const workspaceId = match[1]!;
    if (!match[2]) { count("workspace"); return Response.json({ workspace: { id: workspaceId, organizationId } }); }
    if (match[2] === "/prompts") { count("prompts"); return Response.json({ epoch: "1", items: [], nextAfter: null, queueRevision: 0 }); }
    const body = JSON.parse(String(init?.body)) as { op: string; params: Record<string, number | string> };
    count(body.op);
    if (body.op === "chats.list") return Response.json({ result: { chats: chatIds(workspaceId).map(id => ({ id, folder: root, title: id,
      agentId: "codex", createdAt: 1, updatedAt: 2, historyCache: { revision: 0, messageCount: ROWS } })), chatDeletions: [] } });
    const messages = history.get(`${workspaceId}/${body.params.chatId}`) ?? [];
    if (body.op === "messages.range") {
      const from = Math.min(Number(body.params.fromIndex), messages.length), to = Math.min(Number(body.params.toIndex), messages.length);
      const slice = messages.slice(from, to).map((row, offset) => ({ index: from + offset, ...row }));
      const opening = slice[0] && !slice[0].payload.includes('"role":"user"')
        ? [...messages.slice(0, from)].reverse().find(row => row.payload.includes('"role":"user"')) : undefined;
      return Response.json({ result: { revision: 0, messageCount: messages.length, fromIndex: from, toIndex: to, rows: slice,
        ...(opening ? { turnOpening: opening } : {}), senders: {} } });
    }
    if (body.op === "messages.since") return Response.json({ result: { resync: false, fromRevision: Number(body.params.revision), revision: 0,
      messageCount: messages.length, rows: [], senders: {} } });
    if (body.op === "messages.window") return Response.json({ result: { messages: messages.slice(-Number(body.params.limit)) } });
    return Response.json({ error: { code: "invalid_request" } }, { status: 400 });
  }) as typeof globalThis.fetch;
  return { fetch, counts, total: () => [...counts.values()].reduce((sum, n) => sum + n, 0) };
}

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-launch-budget-")); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); vi.resetModules(); });

/** One app launch: fresh renderer and main modules over the same on-disk cache. */
async function launch(cp: ReturnType<typeof controlPlane>, restored: string[]) {
  vi.resetModules();
  io.fetch = cp.fetch;
  const [{ CloudChatCacheStore }, { CloudChatCacheService }, { ControlPlaneCloudChatCacheSource }, { createCloudChatCacheCommand }] = await Promise.all([
    import("../../../../electron/cloud-chat-cache/store"), import("../../../../electron/cloud-chat-cache/service"),
    import("../../../../electron/cloud-chat-cache/source"), import("../../../../electron/cloud-chat-cache/commands")]);
  const store = new CloudChatCacheStore(directory);
  const source = new ControlPlaneCloudChatCacheSource({ baseUrl: base, fetch: cp.fetch,
    session: async () => ({ accountId: account, sessionId: session, accessToken: "fixture-bearer" }) });
  const service = new CloudChatCacheService({ store, source, identity: () => ({ owner, session }) });
  const lines: string[] = [];
  const command = createCloudChatCacheCommand({ service: async () => service, admit: () => ({ window: 1, current: () => true }),
    log: line => lines.push(line), schedule: () => {} });
  io.invoke = (name, args) => name === "cloud_chat_cache" ? command(args, {}) : Promise.reject(new Error(`unexpected ${name}`));
  const { WorkspaceRuntimeClient } = await import("../bridge/workspace-runtime-client");
  const { setActiveBridge } = await import("../bridge/active-bridge");
  const { readCloudV2History } = await import("../cloud-v2");
  const { nativeCloudChatCache } = await import("../cloud-chat-cache");
  const { cloudTranscriptCache } = await import("../../state/local-transcript-cache");
  const { cloudScopedId, cloudWorkspaceKey } = await import("../bridge/cloud-workspace-key");
  nativeCloudChatCache.bindOwner(owner, session);
  cloudTranscriptCache.bindOwner(owner, false);
  const client = new WorkspaceRuntimeClient({ open: vi.fn(), readHistory: readCloudV2History, historyRoot: () => root, workspaces: () => [] });
  setActiveBridge(client);
  const targets = workspaces.map(workspaceId => ({ organizationId, workspaceId }));
  // Launch entry points: every restored workspace warms its history (lifecycle + selected attach, as census K saw), and
  // the restored transcripts paint from the cache, then the open ones read their window.
  await Promise.all([...targets.map(target => client.warmHistoryWorkspace(target)), client.warmHistoryWorkspace(targets[0]!)]);
  // Later peer opens re-warm the same workspaces after the first flight settled (census K: 1569 ms and 2342 ms).
  const now = Date.now.bind(Date);
  let offset = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + offset);
  try {
    // A workspace request opens its peer, and the peer open warms history first (its connect fails here: no worker).
    for (const target of [targets[0]!, targets[1]!, targets[0]!]) {
      offset += 1_200;
      await client.request({ type: "WORKSPACE_REQUEST", op: "git.status", params: { cwd: cloudWorkspaceKey(target) } }).catch(() => {});
    }
  } finally { clock.mockRestore(); }
  const scoped = restored.map(id => { const [n] = /chat-(\d)/.exec(id)!.slice(1); return cloudScopedId(targets[Number(n) - 1]!, id); });
  await Promise.all(scoped.map(id => cloudTranscriptCache.read(id)));
  await Promise.all(scoped.map(id => client.request({ type: "WORKSPACE_REQUEST", op: "messages.window", params: { chatId: id, limit: 200 } })));
  await Promise.all(scoped.map(id => cloudTranscriptCache.settledForTesting(id)));
  const stored = store.stats();
  client.dispose(); service.close(); store.close(); setActiveBridge(null);
  return { stored, lines };
}

describe("a launch makes a handful of requests, measured against the real main cache", () => {
  it("a chat that existed before the cache migration (revision 0, no upload since) is stored on first open and served after", async () => {
    const restored = ["chat-1-0", "chat-1-1", "chat-2-0", "chat-3-0", "chat-4-0"];
    const first = controlPlane();
    const cold = await launch(first, restored);
    expect(cold.stored.chats).toBe(restored.length);
    const second = controlPlane();
    await launch(second, restored);
    // Warm launch: one chats.list per workspace, and no transcript, workspace, range, since or prompts read.
    expect(Object.fromEntries(second.counts)).toEqual({ "chats.list": workspaces.length });
  });
});
