import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { CloudContextArchiver } from "../workspace-sync/archive";
import { DeviceControl } from "../local-commands/control";
import { SyncManager } from "../workspace-sync/manager";
import { SyncEngine } from "../workspace-sync/engine";
import type { LocalCommandDevice } from "@zeros/protocol/local-commands";

const workspaceId = "11111111-1111-4111-8111-111111111111", organizationId = "22222222-2222-4222-8222-222222222222";
const creatorId = "66666666-6666-4666-8666-666666666666", memberId = "77777777-7777-4777-8777-777777777777";
const device: LocalCommandDevice = { deviceId: "33333333-3333-4333-8333-333333333333", registrationId: "44444444-4444-4444-8444-444444444444", instanceId: "55555555-5555-4555-8555-555555555555", name: "Fixture Mac", capabilities: ["local-commands-v1"] };

describe("cloud archive through the passive workspace read and native sync manager", () => {
  let root: string;
  beforeEach(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), "zeros-cloud-archive-"))); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function fixture(options: { viewerId?: string; creatorUserId?: string | null } = {}) {
    const folder = path.join(root, "mirror"), channel = path.join(root, "zeros-beta"), settings = new Map<string, string>();
    await mkdir(folder);
    await SyncEngine.open(folder, { workspaceId, accountId: "account-a", deviceId: device.deviceId });
    await mkdir(path.join(folder, ".context", "attachments"), { recursive: true });
    await writeFile(path.join(folder, ".context", "notes.md"), "cloud notes");
    await writeFile(path.join(folder, ".context", "attachments", "private.txt"), "attachment");
    let account = "account-a", generation = 0, now = 1_000_000, status = 200, archivedAt: string | null = null, release: Promise<void> = Promise.resolve();
    const requests: Array<{ method: string; path: string }> = [];
    const negotiation: Array<[string | null, string | null]> = [];
    const viewerId = options.viewerId ?? creatorId, creatorUserId = options.creatorUserId === undefined ? creatorId : options.creatorUserId;
    const control = new DeviceControl({ baseUrl: () => "https://api.example.test", token: async () => "synthetic-session",
      fetch: (async (url, init) => {
        const requestPath = new URL(String(url)).pathname;
        requests.push({ method: init?.method ?? "GET", path: requestPath });
        const headers = new Headers(init?.headers);
        const sharing = headers.get("x-zeros-team-sharing"), ownership = headers.get("x-zeros-team-ownership");
        negotiation.push([sharing, ownership]);
        const admitted = viewerId === creatorUserId || (sharing === "1" && (creatorUserId !== null || ownership === "1"));
        const replyStatus = admitted ? status : 404;
        const snapshot = { workspace: { id: requestPath.split("/").at(-1), organizationId, repository: "example/project", number: 7, name: "Notes", archivedAt, creatorUserId, state: "stopped", futureField: true } };
        await release;
        return replyStatus === 200 ? Response.json(snapshot) : Response.json({ error: { code: "workspace_not_found" } }, { status: replyStatus });
      }) as typeof fetch });
    const manager = new SyncManager({ settings: { get: key => settings.get(key), set: (key, value) => { settings.set(key, value); } },
      identity: () => ({ accountId: account, deviceId: device.deviceId }),
      connect: async () => { throw new Error("offline fixture"); }, setSyncing: async () => {}, publish: () => {}, log: () => {},
      wait: (_ms, wake) => wake.promise,
    });
    await manager.enable(workspaceId, folder);
    const archiver = new CloudContextArchiver({ ownerKey: () => `${account}:${generation}`, now: () => now, channel, manager, read: id => control.archiveWorkspaceState(device, id) });
    return { folder, channel, requests, negotiation, manager, archiver, mark: () => { archivedAt = "2026-11-12T12:00:00.000Z"; },
      account: (value: string) => { account = value; generation++; }, hold: (value: Promise<void>) => { release = value; },
      advance: (ms: number) => { now += ms; }, status: (value: number) => { status = value; } };
  }

  it("leaves sleeping workspaces alone, then copies an archived mirror with no wake and no restore writeback", async () => {
    const f = await fixture();
    try {
      expect(await f.archiver.inspect(workspaceId)).toBe(false);
      expect(f.manager.folderFor(workspaceId)).toBe(f.folder);
      f.mark();
      expect(await f.archiver.inspect(workspaceId)).toBe(true);
      expect(f.manager.folderFor(workspaceId)).toBeUndefined();
      const destination = path.join(f.channel, "archived-contexts", "project", "w-7");
      expect(await readFile(path.join(destination, "notes.md"), "utf8")).toBe("cloud notes");
      await expect(readFile(path.join(destination, "attachments", "private.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(path.join(destination, "notes.md"), "edited archive");
      expect(await readFile(path.join(f.folder, ".context", "notes.md"), "utf8")).toBe("cloud notes");
      expect(f.requests).toEqual(Array.from({ length: 2 }, () => ({ method: "GET", path: `/v1/cloud-v2/workspaces/${workspaceId}` })));
    } finally { await f.manager.stop(); }
  });

  it.each([creatorId, null])("archives for an admitted non-Creator member when the Creator is %s", async (creatorUserId) => {
    const f = await fixture({ viewerId: memberId, creatorUserId });
    try {
      f.mark();
      expect(await f.archiver.inspect(workspaceId)).toBe(true);
      expect(f.negotiation).toEqual([["1", "1"]]);
      expect(f.requests).toEqual([{ method: "GET", path: `/v1/cloud-v2/workspaces/${workspaceId}` }]);
      expect(await readFile(path.join(f.channel, "archived-contexts", "project", "w-7", "notes.md"), "utf8")).toBe("cloud notes");
      expect(f.manager.folderFor(workspaceId)).toBeUndefined();
    } finally { await f.manager.stop(); }
  });

  it("backs off an invisible workspace for five minutes despite 25-second hints, then checks visibility again", async () => {
    const f = await fixture({ viewerId: memberId });
    try {
      f.mark(); f.status(404);
      expect(await f.archiver.inspect(workspaceId)).toBe(false);
      for (let hint = 0; hint < 11; hint++) {
        f.advance(25_000);
        expect(await f.archiver.inspect(workspaceId)).toBe(false);
      }
      expect(f.requests).toHaveLength(1);
      expect(f.manager.folderFor(workspaceId)).toBe(f.folder);
      await expect(readFile(path.join(f.channel, "archived-contexts", "project", "w-7", "notes.md"))).rejects.toMatchObject({ code: "ENOENT" });
      f.status(200); f.advance(25_000);
      expect(await f.archiver.inspect(workspaceId)).toBe(true);
      expect(f.requests).toHaveLength(2);
    } finally { await f.manager.stop(); }
  });

  it("starts fresh visibility reads across account A to B to A", async () => {
    const f = await fixture();
    try {
      f.status(404);
      expect(await f.archiver.inspect(workspaceId)).toBe(false);
      f.account("account-b");
      expect(await f.archiver.inspect(workspaceId)).toBe(false);
      expect(f.requests).toHaveLength(2);
      f.account("account-a"); f.status(200); f.mark();
      expect(await f.archiver.inspect(workspaceId)).toBe(true);
      expect(f.requests).toHaveLength(3);
    } finally { await f.manager.stop(); }
  });

  it("does not let an invisible workspace suppress another workspace's archive check", async () => {
    const f = await fixture(), other = "88888888-8888-4888-8888-888888888888";
    try {
      f.status(404);
      expect(await f.archiver.inspect(workspaceId)).toBe(false);
      f.status(200);
      expect(await f.archiver.inspect(other)).toBe(false);
      expect(await f.archiver.inspect(workspaceId)).toBe(false);
      expect(f.requests.map(request => request.path)).toEqual([`/v1/cloud-v2/workspaces/${workspaceId}`, `/v1/cloud-v2/workspaces/${other}`]);
      expect(f.manager.folderFor(workspaceId)).toBe(f.folder);
    } finally { await f.manager.stop(); }
  });

  it("does not start visibility backoff from a late 404 after a local switch", async () => {
    const f = await fixture();
    try {
      f.mark(); f.status(404);
      let release!: () => void, current = true;
      f.hold(new Promise(resolve => { release = resolve; }));
      const pending = f.archiver.inspect(workspaceId, () => current);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      current = false; f.status(200); release();
      await expect(pending).rejects.toMatchObject({ status: 404 });
      expect(await f.archiver.inspect(workspaceId)).toBe(true);
      expect(f.requests).toHaveLength(2);
    } finally { await f.manager.stop(); }
  });

  it("keeps server and visible-copy failures retryable", async () => {
    const f = await fixture();
    try {
      f.mark(); f.status(503);
      await expect(f.archiver.inspect(workspaceId)).rejects.toMatchObject({ status: 503 });
      f.status(200); await writeFile(f.channel, "blocked archive storage");
      await expect(f.archiver.inspect(workspaceId)).rejects.toThrow();
      expect(f.manager.folderFor(workspaceId)).toBe(f.folder);
      await rm(f.channel);
      expect(await f.archiver.inspect(workspaceId)).toBe(true);
      expect(f.requests).toHaveLength(3);
    } finally { await f.manager.stop(); }
  });

  it.each(["account", "switch"])("rejects a late archive response after changing %s", async (change) => {
    const f = await fixture();
    try {
      f.mark();
      let release!: () => void;
      f.hold(new Promise(resolve => { release = resolve; }));
      let current = true;
      const pending = f.archiver.inspect(workspaceId, () => current);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      if (change === "account") { f.account("account-b"); f.account("account-a"); }
      else current = false;
      release();
      await expect(pending).rejects.toThrow("owner changed");
      await expect(readFile(path.join(f.channel, "archived-contexts", "project", "w-7", "notes.md"))).rejects.toMatchObject({ code: "ENOENT" });
      f.account("account-a");
      expect(f.manager.folderFor(workspaceId)).toBe(f.folder);
    } finally { await f.manager.stop(); }
  });
});
