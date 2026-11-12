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
const device: LocalCommandDevice = { deviceId: "33333333-3333-4333-8333-333333333333", registrationId: "44444444-4444-4444-8444-444444444444", instanceId: "55555555-5555-4555-8555-555555555555", name: "Fixture Mac", capabilities: ["local-commands-v1"] };

describe("cloud archive through the passive workspace read and native sync manager", () => {
  let root: string;
  beforeEach(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), "zeros-cloud-archive-"))); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function fixture() {
    const folder = path.join(root, "mirror"), channel = path.join(root, "zeros-beta"), settings = new Map<string, string>();
    await mkdir(folder);
    await SyncEngine.open(folder, { workspaceId, accountId: "account-a", deviceId: device.deviceId });
    await mkdir(path.join(folder, ".context", "attachments"), { recursive: true });
    await writeFile(path.join(folder, ".context", "notes.md"), "cloud notes");
    await writeFile(path.join(folder, ".context", "attachments", "private.txt"), "attachment");
    let account = "account-a", generation = 0, archivedAt: string | null = null, release: Promise<void> = Promise.resolve();
    const requests: Array<{ method: string; path: string }> = [];
    const control = new DeviceControl({ baseUrl: () => "https://api.example.test", token: async () => "synthetic-session",
      fetch: (async (url, init) => {
        requests.push({ method: init?.method ?? "GET", path: new URL(String(url)).pathname });
        const snapshot = { workspace: { id: workspaceId, organizationId, repository: "example/project", number: 7, name: "Notes", archivedAt, state: "stopped", futureField: true } };
        await release; return Response.json(snapshot);
      }) as typeof fetch });
    const manager = new SyncManager({ settings: { get: key => settings.get(key), set: (key, value) => { settings.set(key, value); } },
      identity: () => ({ accountId: account, deviceId: device.deviceId }),
      connect: async () => { throw new Error("offline fixture"); }, setSyncing: async () => {}, publish: () => {}, log: () => {},
      wait: (_ms, wake) => wake.promise,
    });
    await manager.enable(workspaceId, folder);
    const archiver = new CloudContextArchiver({ ownerKey: () => `${account}:${generation}`, channel, manager, read: id => control.archiveWorkspaceState(device, id) });
    return { folder, channel, requests, manager, archiver, mark: () => { archivedAt = "2026-11-12T12:00:00.000Z"; },
      account: (value: string) => { account = value; generation++; }, hold: (value: Promise<void>) => { release = value; } };
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
