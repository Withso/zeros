import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudChatCacheStore } from "../cloud-chat-cache/store";

const mocks = vi.hoisted(() => ({
  directory: "", session: null as { accountId: string; sessionId: string; accessToken: string } | null,
  window: null as unknown, local: false, fetch: vi.fn(),
  changed: undefined as (() => void) | undefined,
  retired: undefined as ((value: { accountId: string; sessionId: string }) => void | Promise<void>) | undefined,
  quit: undefined as (() => void) | undefined,
}));
vi.mock("electron", () => ({ app: { once: (_name: string, callback: () => void) => { mocks.quit = callback; } } }));
vi.mock("../runtime-mode", () => ({ get IS_LOCAL_DEVELOPMENT() { return mocks.local; } }));
vi.mock("../../src/engine/db/paths", () => ({ zerosDataDir: () => mocks.directory }));
vi.mock("../ipc/events", () => ({ getMainWindow: () => mocks.window }));
vi.mock("../workos-desktop-account", () => ({ controlPlaneBaseUrl: () => "https://api.example.test" }));
vi.mock("../control-plane-fetch", () => ({ controlPlaneFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock("../ipc/commands/auth-session", () => ({
  getSessionUserForMain: () => mocks.session,
  getValidSessionForMain: async () => mocks.session,
  onMainAuthSessionChanged: (listener: typeof mocks.changed) => { mocks.changed = listener; },
  onMainAuthSessionRetired: (listener: typeof mocks.retired) => { mocks.retired = listener; },
}));

const sessionA = { accountId: "viewer-a", sessionId: "sign-in-a", accessToken: "fixture-a" };
const sessionB = { accountId: "viewer-b", sessionId: "sign-in-b", accessToken: "fixture-b" };
const owner = (session = sessionA) => JSON.stringify(["https://api.example.test", session.accountId]);
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", chatId: "chat" };
const range = { revision: 4, messageCount: 1, fromIndex: 0, toIndex: 1,
  rows: [{ index: 0, msgId: "message", kind: "text", payload: '{"id":"message","kind":"text","role":"user","text":"Saved","createdAt":1}', createdAt: 1 }] };
type Sender = EventEmitter & { id: number; mainFrame: object; isDestroyed(): boolean };
let sender: Sender;
let invoke: (input: unknown, event?: unknown) => Promise<unknown>;
let store: CloudChatCacheStore | undefined;
const event = () => ({ sender, senderFrame: sender.mainFrame });
async function bind() {
  const reply = await invoke({ op: "bind", owner: owner(mocks.session!), client: "renderer-one" }) as { ok: boolean; result?: { lease: string } };
  expect(reply.ok).toBe(true);
  return reply.result!.lease;
}
function seed(session = sessionA) {
  store ??= new CloudChatCacheStore(mocks.directory);
  store.bindAccount(owner(session), session.sessionId);
  store.putRange({ ...target, owner: owner(session) }, range);
}

beforeEach(async () => {
  vi.resetModules(); mocks.fetch.mockReset(); mocks.changed = undefined; mocks.retired = undefined; mocks.quit = undefined; mocks.local = false;
  mocks.directory = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-cloud-native-")); mocks.session = sessionA;
  sender = Object.assign(new EventEmitter(), { id: 12, mainFrame: {}, isDestroyed: () => false });
  mocks.window = { webContents: sender, isDestroyed: () => false };
  const module = await import("../ipc/commands/cloud-chat-cache");
  invoke = (input, source = event()) => module.cloudChatCache(input as never, source as never) as Promise<unknown>;
});
afterEach(() => { mocks.quit?.(); store?.close(); store = undefined; fs.rmSync(mocks.directory, { recursive: true, force: true }); });

describe("main-process cloud cache command", () => {
  it("refuses foreign frames and Local mode before creating a cache or doing I/O", async () => {
    expect(await invoke({ op: "bind", owner: owner(), client: "client" }, { ...event(), senderFrame: {} })).toMatchObject({ ok: false });
    mocks.local = true;
    expect(await invoke({ op: "bind", owner: owner(), client: "client" })).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(mocks.directory, "cloud-cache.db"))).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("reads the main-owned account from SQLite offline, without refreshing a bearer", async () => {
    seed(); store!.close(); store = undefined;
    const lease = await bind();
    expect(await invoke({ op: "read", lease, target, limit: 200 })).toEqual({ ok: true, result: { range, pending: null } });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(await invoke({ op: "bind", owner: owner(sessionB), client: "foreign" })).toMatchObject({ ok: false });
  });

  it("erases a retired parked account even when no cloud view opened in this launch", async () => {
    seed(); seed(sessionB); store!.close(); store = undefined;
    mocks.session = sessionB;
    await mocks.retired?.({ accountId: sessionA.accountId, sessionId: sessionA.sessionId });
    store = new CloudChatCacheStore(mocks.directory);
    expect(store.metadata({ ...target, owner: owner() })).toBeNull();
    expect(store.metadata({ ...target, owner: owner(sessionB) })).toEqual({ revision: 4, messageCount: 1 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("keeps ordinary account switches isolated and fences old window leases", async () => {
    seed(); seed(sessionB); store!.close(); store = undefined;
    const first = await bind();
    mocks.session = sessionB; mocks.changed?.();
    expect(await invoke({ op: "read", lease: first, target, limit: 200 })).toEqual({ ok: false, reason: "owner_changed" });
    const second = await bind();
    expect(await invoke({ op: "read", lease: second, target, limit: 200 })).toMatchObject({ ok: true, result: { range } });
    mocks.session = sessionA; mocks.changed?.();
    const third = await bind();
    expect(await invoke({ op: "read", lease: third, target, limit: 200 })).toMatchObject({ ok: true, result: { range } });
    sender.emit("did-start-navigation", {}, "about:blank", false, true);
    expect(await invoke({ op: "read", lease: third, target, limit: 200 })).toEqual({ ok: false, reason: "owner_changed" });
  });

  it("does not let a delayed old retirement delete a replacement sign-in", async () => {
    seed(); store!.close(); store = undefined;
    mocks.session = { ...sessionA, sessionId: "replacement" }; mocks.changed?.();
    const lease = await bind();
    store = new CloudChatCacheStore(mocks.directory);
    store.putRange({ ...target, owner: owner() }, range);
    await mocks.retired?.({ accountId: sessionA.accountId, sessionId: sessionA.sessionId });
    expect(await invoke({ op: "read", lease, target, limit: 200 })).toMatchObject({ ok: true, result: { range } });
  });
});
