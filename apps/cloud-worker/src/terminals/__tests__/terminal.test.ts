import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { BridgeMessage } from "@zeros/protocol/messages";
import type { AppClient } from "../../agents";
import { browserFrame } from "../../__tests__/worker-fixtures";
import { repositoryFixture } from "../../workspace/__tests__/repository-fixture";
import { Terminals, type TerminalProcess, type TerminalSpawnOptions } from "../service";
import { TerminalMirror } from "../mirror";
import { TerminalMirror as LocalMirror } from "../../../../desktop/src/engine/pty/mirror";

const services: Terminals[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); });
const frame = (type: string, fields: Record<string, unknown> = {}) => browserFrame(type, fields) as unknown as BridgeMessage;
function client(id: string) {
  const frames: BridgeMessage[] = [];
  const client: AppClient = { id, send: async message => { frames.push(message); } };
  return { client, frames };
}
class FakeProcess implements TerminalProcess {
  pid = 1234; killed = false; paused = false; written: string[] = []; dimensions: number[] = [];
  private data: (data: string) => void = () => {};
  private exit: (exit: { exitCode: number; signal?: number }) => void = () => {};
  onData(callback: (data: string) => void) { this.data = callback; return { dispose() {} }; }
  onExit(callback: (exit: { exitCode: number; signal?: number }) => void) { this.exit = callback; return { dispose() {} }; }
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.dimensions = [cols, rows]; }
  kill() { this.killed = true; this.exit({ exitCode: 0, signal: 15 }); }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  emit(data: string) { this.data(data); }
  finish(code = 0) { this.exit({ exitCode: code }); }
}

it("matches Local's resolved-grid replay for native redraw, colors, wrapping and resize", async () => {
  const worker = new TerminalMirror(40, 8), local = new LocalMirror(40, 8);
  try {
    for (const data of ["working one\r\n", "\x1b[1A\x1b[2K\rworking two\r\n", "\x1b[31mred\x1b[0m\r\n", "wrap ".repeat(30)]) { worker.write(data); local.write(data); }
    await Promise.all([worker.flush(), local.flush()]); worker.resize(60, 10); local.resize(60, 10);
    expect(await worker.snapshot()).toEqual(await local.snapshot());
    const snapshot = await worker.snapshot(); expect(snapshot.data).toContain("working two"); expect(snapshot.data).not.toContain("working one");
  } finally { worker.dispose(); local.dispose(); }
});

it("shares one shell, survives detach, and reattaches with a screen snapshot", async () => {
  const { scope } = await repositoryFixture(); const native = new FakeProcess(); let spawns = 0; const notices: BridgeMessage[] = [];
  const service = new Terminals(scope, { spawn: async () => { spawns++; return native; }, broadcast: message => { notices.push(message); } }); services.push(service);
  const a = client("a"), b = client("b");
  await Promise.all([service.handle(a.client, frame("PTY_CREATE", { sessionId: "shared" })), service.handle(b.client, frame("PTY_CREATE", { sessionId: "shared" }))]);
  expect(spawns).toBe(1); expect(service.busy).toBe(true);
  expect(b.frames.find(message => message.type === "PTY_CREATED")).toMatchObject({ reattached: true, pid: 1234, cwd: scope.root });
  native.emit("old frame\r\n\x1b[1A\x1b[2K\rnew frame\r\n"); await service.flush();
  service.detach(a.client); const before = a.frames.length;
  native.emit("while detached\r\n"); await service.flush(); expect(a.frames).toHaveLength(before);
  const again = client("a"); await service.handle(again.client, frame("PTY_CREATE", { sessionId: "shared", cols: 120, rows: 40 }));
  const created = again.frames.find(message => message.type === "PTY_CREATED");
  expect(created).toMatchObject({ reattached: true, pid: 1234, cols: 120, rows: 40, replay: expect.stringContaining("while detached") });
  if (created?.type !== "PTY_CREATED") throw new Error("Missing create reply");
  expect(created.replay).not.toContain("old frame"); expect(spawns).toBe(1); expect(notices.some(message => message.type === "PTY_TERMINALS_CHANGED")).toBe(true);
  await service.handle(again.client, frame("PTY_WRITE", { sessionId: "shared", data: "pwd\n" })); expect(native.written).toEqual(["pwd\n"]);
});

it("orders snapshot and concurrent live bytes without replaying or dropping a chunk", async () => {
  const { scope } = await repositoryFixture(); const native = new FakeProcess(); const mirror = new TerminalMirror(80, 24);
  const service = new Terminals(scope, { spawn: async () => native, mirror: () => mirror }); services.push(service);
  const a = client("a"), b = client("b"); await service.handle(a.client, frame("PTY_CREATE", { sessionId: "race" }));
  native.emit("before\r\n"); await service.flush();
  const original = mirror.snapshot.bind(mirror); let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  mirror.snapshot = async () => { const result = await original(); entered = true; await gate; return result; };
  const attach = service.handle(b.client, frame("PTY_CREATE", { sessionId: "race" }));
  await expect.poll(() => entered).toBe(true); native.emit("during\r\n"); release(); await attach; await service.flush();
  expect(b.frames.filter(message => message.type === "PTY_CREATED" || message.type === "PTY_DATA")).toMatchObject([
    { type: "PTY_CREATED", replay: expect.stringContaining("before") }, { type: "PTY_DATA", data: "during\r\n" },
  ]);
});

it("keeps exited shared rows, removes killed rows, and isolates ephemeral terminals", async () => {
  const { scope } = await repositoryFixture(); const children: FakeProcess[] = [], notices: BridgeMessage[] = [];
  const service = new Terminals(scope, { spawn: async () => { const child = new FakeProcess(); children.push(child); return child; }, broadcast: message => { notices.push(message); } }); services.push(service);
  const a = client("a"), b = client("b");
  await service.handle(a.client, frame("PTY_CREATE", { sessionId: "kept" })); children[0].finish(3); await service.flush();
  expect(service.busy).toBe(false);
  await service.handle(a.client, frame("PTY_LIST")); expect(a.frames.at(-1)).toMatchObject({ terminals: [{ sessionId: "kept", exited: true }] });
  await service.handle(a.client, frame("PTY_KILL", { sessionId: "kept" }));
  await service.handle(a.client, frame("PTY_CREATE", { sessionId: "private", ephemeral: true }));
  await service.handle(b.client, frame("PTY_WRITE", { sessionId: "private", data: "foreign\n" })); expect(children[1].written).toEqual([]);
  await service.handle(b.client, frame("PTY_LIST")); expect(b.frames.at(-1)).toMatchObject({ terminals: [] });
  service.detach(a.client); await service.flush(); expect(children[1].killed).toBe(true); expect(service.busy).toBe(false);
});

it("checks native cwd and login exclusions and gives a terminal only runtime/broker env", async () => {
  const { scope, directory, root } = await repositoryFixture(); const launches: TerminalSpawnOptions[] = [];
  await symlink(directory, join(root, "outside"));
  const service = new Terminals(scope, { environment: { PATH: "/usr/bin", HOME: directory, ZEROS_WORKER_TOKEN: "fixture-worker", CURSOR_API_KEY: "fixture-cursor", GH_TOKEN: "fixture-ambient" },
    gitEnvironment: { GH_ZEROS_BROKER_SOCKET: "/fixture/socket", GIT_ASKPASS: "/fixture/askpass" }, spawn: async options => { launches.push(options); return new FakeProcess(); } }); services.push(service);
  const a = client("a");
  for (const cwd of [directory, join(root, "outside"), "cloud://foreign/path"]) await service.handle(a.client, frame("PTY_CREATE", { sessionId: cwd, cwd }));
  await service.handle(a.client, frame("PTY_CREATE", { sessionId: "login", loginProvider: "codex", ephemeral: true }));
  expect(launches).toEqual([]); expect(a.frames.filter(message => message.type === "PTY_EXIT")).toHaveLength(4);
  await service.handle(a.client, frame("PTY_CREATE", { sessionId: "valid", cwd: root, cols: 9999, rows: 0 }));
  expect(launches[0]).toMatchObject({ cols: 500, rows: 24, env: { GH_ZEROS_BROKER_SOCKET: "/fixture/socket", GIT_ASKPASS: "/fixture/askpass", TERM: "xterm-256color" } });
  expect(launches[0].env).not.toHaveProperty("ZEROS_WORKER_TOKEN"); expect(launches[0].env).not.toHaveProperty("CURSOR_API_KEY"); expect(launches[0].env).not.toHaveProperty("GH_TOKEN");
});

it("honors kill while native spawn is pending", async () => {
  const { scope } = await repositoryFixture(); const native = new FakeProcess(); let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = new Terminals(scope, { spawn: async () => { entered = true; await gate; return native; } }); services.push(service);
  const a = client("a"); const create = service.handle(a.client, frame("PTY_CREATE", { sessionId: "cancel" }));
  await expect.poll(() => entered).toBe(true); const kill = service.handle(a.client, frame("PTY_KILL", { sessionId: "cancel" }));
  release(); await Promise.all([create, kill]); await service.flush();
  expect(native.killed).toBe(true); expect(service.busy).toBe(false); expect(a.frames.some(message => message.type === "PTY_CREATED")).toBe(false);
});

it("drains accepted output before disposing an exited ephemeral mirror", async () => {
  const { scope } = await repositoryFixture(); const native = new FakeProcess(), mirror = new TerminalMirror(80, 24);
  let disposals = 0; const dispose = mirror.dispose.bind(mirror); mirror.dispose = () => { disposals++; dispose(); };
  const service = new Terminals(scope, { spawn: async () => native, mirror: () => mirror }); services.push(service);
  const a = client("a"); await service.handle(a.client, frame("PTY_CREATE", { sessionId: "one-shot", ephemeral: true }));
  native.emit("last output\r\n"); native.finish(); await service.flush();
  expect(a.frames.filter(frame => frame.type === "PTY_DATA" || frame.type === "PTY_EXIT")).toMatchObject([
    { type: "PTY_DATA", data: "last output\r\n" }, { type: "PTY_EXIT" },
  ]);
  expect(disposals).toBe(1);
});

it("disposes an ephemeral mirror exactly once when kill emits exit synchronously", async () => {
  const { scope } = await repositoryFixture(); const a = client("a");
  const otherMirror = new TerminalMirror(80, 24); let kills = 0; const disposeOther = otherMirror.dispose.bind(otherMirror);
  otherMirror.dispose = () => { kills++; disposeOther(); };
  const second = new Terminals(scope, { spawn: async () => new FakeProcess(), mirror: () => otherMirror }); services.push(second);
  await second.handle(a.client, frame("PTY_CREATE", { sessionId: "kill-one-shot", ephemeral: true }));
  await second.handle(a.client, frame("PTY_KILL", { sessionId: "kill-one-shot" })); await second.flush();
  expect(kills).toBe(1);
});

it("pauses native output while replay is blocked and resumes after the bounded queue drains", async () => {
  const { scope } = await repositoryFixture(); const native = new FakeProcess(), mirror = new TerminalMirror(80, 24);
  const service = new Terminals(scope, { spawn: async () => native, mirror: () => mirror }); services.push(service);
  const a = client("a"), b = client("b"); await service.handle(a.client, frame("PTY_CREATE", { sessionId: "backpressure" }));
  let entered = false, release!: () => void; const original = mirror.snapshot.bind(mirror);
  const gate = new Promise<void>(resolve => { release = resolve; });
  mirror.snapshot = async () => { const snapshot = await original(); entered = true; await gate; return snapshot; };
  const attach = service.handle(b.client, frame("PTY_CREATE", { sessionId: "backpressure" }));
  await expect.poll(() => entered).toBe(true);
  for (let chunk = 0; chunk < 5; chunk++) native.emit("x".repeat(64 * 1024));
  expect(native.paused).toBe(true);
  service.detach(b.client); release(); await attach; await service.flush();
  expect(native.paused).toBe(false); expect(b.frames).toEqual([]);
  expect(a.frames.filter(message => message.type === "PTY_DATA")).toHaveLength(5);
});

it("runs the real native PTY through write, resize, disconnect, reattach and exit", async () => {
  const { scope, root } = await repositoryFixture();
  const service = new Terminals(scope, { environment: { PATH: "/usr/bin:/bin", HOME: root, USER: "fixture", SHELL: "/bin/bash" }, shellArgs: ["--noprofile", "--norc", "-i"] }); services.push(service);
  const a = client("a"); await service.handle(a.client, frame("PTY_CREATE", { sessionId: "native", cols: 90, rows: 25 }));
  expect(a.frames[0]).toMatchObject({ type: "PTY_CREATED", reattached: false, cwd: root });
  await service.handle(a.client, frame("PTY_WRITE", { sessionId: "native", data: "printf 'WORKER_PTY_FIXTURE\\n'\n" }));
  await expect.poll(() => a.frames.some(message => message.type === "PTY_DATA" && message.data.includes("WORKER_PTY_FIXTURE"))).toBe(true);
  await service.handle(a.client, frame("PTY_RESIZE", { sessionId: "native", cols: 100, rows: 30 })); service.detach(a.client);
  const b = client("b"); await service.handle(b.client, frame("PTY_CREATE", { sessionId: "native" }));
  expect(b.frames[0]).toMatchObject({ type: "PTY_CREATED", reattached: true, cols: 100, rows: 30, replay: expect.stringContaining("WORKER_PTY_FIXTURE") });
  await service.handle(b.client, frame("PTY_WRITE", { sessionId: "native", data: "exit 0\n" }));
  await expect.poll(() => service.busy).toBe(false); await service.flush(); expect(b.frames.some(message => message.type === "PTY_EXIT")).toBe(true);
});
