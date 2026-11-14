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

describe("a failing cache is visible in main.log, counted, with a closed reason class", () => {
  function logged() {
    const lines: string[] = [];
    return { lines, log: (line: string) => lines.push(line) };
  }
  it("logs ready once, and each failure class with its stage at counts 1, 2, 4, 8...", async () => {
    const f = fixture(), out = logged();
    let session = true;
    const command = createCloudChatCacheCommand({ service: f.load, log: out.log,
      admit: () => { if (!session) throw Object.assign(new Error("no session"), { stage: "no_session" }); return { window: 1, current: () => true }; } });
    await command({ op: "bind", owner, client: "renderer-a" }, f.event);
    await command({ op: "bind", owner, client: "renderer-a" }, f.event);
    expect(out.lines.filter(line => line.startsWith("ready"))).toEqual(["ready"]);
    session = false;
    for (let i = 0; i < 5; i++) await expect(command({ op: "bind", owner, client: "renderer-a" }, f.event)).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(out.lines.filter(line => line.startsWith("failure"))).toEqual([
      "failure op=bind reason=unavailable stage=no_session count=1",
      "failure op=bind reason=unavailable stage=no_session count=2",
      "failure op=bind reason=unavailable stage=no_session count=4",
    ]);
    // No paths, ids, owners or values ever appear.
    expect(out.lines.join("\n")).not.toMatch(/viewer-a|api\.example|\/tmp|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("logs the opened rows once, and one launch line: outcomes, declines by op/reason/stage, and renderer declines", async () => {
    const f = fixture(), out = logged();
    let summary: (() => void) | undefined, delay: number | undefined;
    const command = createCloudChatCacheCommand({ service: f.load, log: out.log, admit: () => ({ window: 1, current: () => true }),
      schedule: (run, milliseconds) => { summary = run; delay = milliseconds; } });
    const lease = (await command({ op: "bind", owner, client: "renderer-a" }, f.event) as { result: { lease: string } }).result.lease;
    await command({ op: "refresh", lease, target, limit: 200 }, f.event);
    await command({ op: "refresh", lease, target, limit: 200, known: { revision: 2, messageCount: 1 } }, f.event);
    await command({ op: "refresh", lease, target, limit: 200 }, f.event);
    await command({ op: "refresh", lease, target, limit: 501 }, f.event);
    await command({ op: "report", declines: { no_owner: 2, fallback_unavailable: 1 } }, f.event);
    expect(out.lines.filter(line => line.startsWith("opened"))).toEqual(["opened chats=0 messages=0"]);
    expect(delay).toBe(60_000);
    summary!();
    expect(out.lines.at(-1)).toBe("launch outcomes=continued=1,filled=1,served=1,without_known=2 " +
      "declined=refresh/unavailable/request=1 renderer=fallback_unavailable=1,no_owner=2");
    expect(out.lines.join("\n")).not.toMatch(/viewer-a|api\.example|\/tmp|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("a launch whose renderer never asks main still logs its launch line", () => {
    const out = logged();
    let summary: (() => void) | undefined;
    createCloudChatCacheCommand({ service: async () => { throw new Error("unused"); }, log: out.log,
      admit: () => ({ window: 1, current: () => true }), schedule: run => { summary = run; } });
    summary!();
    expect(out.lines).toEqual(["launch outcomes=none declined=none renderer=none"]);
  });

  it("a store whose native open is not bound to the held file reports stage=store_bind", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-cache-bind-")), out = logged();
    const file = path.join(root, "cloud-cache.db");
    new CloudChatCacheStore(root).close();
    const Database = (await import("better-sqlite3")).default;
    const store = new CloudChatCacheStore(root, { openNative: filename => {
      const parked = `${file}.parked`, substitute = `${file}.substitute`;
      new Database(substitute).close();
      fs.renameSync(file, parked); fs.renameSync(substitute, file);
      try { return new Database(filename); } finally { fs.renameSync(file, substitute); fs.renameSync(parked, file); }
    } });
    const service = new CloudChatCacheService({ store, source: fixture().source, identity: () => ({ owner, session: "session-a" }) });
    const command = createCloudChatCacheCommand({ service: async () => service, log: out.log, admit: () => ({ window: 1, current: () => true }) });
    cleanup.push(() => { service.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
    await expect(command({ op: "bind", owner, client: "renderer-a" }, {})).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(out.lines).toContain("open failed stage=store_bind");
    expect(out.lines).toContain("failure op=bind reason=unavailable stage=store_bind count=1");
  });
});
