import { EventEmitter } from "node:events";
import { ChildProcess } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { launchCloudEngine, assertCloudEngineFilesProjection } from "../cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";

import { testCloudRuntime } from "../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime";
import { bootFixture } from "./cloud-boot-admission-fixture";
function fixture() {
  const runtime = testCloudRuntime();
  const directory = `${runtime.cgroupRoot}/engine-runtime/engine-11111111-1111-4111-8111-111111111111`;
  const common = `${runtime.cgroupRoot}/engine-runtime`;
  const order: string[] = [];
  const signals = new EventEmitter();
  const child = Object.assign(new ChildProcess(), {
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
  const barrier = new Writable({
    write(_chunk, _encoding, done) {
      order.push("release");
      done();
    },
  });
  Object.assign(child, { stdio: [null, null, null, barrier] });
  const scope = {
    directory,
    placement: `${directory}@0:23`,
    prepare: vi.fn(() => {
      order.push("scope");
    }),
    attach: vi.fn(() => {
      order.push("place");
    }),
    custodySeed: vi.fn(() => ({ version: 1,
      common: { directory: common, dev: "0", ino: "21" },
      workload: { directory: `${common}/engine-workload-shared/workload`, dev: "0", ino: "22" },
      infrastructure: [],
      cpuSplit: { engine: { cpuMax: "max 100000", cpuWeight: 100 }, workload: { controllers: ["cpu"], cpuWeight: 100,
        cap: { kind: "applied", effectiveCpus: 4, cpuMax: "300000 100000" } } },
    })),
    retire: vi.fn(async () => {
      order.push("retire");
    }),
  };
  const spawnProcess = vi.fn(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  const options = {
    runtime,
    assertOutside: vi.fn(),
    prepare: () => {
      order.push("prepare");
      return { version: 4 as const, profile: "zeros-cloud-worker-v4" as const,
        engineUid: 10003 as const, engineGid: 10003 as const, runtimeDirectory: "/run/zeros/engine" as const,
        setupDirectory: "/srv/zeros/setup" as const, managedSettingsDirectory: "/srv/zeros/managed-settings" as const,
        runtime, viewDirectory: "/run/zeros/view/runtime-11111111-1111-4111-8111-111111111111",
        residentHostId: undefined, releaseView: vi.fn() };
    },
    scope,
    spawnProcess,
    signals,
    source: {},
  };
  const finish = (code = 0) => {
    child.exitCode = code;
    child.emit("exit", code);
  };
  return { order, child, barrier, scope, options, signals, finish };
}

describe("cloud engine admission and lifecycle", () => {
  function boot() {
    const f = fixture(), b = bootFixture(), stdout = new PassThrough(), stdin = new PassThrough();
    const { retirement: receipt, outputJoined: _joined, ...inner } = b.probe;
    const original = { assertCurrent: vi.fn(), retire: vi.fn(async () => receipt), close: vi.fn() };
    const scope = { ...f.scope, directory: b.probe.custody.controller.scope.directory,
      placement: `${b.probe.custody.controller.scope.directory}@1:4`,
      custodySeed: () => ({ ...f.scope.custodySeed(), common: inner.custody.common, workload: inner.custody.workload }),
      pinBootRetirement: vi.fn(() => original) };
    const profile = { ...f.options.prepare(), releaseView: vi.fn(), readBootController: vi.fn(() => ({
      scope: inner.custody.controller.scope, birth: { pid: inner.custody.controller.pid, startToken: inner.custody.controller.startToken },
      common: inner.custody.common, workload: inner.custody.workload })) };
    Object.assign(f.child, { stdout, stdin });
    const publish = vi.fn(), assertBootIdle = vi.fn(), retainBootCustody = vi.fn();
    const options = { ...f.options, scope, operation: "boot-check", bootBudgetMs: 1000, prepare: () => profile,
      assertBootIdle, retainBootCustody, publish, loadBootContract: () => import("../cloud-workspace-validation/sandbox/cloud-boot-contract") };
    f.barrier.once("finish", () => queueMicrotask(() => stdout.write(JSON.stringify(inner) + "\n")));
    stdin.on("data", chunk => { expect(String(chunk)).toBe("1"); stdout.end(); f.finish(); });
    return { ...f, inner, original, scope, profile, stdout, stdin, options, publish, assertBootIdle, retainBootCustody };
  }
  it("joins the short probe only after the root checks original live controller custody", async () => {
    const f = boot(); await expect(launchCloudEngine(f.options)).resolves.toBe(0);
    expect(f.assertBootIdle).toHaveBeenCalledTimes(2); expect(f.scope.pinBootRetirement).toHaveBeenCalledOnce();
    expect(f.profile.readBootController).toHaveBeenCalledOnce();
    expect(f.original.retire).toHaveBeenCalledOnce(); expect(f.original.close).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledWith({ ...f.inner, retirement: await f.original.retire.mock.results[0].value, outputJoined: true });
    expect(f.scope.retire).not.toHaveBeenCalled();
    expect(f.retainBootCustody).not.toHaveBeenCalled();
  });
  it("late_probe_cannot_publish_or_retire_replacement and retains unknown custody", async () => {
    const f = boot(); f.original.assertCurrent.mockImplementation(() => { throw new Error("original replaced"); });
    await expect(launchCloudEngine(f.options)).rejects.toThrow();
    expect(f.publish).not.toHaveBeenCalled(); expect(f.original.retire).not.toHaveBeenCalled();
    expect(f.scope.retire).not.toHaveBeenCalled(); expect(f.profile.releaseView).not.toHaveBeenCalled();
    expect(f.retainBootCustody).toHaveBeenCalledOnce();
  });
  it("unknown retirement cannot publish or discard original view/custody", async () => {
    const f = boot(); f.original.retire.mockRejectedValue(new Error("unknown retirement"));
    await expect(launchCloudEngine(f.options)).rejects.toThrow();
    expect(f.publish).not.toHaveBeenCalled(); expect(f.profile.releaseView).not.toHaveBeenCalled();
    expect(f.retainBootCustody).toHaveBeenCalledOnce();
  });
  it("a refused root controller record cannot acknowledge or publish a probe", async () => {
    const f = boot(); f.profile.readBootController.mockImplementation(() => { throw new Error("wrong controller birth"); });
    f.child.kill.mockImplementation(() => { f.stdout.end(); f.finish(125); return true; });
    await expect(launchCloudEngine(f.options)).rejects.toThrow();
    expect(f.publish).not.toHaveBeenCalled(); expect(f.original.retire).toHaveBeenCalledOnce();
  });
  it("short deadline revokes proof but preserves the complete TERM and cleanup ladder", async () => {
    vi.useFakeTimers(); const f = boot(); f.barrier.removeAllListeners("finish");
    const result = launchCloudEngine(f.options).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(1001);
      expect(f.child.kill).toHaveBeenCalledWith("SIGTERM"); expect(f.original.retire).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(9999); f.stdout.end(); await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBeInstanceOf(Error); expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(f.original.retire).toHaveBeenCalledOnce(); expect(f.publish).not.toHaveBeenCalled();
    } finally { f.finish(125); vi.useRealTimers(); }
  });
  it("new production launch acquires its own custody and never reuses retired probe identity", async () => {
    const probe = boot(); await launchCloudEngine(probe.options);
    const serving = fixture(); serving.barrier.once("finish", () => queueMicrotask(() => serving.finish()));
    await launchCloudEngine(serving.options);
    expect(serving.scope.prepare).toHaveBeenCalledOnce(); expect(serving.scope.custodySeed).toHaveBeenCalledOnce();
    expect(serving.scope.directory).not.toBe(probe.scope.directory);
    expect(serving.scope.retire).toHaveBeenCalledOnce(); expect(probe.scope.retire).not.toHaveBeenCalled();
  });
  it("cancellation retires original custody without waiting for a stuck report decoder", async () => {
    vi.useFakeTimers(); const f = boot();
    f.options.loadBootContract = () => new Promise(() => {});
    const running = launchCloudEngine(f.options).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(11001); f.stdout.end(); await vi.advanceTimersByTimeAsync(1);
      expect(f.original.retire).toHaveBeenCalledOnce();
      expect(await running).toBeInstanceOf(Error); expect(f.publish).not.toHaveBeenCalled();
    } finally { f.finish(125); vi.useRealTimers(); }
  });
  it("a decoder completing after cancellation cannot acknowledge or mutate a finished launch", async () => {
    vi.useFakeTimers(); const f = boot();
    let complete!: (contract: Awaited<ReturnType<typeof f.options.loadBootContract>>) => void;
    f.options.loadBootContract = () => new Promise(resolve => { complete = resolve; });
    const running = launchCloudEngine(f.options).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(11001); f.stdout.end(); await vi.advanceTimersByTimeAsync(1);
      expect(await running).toBeInstanceOf(Error);
      const signals = f.child.kill.mock.calls.length;
      complete(await import("../cloud-workspace-validation/sandbox/cloud-boot-contract"));
      await vi.advanceTimersByTimeAsync(1);
      expect(f.profile.readBootController).not.toHaveBeenCalled();
      expect(f.child.kill).toHaveBeenCalledTimes(signals); expect(f.publish).not.toHaveBeenCalled();
    } finally { f.finish(125); vi.useRealTimers(); }
  });
  it("keeps the resident control pipe open and retires its separate scope when the host dies", async () => {
    const tree = cloudRuntimeFixture();
    try {
      const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
      const f = fixture();
      const options = { ...f.options, operation: "resident", runtime,
        prepare: () => ({ ...f.options.prepare(), runtime }) };
      f.barrier.once("finish", () => queueMicrotask(() => f.finish(125)));
      await expect(launchCloudEngine(options)).resolves.toBe(125);
      const call = f.options.spawnProcess.mock.calls[0] as unknown as [string, string[], { stdio: string[] }];
      expect(call[1]).toContain("--resident");
      expect(call[1].slice(-3)).toEqual(["--engine-scope", f.scope.placement, "--resident"]);
      expect(call[2].stdio).toEqual(["inherit", "inherit", "inherit", "pipe"]);
      expect(f.scope.retire).toHaveBeenCalledOnce();
    } finally { tree.dispose(); }
  });
  it("admits the protected repos root only on v4 while rejecting setup and broker authority", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zeros-v2-test-projection-"));
    const rootPath = vi.fn();
    try {
      mkdirSync(path.join(root, "workspace"));
      mkdirSync(path.join(root, "repos"));
      assertCloudEngineFilesProjection({ profile: "v4" }, { root, rootPath });
      expect(rootPath).toHaveBeenCalledWith(path.join(root, "repos"), true);
      expect(() => assertCloudEngineFilesProjection({ profile: "v3" }, { root, rootPath })).toThrow();
      for (const name of ["setup", "broker", ".zeros-setup-private", "computer-template.json"]) {
        mkdirSync(path.join(root, name));
        expect(() => assertCloudEngineFilesProjection({ profile: "v4" }, { root, rootPath })).toThrow();
        rmSync(path.join(root, name), { recursive: true });
      }
      rmSync(path.join(root, "repos"), { recursive: true });
      symlinkSync("/srv/zeros/setup", path.join(root, "repos"));
      expect(() => assertCloudEngineFilesProjection({ profile: "v4" }, { root, rootPath })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("starts the fixed C entry behind the root launch barrier with the original placement", async () => {
    const f = fixture();
    f.barrier.once("finish", () => queueMicrotask(() => f.finish()));
    await launchCloudEngine(f.options);
    const call = f.options.spawnProcess.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    expect(call[0]).toBe(f.options.runtime.engineNamespace);
    expect(call[1][0]).toBe("--await-launch");
    expect(call[1]).not.toContain("--block-fd");
    expect(call[1].slice(-2)).toEqual(["--engine-scope", f.scope.placement]);
    expect(f.scope.attach).not.toHaveBeenCalled();
  });
  it("prepares original custody before releasing the fixed C entry and reaps its scope on exit", async () => {
    const f = fixture();
    f.barrier.once("finish", () => queueMicrotask(() => f.finish()));
    await expect(launchCloudEngine(f.options)).resolves.toBe(0);
    expect(f.order).toEqual(["scope", "prepare", "release", "retire"]);
    expect(f.scope.attach).not.toHaveBeenCalled();
  });
  it("never admits execution when the original root launch barrier fails", async () => {
    const f = fixture();
    f.barrier._write = (_bytes, _encoding, done) => done(new Error("launch barrier unconfirmed"));
    await expect(launchCloudEngine(f.options)).rejects.toThrow(
      /launch barrier failed/,
    );
    expect(f.order).not.toContain("release");
    expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(f.scope.retire).toHaveBeenCalledOnce();
  });
  it("closes launch handles even when scope retirement fails", async () => {
    const f = fixture();
    f.barrier.once("finish", () => queueMicrotask(() => f.finish()));
    f.scope.retire.mockRejectedValue(new Error("scope still populated"));
    await expect(launchCloudEngine(f.options)).rejects.toThrow(
      /still populated/,
    );
    expect(f.barrier.destroyed).toBe(true);
    expect(f.child.unref).toHaveBeenCalledOnce();
  });
  it("bounds a child that ignores termination and removes signal listeners", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let completed = false;
    const running = launchCloudEngine(f.options).then((code) => {
      completed = true;
      return code;
    });
    try {
      await vi.advanceTimersByTimeAsync(1);
      f.signals.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(10001);
      expect(completed).toBe(true);
      await expect(running).resolves.toBe(125);
      expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(f.scope.retire).toHaveBeenCalledOnce();
      expect(f.signals.listenerCount("SIGTERM")).toBe(0);
    } finally {
      f.finish();
      await running;
      vi.useRealTimers();
    }
  });
});
