import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudChatCacheStore } from "../cloud-chat-cache/store";
import { CloudChatCacheService, CloudCacheAccessLost, type CloudChatCacheSource } from "../cloud-chat-cache/service";
import { createCloudChatCacheCommand } from "../cloud-chat-cache/commands";

const owner = JSON.stringify(["https://api.example.test", "viewer-a"]);
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", chatId: "chat" };
const page = { revision: 2, messageCount: 1, fromIndex: 0, toIndex: 1, rows: [{ index: 0, msgId: "m0", kind: "text", payload: "{}", createdAt: 1 }] };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run(); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-cache-commands-"));
  const store = new CloudChatCacheStore(root);
  const source: CloudChatCacheSource = {
    workspace: vi.fn(async () => ({ id: target.workspaceId, organizationId: target.organizationId })),
    range: vi.fn(async (_target, fromIndex, toIndex) => ({ ...page, fromIndex, toIndex, rows: toIndex ? page.rows : [] })),
    since: vi.fn(async (_target, revision) => ({ resync: false, fromRevision: revision, revision, messageCount: 1, rows: [] })),
    pending: vi.fn(async () => null),
  };
  const service = new CloudChatCacheService({ store, source, identity: () => ({ owner, session: "session-a" }) });
  let current = true;
  const load = vi.fn(async () => service);
  const event = {};
  const command = createCloudChatCacheCommand({
    service: load,
    admit: (incoming: unknown) => { if (incoming !== event) throw new Error("Foreign window"); return { window: 1, current: () => current }; },
  });
  cleanup.push(() => { service.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { command, event, service, source, store, load, change: () => { current = false; } };
}
async function bind(f: ReturnType<typeof fixture>): Promise<string> {
  const reply = await f.command({ op: "bind", owner, client: "renderer-a" }, f.event) as { result: { lease: string } };
  return reply.result.lease;
}

describe("native cloud cache IPC boundary", () => {
  it("admits only the app frame and validates a narrow read-only cache surface", async () => {
    const f = fixture();
    await expect(f.command({ op: "bind", owner, client: "renderer-a" }, {})).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(f.command({ op: "sql", query: "select *" }, f.event)).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(f.load).not.toHaveBeenCalled();
    const lease = await bind(f);
    f.store.putRange({ owner, ...target }, page);
    await expect(f.command({ op: "read", lease, target, limit: 200 }, f.event)).resolves.toEqual({ ok: true, result: { range: page, pending: null } });
    await expect(f.command({ op: "read", lease, target, limit: 200, owner: "other" }, f.event)).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(f.command({ op: "read", lease, target: { ...target, owner: "other" }, limit: 200 }, f.event)).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(f.source.workspace).not.toHaveBeenCalled();
  });

  it("cannot publish or bind after a main account change during lazy service loading", async () => {
    const f = fixture();
    f.load.mockImplementation(async () => { f.change(); return f.service; });
    await expect(f.command({ op: "bind", owner, client: "renderer-a" }, f.event)).resolves.toEqual({ ok: false, reason: "owner_changed" });
  });

  it("does not let a retired lease release the replacement renderer", async () => {
    const f = fixture(), lease = await bind(f);
    const next = await f.command({ op: "bind", owner, client: "renderer-new" }, f.event) as { result: { lease: string } };
    await expect(f.command({ op: "release", lease }, f.event)).resolves.toEqual({ ok: false, reason: "owner_changed" });
    f.store.putRange({ owner, ...target }, page);
    await expect(f.command({ op: "read", lease: next.result.lease, target, limit: 200 }, f.event)).resolves.toEqual({ ok: true, result: { range: page, pending: null } });
  });

  it("returns closed error reasons without response bodies, filesystem paths or credentials", async () => {
    const f = fixture(), lease = await bind(f);
    vi.mocked(f.source.workspace).mockRejectedValueOnce(new Error("fixture private response /private/path fixture-bearer"));
    await expect(f.command({ op: "refresh", lease, target, limit: 200 }, f.event)).resolves.toEqual({ ok: false, reason: "unavailable" });
    vi.mocked(f.source.workspace).mockRejectedValueOnce(new CloudCacheAccessLost("chat"));
    await expect(f.command({ op: "refresh", lease, target, limit: 200 }, f.event)).resolves.toEqual({ ok: false, reason: "access_lost", scope: "chat" });
  });
});
