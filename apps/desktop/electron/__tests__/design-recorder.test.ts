import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESIGN_RECORDER_FOLDER_PREFIX } from "@zeros/protocol/design-capture";
import { assertRecorderLayerPath, createDesignRecorder, designRecorderEnabled, designRecorderEnvironment, designRecorderIdentity, designRecorderProcesses } from "../design-recorder";

describe("Design recorder client", () => {
  let root: string;
  let outside: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), DESIGN_RECORDER_FOLDER_PREFIX));
    outside = await mkdtemp(path.join(tmpdir(), "zeros-recorder-outside-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("starts only when enabled in an unpackaged build", () => {
    expect(designRecorderEnabled({ ZEROS_DESIGN_RECORDER: "1" }, false)).toBe(true);
    expect(designRecorderEnabled({ ZEROS_DESIGN_RECORDER: "1" }, true)).toBe(false);
    expect(designRecorderEnabled({}, false)).toBe(false);
  });

  it("names the renderer build and its own scripts in its identity", () => {
    const identity = designRecorderIdentity("electron-43.8.3/chromium-150.0.7871.250");
    expect(identity).toMatch(/^electron-43\.8\.3\/chromium-150\.0\.7871\.250\/skp-[a-f0-9]{8}$/);
    expect(designRecorderIdentity("electron-43.8.3/chromium-150.0.7871.250")).toBe(identity);
    expect(identity.length).toBeLessThanOrEqual(128);
  });

  it("gives the recorder no credentials or service bearers", () => {
    const env = designRecorderEnvironment({ HOME: "/h", PATH: "/bin", ZEROS_DESIGN_CAPTURE_TOKEN: "t", ANTHROPIC_API_KEY: "k", GITHUB_TOKEN: "g" }, "a".repeat(64), "id/skp");
    expect(env).toEqual({ HOME: "/h", PATH: "/bin", ZEROS_DESIGN_RECORDER_TOKEN: "a".repeat(64), ZEROS_DESIGN_RECORDER_IDENTITY: "id/skp" });
    expect(designRecorderEnvironment({ ZEROS_DESIGN_RECORDER_FRAMES_PER_WINDOW: "32" }, "a".repeat(64), "id/skp").ZEROS_DESIGN_RECORDER_FRAMES_PER_WINDOW).toBe("32");
    expect(designRecorderEnvironment({ ZEROS_DESIGN_RECORDER_FRAMES_PER_WINDOW: "32; rm" }, "a".repeat(64), "id/skp").ZEROS_DESIGN_RECORDER_FRAMES_PER_WINDOW).toBeUndefined();
  });

  it("accepts only layer files inside the recorder's folder, never through a link", async () => {
    await mkdir(path.join(root, "b", "f0"), { recursive: true });
    const good = path.join(root, "b", "f0", "layer_0.skp");
    await writeFile(good, "skiapict");
    await expect(assertRecorderLayerPath(root, good)).resolves.toBeUndefined();
    const elsewhere = path.join(outside, "layer_0.skp");
    await writeFile(elsewhere, "skiapict");
    await expect(assertRecorderLayerPath(root, elsewhere)).rejects.toThrow(/outside its folder/);
    await symlink(elsewhere, path.join(root, "b", "f0", "layer_1.skp"));
    await expect(assertRecorderLayerPath(root, path.join(root, "b", "f0", "layer_1.skp"))).rejects.toThrow(/outside its folder/);
    await writeFile(path.join(root, "b", "f0", "notes.txt"), "x");
    await expect(assertRecorderLayerPath(root, path.join(root, "b", "f0", "notes.txt"))).rejects.toThrow(/outside its folder/);
  });

  it("starts the recorder on first use, checks what it returns, and stops it when idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await mkdir(path.join(root, "b", "f0"), { recursive: true });
      const good = path.join(root, "b", "f0", "layer_0.skp");
      await writeFile(good, "skiapict");
      const stdin = new PassThrough(), stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdin, stdout, exitCode: null as number | null, kill: vi.fn() });
      const spawnImpl = vi.fn(() => { setImmediate(() => stdout.write(`noise\nZEROS_DESIGN_RECORDER ${JSON.stringify({ url: "http://127.0.0.1:4321", root })}\n`)); return child; });
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        expect(String((init.headers as Record<string, string>).Authorization)).toMatch(/^Bearer [a-f0-9]{64}$/);
        return new Response(JSON.stringify({ items: [
          { id: "f0", scale: 2, layers: [{ x: 0, y: 0, width: 640, height: 400, path: good, typefaces: [] }] },
          { id: "f1", scale: 2, layers: [{ x: 0, y: 0, width: 640, height: 400, path: path.join(outside, "layer_0.skp"), typefaces: [] }] },
          { id: "f2", error: "Multiple layers." },
        ] }));
      });
      const recorder = createDesignRecorder({ identity: "electron-43/chromium-150/skp", entry: "/app/design-recorder.cjs", idleMs: 1_000,
        env: { HOME: "/h" }, spawnImpl: spawnImpl as never, fetchImpl: fetchImpl as never });
      const request = { version: 1 as const, revision: "r", colorScheme: "light" as const, stylesheets: {}, items: [{ id: "f0", html: "<p>x</p>", viewport: { width: 320, height: 200 } }] };
      const reply = await recorder.record(request, new AbortController().signal);
      expect(spawnImpl).toHaveBeenCalledTimes(1);
      expect((spawnImpl.mock.calls[0] as unknown[])[1]).toEqual(["/app/design-recorder.cjs", expect.stringMatching(/^--user-data-dir=.*zeros-design-recorder-profile-/)]);
      expect(reply.recorder).toBe("electron-43/chromium-150/skp");
      expect(reply.items.map((item) => ("error" in item ? item.error : "ok"))).toEqual(["ok", "The recorder named a recording outside its folder.", "Multiple layers."]);
      await recorder.record(request, new AbortController().signal);
      expect(spawnImpl).toHaveBeenCalledTimes(1);
      let ended = false;
      stdin.on("finish", () => { ended = true; });
      vi.advanceTimersByTime(1_000);
      await new Promise((resolve) => setImmediate(resolve));
      expect(ended).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("splits concurrent batches between two recorder processes when asked", async () => {
    expect(designRecorderProcesses({}, 10)).toEqual([undefined]);
    expect(designRecorderProcesses({ ZEROS_DESIGN_RECORDER_WINDOWS: "3" }, 10)).toEqual(["3"]);
    expect(designRecorderProcesses({ ZEROS_DESIGN_RECORDER_PROCESSES: "2" }, 10)).toEqual(["2", "2"]);
    expect(designRecorderProcesses({ ZEROS_DESIGN_RECORDER_PROCESSES: "2" }, 2)).toEqual(["1", "1"]);
    const children: Array<EventEmitter & { stdin: PassThrough; exitCode: number | null }> = [];
    const spawnImpl = vi.fn((_command: string, _args: string[], init: { env: NodeJS.ProcessEnv }) => {
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, exitCode: null as number | null, kill: vi.fn(),
        windows: init.env.ZEROS_DESIGN_RECORDER_WINDOWS });
      const port = 4321 + children.length;
      children.push(child);
      setImmediate(() => stdout.write(`ZEROS_DESIGN_RECORDER ${JSON.stringify({ url: `http://127.0.0.1:${port}`, root })}\n`));
      return child;
    });
    const asked: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async (url: string) => {
      asked.push(new URL(url).port);
      if (asked.length === 1) await held;
      return new Response(JSON.stringify({ items: [] }));
    });
    const recorder = createDesignRecorder({ identity: "x/skp", entry: "/app/design-recorder.cjs",
      env: { HOME: "/h", ZEROS_DESIGN_RECORDER_PROCESSES: "2" }, spawnImpl: spawnImpl as never, fetchImpl: fetchImpl as never });
    const request = { version: 1 as const, revision: "r", colorScheme: "light" as const, stylesheets: {}, items: [{ id: "f0", html: "<p>x</p>", viewport: { width: 1, height: 1 } }] };
    // A lone batch keeps to the first process.
    const first = recorder.record(request, new AbortController().signal);
    await vi.waitFor(() => expect(asked).toEqual(["4321"]));
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    // While it records, the next batch starts the second process.
    await recorder.record(request, new AbortController().signal);
    expect(asked).toEqual(["4321", "4322"]);
    release();
    await first;
    await recorder.record(request, new AbortController().signal);
    expect(asked).toEqual(["4321", "4322", "4321"]);
    expect(spawnImpl.mock.calls.map((call) => (call as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env.ZEROS_DESIGN_RECORDER_WINDOWS)).toEqual(["2", "2"]);
    const stopping = recorder.stop();
    for (const child of children) { child.exitCode = 0; child.emit("exit", 0, null); }
    await stopping;
  });

  it("removes the recorder's profile and session folder once it exits, however it ended", async () => {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, exitCode: null as number | null, kill: vi.fn() });
    let profile = "";
    const spawnImpl = vi.fn((_command: string, args: string[]) => {
      profile = args[1]!.slice("--user-data-dir=".length);
      setImmediate(() => stdout.write(`ZEROS_DESIGN_RECORDER ${JSON.stringify({ url: "http://127.0.0.1:4321", root })}\n`));
      return child;
    });
    await mkdir(path.join(root, "typefaces"), { recursive: true });
    await writeFile(path.join(root, "typefaces", `${"a".repeat(32)}.font`), "font");
    const recorder = createDesignRecorder({ identity: "x/skp", entry: "/app/design-recorder.cjs", spawnImpl: spawnImpl as never,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ items: [] }))) as never });
    await recorder.record({ version: 1, revision: "r", colorScheme: "light", stylesheets: {}, items: [{ id: "f0", html: "<p>x</p>", viewport: { width: 1, height: 1 } }] },
      new AbortController().signal);
    await mkdir(profile, { recursive: true });
    const stopping = recorder.stop();
    await new Promise((resolve) => setImmediate(resolve));
    // Chromium still writes its profile while shutting down; only the exit counts.
    await expect(stat(profile)).resolves.toBeTruthy();
    child.exitCode = 0;
    child.emit("exit", 0, null);
    // Stopping settles once both are gone.
    await stopping;
    await expect(stat(profile)).rejects.toThrow();
    await expect(stat(root)).rejects.toThrow();
  });

  it("removes only a session folder directly in the temporary directory", async () => {
    const nested = path.join(outside, `${DESIGN_RECORDER_FOLDER_PREFIX}nested`);
    await mkdir(nested);
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, exitCode: null as number | null, kill: vi.fn() });
    const spawnImpl = vi.fn(() => { setImmediate(() => stdout.write(`ZEROS_DESIGN_RECORDER ${JSON.stringify({ url: "http://127.0.0.1:4321", root: nested })}\n`)); return child; });
    const recorder = createDesignRecorder({ identity: "x/skp", entry: "/app/design-recorder.cjs", spawnImpl: spawnImpl as never,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ items: [] }))) as never });
    await recorder.record({ version: 1, revision: "r", colorScheme: "light", stylesheets: {}, items: [{ id: "f0", html: "<p>x</p>", viewport: { width: 1, height: 1 } }] },
      new AbortController().signal);
    const stopping = recorder.stop();
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await stopping;
    await expect(stat(nested)).resolves.toBeTruthy();
  });

  it("fails a batch when the recorder announces an address it shouldn't", async () => {
    const stdout = new PassThrough(), stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, exitCode: null as number | null, kill: vi.fn() });
    // Like the host: its stdin closing ends it.
    stdin.on("finish", () => { child.exitCode = 0; child.emit("exit", 0, null); });
    const spawnImpl = vi.fn(() => { setImmediate(() => stdout.write(`ZEROS_DESIGN_RECORDER ${JSON.stringify({ url: "http://example.com:80", root })}\n`)); return child; });
    const recorder = createDesignRecorder({ identity: "x/skp", entry: "/app/design-recorder.cjs", spawnImpl: spawnImpl as never, fetchImpl: vi.fn() as never });
    await expect(recorder.record({ version: 1, revision: "r", colorScheme: "light", stylesheets: {}, items: [{ id: "f0", html: "<p>x</p>", viewport: { width: 1, height: 1 } }] },
      new AbortController().signal)).rejects.toThrow(/invalid address/);
    await recorder.stop();
  });
});
