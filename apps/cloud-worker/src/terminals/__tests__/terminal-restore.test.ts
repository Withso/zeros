import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
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
  const start = (options: { cwd?: string; liveDirectory?: () => string; recordDelayMs?: number } = {}) => {
    const natives: FakeProcess[] = [], spawned: TerminalSpawnOptions[] = [];
    const service = new Terminals(fixture.scope, { records, ...(options.recordDelayMs === undefined ? {} : { recordDelayMs: options.recordDelayMs }),
      workingDirectory: async () => options.liveDirectory?.() ?? options.cwd ?? fixture.scope.root,
      spawn: async spawn => { spawned.push(spawn); const native = new FakeProcess(); natives.push(native); return native; } });
    services.push(service);
    return { service, natives, spawned };
  };
  return { ...fixture, records, start };
}
/** A worker whose shells report a directory that can change while they run. */
function workspaceStart(start: Awaited<ReturnType<typeof workspace>>["start"], cwd: () => string) {
  return start({ cwd: undefined, liveDirectory: cwd });
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

it("restores a shell saved while a full-screen program ran without that program's screen or modes", async () => {
  const { start } = await workspace();
  const before = start(), a = client("a");
  await before.service.handle(a.client, frame("PTY_CREATE", { sessionId: "plain", restore: true, cols: 80, rows: 24 }));
  before.natives[0]!.emit("$ ls\r\nREADME.md\r\n$ vim README.md\r\n");
  // vim: alternate screen, SGR mouse reporting, application cursor and keypad, hidden cursor.
  before.natives[0]!.emit("\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?1h\x1b=\x1b[?25l\x1b[H\x1b[2JVIM-SCREEN");
  await before.service.flush(); await before.service.dispose();

  const after = start(), b = client("b");
  await after.service.handle(b.client, frame("PTY_CREATE", { sessionId: "plain", restore: true, cols: 80, rows: 24 }));
  const created = b.created();
  if (created?.type !== "PTY_CREATED") throw new Error("Missing create reply");
  // The desktop resets its xterm and writes the replay; then the new shell prints its prompt.
  const desktop = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  try {
    await new Promise<void>(resolve => desktop.write(`\x1bc${created.replay}$ `, resolve));
    const screen = Array.from({ length: 24 }, (_, row) => desktop.buffer.active.getLine(row)?.translateToString(true) ?? "").join("\n");
    expect({ buffer: desktop.buffer.active.type, mouse: desktop.modes.mouseTrackingMode, cursorKeys: desktop.modes.applicationCursorKeysMode,
      keypad: desktop.modes.applicationKeypadMode }).toEqual({ buffer: "normal", mouse: "none", cursorKeys: false, keypad: false });
    expect(screen).toContain("$ vim README.md"); expect(screen).not.toContain("VIM-SCREEN");
  } finally { desktop.dispose(); }
});

it("keeps the latest directory when the latest screen is too large to save", async () => {
  const { scope, start } = await workspace();
  await mkdir(join(scope.root, "a")); await mkdir(join(scope.root, "b"));
  const first = await realpath(join(scope.root, "a")), latest = await realpath(join(scope.root, "b"));
  let cwd = first;
  const before = workspaceStart(start, () => cwd), a = client("a");
  await before.service.handle(a.client, frame("PTY_CREATE", { sessionId: "plain", restore: true, cols: 400, rows: 100 }));
  before.natives[0]!.emit("old-output-marker\r\n"); await before.service.flush();
  await before.service.dispose();
  // A truecolor screen of this size serializes to well over the record cap.
  const again = workspaceStart(start, () => cwd), c = client("c");
  await again.service.handle(c.client, frame("PTY_CREATE", { sessionId: "plain", restore: true, cols: 400, rows: 100 }));
  cwd = latest; again.natives[0]!.emit(art(400, 100)); await again.service.flush();
  await again.service.dispose();

  const after = start(), b = client("b");
  await after.service.handle(b.client, frame("PTY_CREATE", { sessionId: "plain", restore: true, cols: 400, rows: 100 }));
  expect(b.created()).toMatchObject({ cwd: latest });
  expect((b.created() as { replay?: string }).replay ?? "").not.toContain("old-output-marker");
});

it("drops a shell's record when a client creates it without restore", async () => {
  // An older desktop reattaching first must not leave the next restore an older sleep's screen.
  const { start } = await workspace();
  const first = start(), a = client("a");
  await first.service.handle(a.client, frame("PTY_CREATE", { sessionId: "plain", restore: true }));
  first.natives[0]!.emit("FIRST-SLEEP\r\n"); await first.service.flush(); await first.service.dispose();
  const second = start(), old = client("old");
  await second.service.handle(old.client, frame("PTY_CREATE", { sessionId: "plain" }));
  second.natives[0]!.emit("SECOND-SLEEP\r\n"); await second.service.flush(); await second.service.dispose();

  const third = start(), b = client("b");
  await third.service.handle(b.client, frame("PTY_CREATE", { sessionId: "plain", restore: true }));
  expect((b.created() as { replay?: string }).replay ?? "").not.toContain("FIRST-SLEEP");
  expect((b.created() as { reattached?: boolean }).reattached).toBeFalsy();
});

const art = (cols: number, rows: number) => {
  let screen = "\x1b[H";
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const r = (x * 7 + y) % 256, g = (y * 5 + x * 3) % 256, b = (x * y) % 256;
      screen += `\x1b[38;2;${r};${g};${b};48;2;${b};${r};${g}m\u2580`;
    }
    screen += "\x1b[0m" + (y < rows - 1 ? "\r\n" : "");
  }
  return screen;
};

it("scrubs the workspace API token from a screen saved for restore, keeping the rest of it", async () => {
  const fixture = await repositoryFixture(), records = join(fixture.state, "terminals"), token = `zw2a_${"R".repeat(43)}`;
  const natives: FakeProcess[] = [];
  const service = new Terminals(fixture.scope, { records, recordDelayMs: 0, redact: text => text.split(token).join("[redacted]"),
    workingDirectory: async () => fixture.scope.root, spawn: async () => { const native = new FakeProcess(); natives.push(native); return native; } });
  services.push(service);
  const a = client("a");
  await service.handle(a.client, frame("PTY_CREATE", { sessionId: "printed", restore: true, cols: 120, rows: 10 }));
  natives[0]!.emit(`$ echo $ZEROS_API_TOKEN\r\n${token}\r\n$ `); await service.flush();
  await service.dispose();
  const [name] = (await readdir(records)).filter(entry => entry.endsWith(".json"));
  const saved = await readFile(join(records, name!), "utf8");
  expect(saved).not.toContain(token);
  expect(saved).toContain("[redacted]");
  expect(saved).toContain("echo $ZEROS_API_TOKEN");
});
