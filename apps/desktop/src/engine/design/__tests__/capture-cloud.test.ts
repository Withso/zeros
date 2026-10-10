import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { access, rm } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExecutionBoundary, PreparedBoundary, BoundaryProcess } from "../../agents/containment/types";
import { DESIGN_CAPTURE_TIMEOUT_MS } from "@zeros/protocol/design-capture";

const fixture = vi.hoisted(() => ({ rawSpawn: vi.fn(), prepare: vi.fn(), proof: vi.fn(), spawn: vi.fn(), stop: vi.fn(),
  boundary: null as ExecutionBoundary | null }));
vi.mock("node:child_process", () => ({ spawn: fixture.rawSpawn }));
vi.mock("../../agents/containment/cloud-execution-boundary", () => ({
  isCloudExecutionBoundary: (value: unknown) => value === fixture.boundary,
}));
vi.mock("../../agents/containment/cloud-runtime-root.mjs", () => ({ resolveCloudRuntime: () => ({
  profile: "v4", root: "/pinned/runtime", workerRoot: "/pinned/runtime/worker", node: "/pinned/runtime/bin/node",
}) }));
import { createCloudDesignCaptureHost } from "../capture-cloud";
const input = { version: 1 as const, html: "<body>Fixture</body>", revision: "revision", width: 1, height: 1, colorScheme: "light" as const };
const roots = new Set<string>();
let prepared: PreparedBoundary;
function child() {
  const native = Object.assign(new EventEmitter(), { pid: 424242, stdin: new PassThrough(), stdout: new PassThrough() });
  let finish!: (value: { code: number | null; signal: string | null }) => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => { finish = resolve; });
  native.on("close", (code: number | null) => finish({ code, signal: null }));
  const ownedProcess = { child: native, pid: native.pid, stdin: native.stdin, stdout: native.stdout, wait: () => exited, stopAndProve: fixture.stop } as unknown as BoundaryProcess;
  return { native, process: ownedProcess, finish: () => {
    native.stdout.emit("data", Buffer.from(JSON.stringify({ data: Buffer.from("png").toString("base64"), renderer: "fixture", identity: {uid:process.geteuid!(),gid:process.getegid!()} })));
    native.emit("close", 0);
  } };
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.stop.mockResolvedValue(undefined); fixture.proof.mockResolvedValue(undefined);
  prepared = { spawn: fixture.spawn, stopAndProve: fixture.stop } as unknown as PreparedBoundary;
  fixture.boundary = { prepareOwned: fixture.prepare, proveFailedPreparationStopped: fixture.proof } as unknown as ExecutionBoundary;
  fixture.prepare.mockImplementation(async request => { roots.add(request.cwd); return prepared; });
  // Old direct-spawn code can finish its request, so the retained RED cannot hang.
  fixture.rawSpawn.mockImplementation(() => { const value = child(); queueMicrotask(value.finish); return value.native; });
  vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const root of roots) await rm(root, { recursive: true, force: true }); roots.clear();
});
async function waiting() {
  await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledOnce());
}
it("uses the pinned Node and browser cache through the original owned workload, with engine identity", async () => {
  const value = child(); fixture.spawn.mockResolvedValue(value.process);
  const result = createCloudDesignCaptureHost(fixture.boundary!)(input, new AbortController().signal);
  await waiting();
  expect(fixture.rawSpawn).not.toHaveBeenCalled();
  expect(fixture.prepare).toHaveBeenCalledWith(expect.objectContaining({ actor: "repo-code-task", providerId: "design-capture" }),
    expect.objectContaining({ kind: "service", role: "workload", retainFailedPreparationProof: true, signal: expect.any(AbortSignal) }));
  const request = fixture.spawn.mock.calls[0]![0];
  expect(request).toMatchObject({ command: "/pinned/runtime/bin/node", args: ["/pinned/runtime/worker/dist-engine/design-capture-worker.js"],
    env: { PLAYWRIGHT_BROWSERS_PATH: "/pinned/runtime/worker/design-browsers" } });
  expect(request.env.HOME).toBe(request.cwd); expect(request.env.TMPDIR).toBe(request.cwd);
  expect(request.env).not.toHaveProperty("OPENAI_API_KEY");
  value.finish(); expect(await result).toEqual({ bytes: Buffer.from("png"), renderer: "fixture" });
  expect(fixture.stop).toHaveBeenCalledOnce(); await expect(access(request.cwd)).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects forged cloud placement before preparing or spawning", () => {
  expect(() => createCloudDesignCaptureHost({ backend: "cloud-worker" } as ExecutionBoundary)).toThrow();
  expect(fixture.prepare).not.toHaveBeenCalled(); expect(fixture.rawSpawn).not.toHaveBeenCalled();
});
it("waits for positive original retirement before returning output or releasing its HOME", async () => {
  const value = child(); fixture.spawn.mockResolvedValue(value.process);
  let prove!: () => void; fixture.stop.mockReturnValue(new Promise<void>(resolve => { prove = resolve; }));
  let returned = false;
  const result = createCloudDesignCaptureHost(fixture.boundary!)(input, new AbortController().signal).then(reply => { returned = true; return reply; });
  await waiting(); const request = fixture.spawn.mock.calls[0]![0]; value.finish();
  await vi.waitFor(() => expect(fixture.stop).toHaveBeenCalledOnce());
  expect(returned).toBe(false); await expect(access(request.cwd)).resolves.toBeUndefined();
  prove(); await result; await expect(access(request.cwd)).rejects.toMatchObject({ code: "ENOENT" });
});
it("retains temporary state when original retirement cannot be proved", async () => {
  const value = child(); fixture.spawn.mockResolvedValue(value.process); fixture.stop.mockRejectedValue(new Error("unconfirmed fixture retirement"));
  const result = createCloudDesignCaptureHost(fixture.boundary!)(input, new AbortController().signal); void result.catch(() => {});
  await waiting(); const request = fixture.spawn.mock.calls[0]![0]; value.finish();
  await expect(result).rejects.toThrow("retirement"); await expect(access(request.cwd)).resolves.toBeUndefined();
});
it("cancels only the original workload and waits for its retirement proof", async () => {
  const value = child(); fixture.spawn.mockResolvedValue(value.process); fixture.stop.mockImplementation(async () => { value.native.emit("close", null); });
  const controller = new AbortController(), result = createCloudDesignCaptureHost(fixture.boundary!)(input, controller.signal); void result.catch(() => {});
  await waiting(); controller.abort(); await expect(result).rejects.toThrow();
  expect(fixture.stop).toHaveBeenCalled(); expect(process.kill).not.toHaveBeenCalled();
});
it("applies the bounded timeout to the same registered workload", async () => {
  vi.useFakeTimers();
  const value = child(); fixture.spawn.mockResolvedValue(value.process); fixture.stop.mockImplementation(async () => { value.native.emit("close", null); });
  const result = createCloudDesignCaptureHost(fixture.boundary!)(input, new AbortController().signal); void result.catch(() => {});
  await waiting(); const control = fixture.prepare.mock.calls[0]![1];
  await vi.advanceTimersByTimeAsync(DESIGN_CAPTURE_TIMEOUT_MS);
  await expect(result).rejects.toThrow(); expect(control.signal.aborted).toBe(true);
  expect(fixture.stop).toHaveBeenCalled(); expect(process.kill).not.toHaveBeenCalled();
});
it("refuses a late prepared launch after cancellation and retires that original handle", async () => {
  let admit!: (value: PreparedBoundary) => void;
  fixture.prepare.mockImplementation(request => { roots.add(request.cwd); return new Promise<PreparedBoundary>(resolve => { admit = resolve; }); });
  const controller = new AbortController(), result = createCloudDesignCaptureHost(fixture.boundary!)(input, controller.signal); void result.catch(() => {});
  await vi.waitFor(() => expect(fixture.prepare).toHaveBeenCalledOnce()); controller.abort(); admit(prepared);
  await expect(result).rejects.toThrow(); expect(fixture.spawn).not.toHaveBeenCalled(); expect(fixture.stop).toHaveBeenCalledOnce();
});

it("reports the actual fixed-worker identity only after positive original retirement",async()=>{
  const value=child();fixture.spawn.mockResolvedValue(value.process);
  let prove!:()=>void;fixture.stop.mockReturnValue(new Promise<void>(resolve=>{prove=resolve;}));
  const observe=vi.fn(), result=createCloudDesignCaptureHost(fixture.boundary!,{onIdentity:observe})(input,new AbortController().signal);
  await waiting();value.finish();await vi.waitFor(()=>expect(fixture.stop).toHaveBeenCalledOnce());
  expect(observe).not.toHaveBeenCalled();prove();await result;
  expect(observe).toHaveBeenCalledWith({uid:process.geteuid!(),gid:process.getegid!()});
});
it.each([undefined,{uid:10001,gid:10001},{uid:-1,gid:0},{uid:"0",gid:0}])("refuses missing/foreign fixed-worker identity (%j)",async identity=>{
  const value=child();fixture.spawn.mockResolvedValue(value.process);
  const observe=vi.fn(),result=createCloudDesignCaptureHost(fixture.boundary!,{onIdentity:observe})(input,new AbortController().signal);void result.catch(()=>{});
  await waiting();value.native.stdout.emit("data",Buffer.from(JSON.stringify({data:Buffer.from("png").toString("base64"),renderer:"fixture",identity})));
  value.native.emit("close",0);await expect(result).rejects.toThrow("identity");expect(observe).not.toHaveBeenCalled();expect(fixture.stop).toHaveBeenCalledOnce();
});
