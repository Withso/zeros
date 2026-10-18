import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localOk } from "@zeros/protocol/local-orchestration";
import { LocalDropbox } from "../dropbox";
import { LocalCapabilityRegistry, type LocalCallHandler } from "../server";

const watchers = vi.hoisted(() => ({ watch: vi.fn(), readdir: vi.fn() }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), watch: watchers.watch }));
vi.mock("node:fs/promises", async (original) => {
  const native = await original<typeof import("node:fs/promises")>();
  watchers.readdir.mockImplementation(native.readdir);
  return { ...native, readdir: watchers.readdir };
});

let root: string;
let dropbox: LocalDropbox;
let registry: LocalCapabilityRegistry;
let listener: () => void;
let watcher: EventEmitter & { close: ReturnType<typeof vi.fn> };
const scope = { executionId: "execution", chatId: "chat", agentId: "codex", surface: "cli" as const };
beforeEach(async () => {
  vi.useFakeTimers();
  root = await mkdtemp(path.join(os.tmpdir(), "zeros-dropbox-idle-"));
  watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
  watchers.watch.mockReset().mockImplementation((_path, callback) => { listener = callback; return watcher; });
  registry = new LocalCapabilityRegistry();
  dropbox = new LocalDropbox(registry, async () => localOk({}, { engine: "fixture" }), () => "fixture", { root });
});
afterEach(async () => {
  await dropbox.closeAll();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.useRealTimers();
});

function spySweep() {
  return vi.spyOn(dropbox as unknown as { sweep: (box: unknown) => Promise<void> }, "sweep");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Local dropbox idle cost", () => {
  it("bounds the safety scans during a synthetic idle minute", async () => {
    const scan = spySweep().mockResolvedValue(undefined);
    await dropbox.open(scope);
    scan.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    console.info("Local dropbox synthetic idle minute", JSON.stringify({ scans: scan.mock.calls.length, timers: vi.getTimerCount() }));
    expect(scan.mock.calls.length).toBe(33);
    expect(vi.getTimerCount()).toBe(1);
    await dropbox.closeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off to the safety interval while idle and still answers with a silent watcher", async () => {
    const scan = spySweep().mockResolvedValue(undefined);
    const handle = await dropbox.open(scope);
    const box = [...dropbox["boxes"]][0]!;
    // Reach the maximum idle interval without relying on real filesystem
    // scheduling while the fake clock advances. The watcher never emits.
    await vi.advanceTimersByTimeAsync(5_100);
    scan.mockRestore();
    const handler = vi.spyOn(dropbox as unknown as { handler: LocalCallHandler }, "handler");
    const id = "e".repeat(24);
    const response = path.join(handle.dir, `${id}.res`);
    await writeFile(path.join(handle.dir, `${id}.req`), JSON.stringify({
      token: registry.mint(scope), body: { command: "whoami", args: {} },
    }));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await box.sweeping;
    await Promise.all(box.active.values());
    expect(JSON.parse(await readFile(response, "utf8"))).toEqual(localOk({}, { engine: "fixture" }));
    expect(handler).toHaveBeenCalledTimes(1);

    // Discovering a request also resets the cadence without a watch event.
    const followup = spySweep().mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(99);
    expect(followup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(followup).toHaveBeenCalledTimes(1);
    await dropbox.closeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets the safety cadence on any notification after idle backoff", async () => {
    const scan = spySweep().mockResolvedValue(undefined);
    await dropbox.open(scope);
    await vi.advanceTimersByTimeAsync(5_100);
    scan.mockClear();
    listener();
    await vi.advanceTimersByTimeAsync(0);
    expect(scan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(scan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(scan).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it("does not rearm a safety timer when a pending scan finishes after close", async () => {
    const scan = spySweep().mockResolvedValue(undefined);
    await dropbox.open(scope);
    const gate = deferred();
    scan.mockReturnValueOnce(gate.promise);
    await vi.advanceTimersByTimeAsync(100);
    const box = [...dropbox["boxes"]][0]!;
    const pending = box.sweeping;
    expect(pending).not.toBeNull();
    await dropbox.closeAll();
    gate.resolve();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces a burst of native notifications into one scan", async () => {
    const scan = spySweep().mockResolvedValue(undefined);
    await dropbox.open(scope);
    scan.mockClear();
    for (let i = 0; i < 100; i += 1) listener();
    await vi.advanceTimersByTimeAsync(0);
    expect(scan.mock.calls.length).toBe(1);
  });

  it.each(["opening", "running"])("keeps the existing fallback cadence when the watcher fails while %s", async (phase) => {
    if (phase === "opening") watchers.watch.mockImplementationOnce(() => { throw new Error("watch unavailable"); });
    const scan = spySweep().mockResolvedValue(undefined);
    await dropbox.open(scope);
    if (phase === "running") await vi.advanceTimersByTimeAsync(5_100);
    scan.mockClear();
    if (phase === "running") watcher.emit("error", new Error("watch unavailable"));
    await vi.advanceTimersByTimeAsync(100);
    expect(scan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(scan).toHaveBeenCalledTimes(10);
    await dropbox.closeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forgets response receipts after the CLI has consumed the files", async () => {
    await dropbox.open(scope);
    const box = [...dropbox["boxes"]][0]!;
    for (let i = 0; i < 1_000; i += 1) box.responses.set(i.toString(16).padStart(24, "0"), Date.now());
    await dropbox["sweep"](box);
    expect(box.responses.size).toBe(0);
  });

  it("does not lose a response published while the directory scan is pending", async () => {
    await dropbox.open(scope);
    const box = [...dropbox["boxes"]][0]!;
    const entered = deferred();
    const gate = deferred();
    watchers.readdir.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return []; });
    const pending = dropbox["sweep"](box);
    await entered.promise;
    const id = "b".repeat(24);
    box.responses.set(id, Date.now());
    gate.resolve(); await pending;
    expect(box.responses.has(id)).toBe(true);
  });

  it("starts queued requests as soon as an active handler frees capacity", async () => {
    const gate = deferred();
    const saturated = deferred();
    const lastStarted = deferred();
    const handler = vi.spyOn(dropbox as unknown as { handler: LocalCallHandler }, "handler").mockImplementation(async () => {
      if (handler.mock.calls.length === 16) saturated.resolve();
      if (handler.mock.calls.length === 17) lastStarted.resolve();
      await gate.promise;
      return localOk({}, { engine: "fixture" });
    });
    const handle = await dropbox.open(scope);
    const token = registry.mint(scope);
    await Promise.all(Array.from({ length: 17 }, (_, index) => writeFile(
      path.join(handle.dir, `${index.toString(16).padStart(24, "0")}.req`),
      JSON.stringify({ token, body: { command: "whoami", args: {} } }),
    )));
    listener();
    await saturated.promise;
    expect(handler).toHaveBeenCalledTimes(16);
    gate.resolve();
    await lastStarted.promise;
    expect(handler).toHaveBeenCalledTimes(17);
  });

  it("does not retry a refused claim without a new notification or capacity wait", async () => {
    const handle = await dropbox.open(scope);
    const box = [...dropbox["boxes"]][0]!;
    await writeFile(path.join(handle.dir, `${"d".repeat(24)}.req`), "{}");
    // A failed claim leaves its request in place. Do not create an immediate
    // scan/claim loop if a filesystem error prevents that file being renamed.
    const internal = dropbox as unknown as {
      serve: (box: unknown, id: string) => Promise<void>;
      requestSweep: (box: unknown) => void;
    };
    const claim = vi.spyOn(internal, "serve").mockResolvedValue(undefined);
    const scanAgain = vi.spyOn(internal, "requestSweep").mockImplementation(() => {});
    await dropbox["sweep"](box);
    await Promise.all(claim.mock.results.map((result) => result.value));
    expect(claim).toHaveBeenCalledTimes(1);
    expect(scanAgain).not.toHaveBeenCalled();
  });

  it("schedules orphan cleanup only while a response needs collection", async () => {
    const handle = await dropbox.open(scope);
    const box = [...dropbox["boxes"]][0]!;
    const id = "c".repeat(24);
    const response = path.join(handle.dir, `${id}.res`);
    await writeFile(response, "{}");
    box.responses.set(id, Date.now());
    dropbox["scheduleOrphanSweep"](box);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(600_001);
    await box.sweeping;
    expect(fs.existsSync(response)).toBe(false);
    expect(box.responses.size).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    await dropbox.closeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires uncollected responses and keeps unrelated files", async () => {
    const handle = await dropbox.open(scope);
    const box = [...dropbox["boxes"]][0]!;
    const id = "a".repeat(24);
    const response = path.join(handle.dir, `${id}.res`);
    await writeFile(response, "{}");
    await writeFile(path.join(handle.dir, "notes.txt"), "keep");
    box.responses.set(id, Date.now() - 600_001);
    await dropbox["sweep"](box);
    expect(fs.existsSync(response)).toBe(false);
    expect(fs.existsSync(path.join(handle.dir, "notes.txt"))).toBe(true);
    expect(box.responses.size).toBe(0);
  });
});
