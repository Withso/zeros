import { mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { BridgeMessage } from "@zeros/protocol/messages";
import type { AppClient } from "../../agents";
import { browserFrame } from "../../__tests__/worker-fixtures";
import { repositoryFixture } from "../../workspace/__tests__/repository-fixture";
import { Terminals, type TerminalProcess, type TerminalSpawnOptions } from "../service";

const services: Terminals[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); });
const frame = (type: string, fields: Record<string, unknown> = {}) => browserFrame(type, fields) as unknown as BridgeMessage;
function client(id: string) {
  const frames: BridgeMessage[] = [];
  const client: AppClient = { id, send: async message => { frames.push(message); } };
  return { client, frames, created: () => frames.find(message => message.type === "PTY_CREATED") };
}
class FakeProcess implements TerminalProcess {
  pid = 4242; killed = false;
  private data: (data: string) => void = () => {};
  private exit: (exit: { exitCode: number; signal?: number }) => void = () => {};
  onData(callback: (data: string) => void) { this.data = callback; return { dispose() {} }; }
  onExit(callback: (exit: { exitCode: number; signal?: number }) => void) { this.exit = callback; return { dispose() {} }; }
  write() {}
  resize() {}
  kill() { this.killed = true; this.exit({ exitCode: 0, signal: 15 }); }
  pause() {}
  resume() {}
  emit(data: string) { this.data(data); }
  finish(code = 0) { this.exit({ exitCode: code }); }
}

/** A worker's terminal service over one workspace and its private records.
 * Each spawn gets its own fake shell, in creation order. */
async function workspace() {
  const fixture = await repositoryFixture();
  const records = join(fixture.state, "terminals");
  const start = (options: { cwd?: string; recordDelayMs?: number } = {}) => {
    const natives: FakeProcess[] = [], spawned: TerminalSpawnOptions[] = [];
    const service = new Terminals(fixture.scope, { records, ...(options.recordDelayMs === undefined ? {} : { recordDelayMs: options.recordDelayMs }),
      workingDirectory: async () => options.cwd ?? fixture.scope.root,
      spawn: async spawn => { spawned.push(spawn); const native = new FakeProcess(); natives.push(native); return native; } });
    services.push(service);
    return { service, natives, spawned };
  };
  return { ...fixture, records, start };
}

it("restores a plain shell's screen and directory in the next worker as a reattach", async () => {
  const { scope, start } = await workspace();
  await mkdir(join(scope.root, "packages/app"), { recursive: true });
  const app = await realpath(join(scope.root, "packages/app"));
  const before = start({ cwd: app }), a = client("a");
  await before.service.handle(a.client, frame("PTY_CREATE", { sessionId: "plain", restore: true, cols: 100, rows: 30 }));
  before.natives[0]!.emit("$ pnpm test\r\n42 passing\r\n"); await before.service.flush();
  // The VM stops: the worker shuts down and its shell dies with it.
  await before.service.dispose(); expect(before.natives[0]!.killed).toBe(true);

  const after = start({ cwd: app }), b = client("b");
  await after.service.handle(b.client, frame("PTY_CREATE", { sessionId: "plain", restore: true, cols: 100, rows: 30 }));
  expect(after.spawned).toHaveLength(1); expect(after.spawned[0]!.env.PWD).toBe(app);
  const created = b.created();
  expect(created).toMatchObject({ type: "PTY_CREATED", reattached: true, cwd: app });
  if (created?.type !== "PTY_CREATED") throw new Error("Missing create reply");
  expect(created.replay).toContain("42 passing");
  expect(created.replay).toContain("Previous terminal session restored");
  // Live bytes from the new shell follow the restored screen.
  after.natives[0]!.emit("$ "); await after.service.flush();
  expect(b.frames.some(message => message.type === "PTY_DATA" && message.data === "$ ")).toBe(true);
});

it("saves a restorable shell shortly after output, so a VM stopped without a shutdown keeps it", async () => {
  const { records, start } = await workspace();
  const before = start({ recordDelayMs: 10 }), a = client("a");
  await before.service.handle(a.client, frame("PTY_CREATE", { sessionId: "plain", restore: true }));
  before.natives[0]!.emit("compiled 12 files\r\n");
  await expect.poll(async () => (await readdir(records).catch(() => [])).filter(name => name.endsWith(".json")).length).toBe(1);

  const after = start(), b = client("b");
  await after.service.handle(b.client, frame("PTY_CREATE", { sessionId: "plain", restore: true }));
  expect(b.created()).toMatchObject({ reattached: true, replay: expect.stringContaining("compiled 12 files") });
});

it("never restores a shell that did not ask, exited, was closed or is private", async () => {
  const { scope, start } = await workspace();
  const before = start(), a = client("a");
  for (const [sessionId, fields] of [["unasked", {}], ["exited", { restore: true }], ["closed", { restore: true }], ["private", { ephemeral: true }]] as const)
    await before.service.handle(a.client, frame("PTY_CREATE", { sessionId, ...fields }));
  for (const native of before.natives) native.emit("output\r\n");
  await before.service.flush();
  before.natives[1]!.finish(); await before.service.flush();
  await before.service.handle(a.client, frame("PTY_KILL", { sessionId: "closed" })); await before.service.flush();
  await before.service.dispose();

  const after = start(), b = client("b");
  for (const sessionId of ["unasked", "exited", "closed", "private"]) {
    b.frames.length = 0;
    await after.service.handle(b.client, frame("PTY_CREATE", { sessionId, restore: true }));
    const created = b.created();
    expect(created, sessionId).toMatchObject({ type: "PTY_CREATED", cwd: scope.root });
    if (created?.type !== "PTY_CREATED") throw new Error("Missing create reply");
    expect(created.reattached, sessionId).toBeFalsy(); expect(created.replay ?? "", sessionId).toBe("");
  }
});

it("starts a restored shell at the workspace root when its directory is gone or outside the workspace", async () => {
  const { scope, start } = await workspace();
  await mkdir(join(scope.root, "gone"));
  const gone = await realpath(join(scope.root, "gone"));
  const first = start({ cwd: gone }), outside = start({ cwd: "/etc" }), a = client("a");
  await first.service.handle(a.client, frame("PTY_CREATE", { sessionId: "gone", restore: true }));
  await outside.service.handle(a.client, frame("PTY_CREATE", { sessionId: "outside", restore: true }));
  first.natives[0]!.emit("in gone\r\n"); outside.natives[0]!.emit("in etc\r\n");
  await first.service.dispose(); await outside.service.dispose();
  await rm(gone, { recursive: true });

  for (const [sessionId, text] of [["gone", "in gone"], ["outside", "in etc"]] as const) {
    const after = start({ cwd: "/etc" }), b = client("b");
    await after.service.handle(b.client, frame("PTY_CREATE", { sessionId, restore: true }));
    expect(after.spawned[0]!.env.PWD, sessionId).toBe(scope.root);
    expect(b.created(), sessionId).toMatchObject({ reattached: true, cwd: scope.root, replay: expect.stringContaining(text) });
  }
});

it("ignores a corrupt record and replaces it with the new shell's", async () => {
  const { records, start } = await workspace();
  const before = start(), a = client("a");
  await before.service.handle(a.client, frame("PTY_CREATE", { sessionId: "plain", restore: true }));
  before.natives[0]!.emit("kept\r\n"); await before.service.dispose();
  const [name] = (await readdir(records)).filter(entry => entry.endsWith(".json"));
  await writeFile(join(records, name!), "{ not json");
  const after = start(), b = client("b");
  await after.service.handle(b.client, frame("PTY_CREATE", { sessionId: "plain", restore: true }));
  expect(b.created()).toMatchObject({ type: "PTY_CREATED" });
  expect((b.created() as { reattached?: boolean }).reattached).toBeFalsy();
});
