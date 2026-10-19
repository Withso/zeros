import { EventEmitter } from "node:events";
import { ChildProcess } from "node:child_process";
import { Writable } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { launchCloudEngine, assertCloudEngineFilesProjection } from "../cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";

import { testCloudRuntime } from "../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime";
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
