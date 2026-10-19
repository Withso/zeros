import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudExecutionBoundary } from "../cloud-execution-boundary";
const fake = vi.hoisted(() => ({ supported: vi.fn(), process: vi.fn(), verify: vi.fn(), pin: vi.fn(),
  close: vi.fn(), kill: vi.fn(), stat: vi.fn(), events: vi.fn(), remove: vi.fn(), ping: vi.fn(), join: vi.fn() }));
vi.mock("node:fs", async actual => ({ ...await actual<typeof import("node:fs")>(),
  lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o555 }),
  statSync: () => ({ dev: 1n, ino: 2n }), openSync: fake.pin, closeSync: fake.close,
  fstatSync: fake.stat, writeFileSync: fake.kill, readFileSync: fake.events }));
vi.mock("node:fs/promises", async actual => ({ ...await actual<typeof import("node:fs/promises")>(),
  mkdtemp: async () => "/tmp/zeros-runners-abcdef", mkdir: async () => {}, rm: fake.remove }));
vi.mock("../cloud-runner-base.mjs", () => ({ cloudRunnerBaseSupported: fake.supported }));
vi.mock("../cloud-workload-cgroup.mjs", async actual => ({ ...await actual<typeof import("../cloud-workload-cgroup.mjs")>(),
  nativeCloudWorkloadIO: { process: fake.process } }));
vi.mock("../cloud-runner-native", () => ({ verifyCloudRunnerManager: fake.verify,
  CloudRunnerNativeClient: class { ping = fake.ping; join = fake.join; } }));
import { CloudRunnerRuntime, startCloudRunnerRuntime } from "../cloud-runner-runtime";

const id = "11111111-1111-4111-8111-111111111111";
const scope = { organizationId: id, workspaceId: id, generation: 1, engineInstanceId: id, bootId: id, writerEpoch: id,
  runtimeId: `r1-${"a".repeat(64)}` };
const workload = { directory: "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime/engine-workload-shared/workload", dev: "1", ino: "3" };
const proof = { version: 1, manager: { pid: 302, startToken: "3020" }, launcher: { pid: 302, startToken: "3020" },
  group: { directory: `${workload.directory}/runner-${id}`, dev: "1", ino: "4" }, executable: { dev: "1", ino: "2" } };
function fixture() {
  const stdout = new PassThrough(), stderr = new PassThrough();
  const stopped = vi.fn(async () => {}), failed = vi.fn(), assertCurrent = vi.fn();
  const process = { pid: 301, stdout, stderr, wait: () => new Promise(() => {}), stopAndProve: stopped };
  const spawn = vi.fn(async () => process), prepared = { spawn, stopAndProve: stopped };
  const boundary = { workloads: { custody: { assertLive() {}, controller: { kind: "engine", pid: 101, startToken: "1010" }, entry: { workload } } },
    prepareOwned: vi.fn(async () => prepared) } as unknown as CloudExecutionBoundary;
  return { stdout, spawn, stopped, boundary, failed, assertCurrent, options: { boundary, scope, failed, assertCurrent } };
}
beforeEach(() => {
  vi.clearAllMocks(); fake.supported.mockReturnValue(true);
  fake.process.mockReturnValue({ pid: 301, uid: 10003, startToken: "3010" }); fake.verify.mockReturnValue(proof);
  fake.pin.mockReturnValue(17); fake.stat.mockReturnValue({ dev: 1n, ino: 4n, nlink: 1 });
  fake.events.mockReturnValue("populated 0\nfrozen 0\n"); fake.ping.mockResolvedValue(undefined); fake.join.mockResolvedValue(undefined);
});
describe("private runner manager lifetime", () => {
  it("refuses to signal a replacement cgroup opened after the manager witness", async () => {
    const f = fixture();
    // The independently checked witness names inode 4. Simulate replacement
    // after that observation but before open/fstat pins the group descriptor.
    fake.stat.mockReturnValue({ dev: 1n, ino: 99n, nlink: 1 });
    const starting = startCloudRunnerRuntime({ ...f.options, negotiated: true });
    const rejected = expect(starting).rejects.toThrow("cloud_runner_manager_unavailable");
    await expect.poll(() => f.spawn.mock.calls.length).toBe(1);
    f.stdout.write(JSON.stringify(proof) + "\n");
    await rejected;
    expect(fake.kill).not.toHaveBeenCalled();
    expect(f.stopped).not.toHaveBeenCalled();
    expect(fake.remove).not.toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalledExactlyOnceWith(17);
    await expect(startCloudRunnerRuntime({ ...f.options, negotiated: true })).rejects.toThrow("cloud_runner_manager_unavailable");
    expect(f.spawn).toHaveBeenCalledOnce();
  });
  it("refuses cleanup authority when the opened group identity could not be read", async () => {
    const f = fixture();
    fake.stat.mockImplementationOnce(() => { throw new Error("unreadable original pin"); });
    const starting = startCloudRunnerRuntime({ ...f.options, negotiated: true });
    const rejected = expect(starting).rejects.toThrow("cloud_runner_manager_unavailable");
    await expect.poll(() => f.spawn.mock.calls.length).toBe(1);
    f.stdout.write(JSON.stringify(proof) + "\n");
    await rejected;
    expect(fake.kill).not.toHaveBeenCalled();
    expect(f.stopped).not.toHaveBeenCalled();
    expect(fake.remove).not.toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalledExactlyOnceWith(17);
    await expect(startCloudRunnerRuntime({ ...f.options, negotiated: true })).rejects.toThrow("cloud_runner_manager_unavailable");
    expect(f.spawn).toHaveBeenCalledOnce();
  });
  it("still retires the verified original manager after a later private-peer failure", async () => {
    const f = fixture();
    fake.ping.mockRejectedValueOnce(new Error("private peer unavailable"));
    const starting = startCloudRunnerRuntime({ ...f.options, negotiated: true });
    const rejected = expect(starting).rejects.toThrow("cloud_runner_manager_unavailable");
    await expect.poll(() => f.spawn.mock.calls.length).toBe(1);
    f.stdout.write(JSON.stringify(proof) + "\n");
    await rejected;
    expect(fake.kill).toHaveBeenCalledExactlyOnceWith("/proc/self/fd/17/cgroup.kill", "1");
    expect(f.stopped).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledExactlyOnceWith(17);
    expect(fake.remove).toHaveBeenCalledOnce();
  });
  it("never creates a manager for Local, unnegotiated cloud, or an old base", async () => {
    const f = fixture();
    expect(await startCloudRunnerRuntime({ ...f.options, boundary: null, negotiated: true })).toBeNull();
    expect(await startCloudRunnerRuntime({ ...f.options, negotiated: false })).toBeNull();
    fake.supported.mockReturnValue(false);
    expect(await startCloudRunnerRuntime({ ...f.options, negotiated: true })).toBeNull();
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("keeps an unproven launched manager unresolved instead of reporting Host transport exit as retirement", async () => {
    const f = fixture(), runtime = new CloudRunnerRuntime(f.options);
    const starting = runtime.start();
    const rejected = expect(starting).rejects.toThrow();
    await expect.poll(() => f.spawn.mock.calls.length).toBe(1);
    f.stdout.end(); await rejected;
    await expect(runtime.stop()).rejects.toThrow("cloud_runner_manager_unavailable");
    expect(f.stopped).not.toHaveBeenCalled(); expect(fake.remove).not.toHaveBeenCalled();
  });
  it("reserves the sole coordinator manager while its original launch is pending", async () => {
    const f = fixture(), starting = startCloudRunnerRuntime({ ...f.options, negotiated: true });
    await expect.poll(() => f.spawn.mock.calls.length).toBe(1);
    f.spawn.mockRejectedValueOnce(new Error("a duplicate original launch was attempted"));
    const duplicate = startCloudRunnerRuntime({ ...f.options, negotiated: true });
    await expect(duplicate).rejects.toThrow("cloud_runner_manager_unavailable");
    f.stdout.write(JSON.stringify(proof) + "\n");
    const runtime = await starting; await runtime!.stop();
    expect(f.spawn).toHaveBeenCalledOnce();
  });
  it("joins native IO and the pinned whole-manager cgroup before releasing Host custody", async () => {
    const f = fixture(), runtime = new CloudRunnerRuntime(f.options), starting = runtime.start();
    await expect.poll(() => f.spawn.mock.calls.length).toBe(1);
    f.stdout.write(JSON.stringify(proof) + "\n"); await starting;
    let release!: () => void;
    fake.join.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const stopped = runtime.stop();
    await expect.poll(() => fake.join.mock.calls.length).toBe(1);
    expect(fake.kill).not.toHaveBeenCalled(); expect(f.stopped).not.toHaveBeenCalled();
    release(); await stopped;
    expect(fake.kill).toHaveBeenCalledWith("/proc/self/fd/17/cgroup.kill", "1");
    expect(f.stopped).toHaveBeenCalledOnce(); expect(fake.close).toHaveBeenCalledWith(17);
    expect(fake.remove).toHaveBeenCalledOnce();
  });
});
