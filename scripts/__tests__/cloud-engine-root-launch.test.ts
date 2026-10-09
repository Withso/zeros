import { EventEmitter } from "node:events";
import { ChildProcess } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { launchCloudEngine } from "../cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs";
import { testCloudRuntime } from "../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime";

const view = "/run/zeros/view/runtime-12345678-1234-4234-8234-123456789abc";
const id = "32345678-1234-4234-8234-123456789abc";
const runtime = testCloudRuntime();
const directory = `${runtime.cgroupRoot}/engine-runtime/engine-${id}`;
const common = `${runtime.cgroupRoot}/engine-runtime`;
const seed = { version: 1, common: { directory: common, dev: "0", ino: "21" }, workload: { directory: `${common}/engine-workload-shared/workload`, dev: "0", ino: "22" }, infrastructure: [],
  cpuSplit: { engine: { cpuMax: "max 100000", cpuWeight: 100 }, workload: { controllers: ["cpu"], cpuWeight: 100, cap: { kind: "applied", effectiveCpus: 4, cpuMax: "300000 100000" } } } };
function fixture(operation = "serve", inner?: unknown) {
  const order: string[] = [], stdout = new PassThrough();
  const scope = { directory, placement: `${directory}@0:23`, prepare: vi.fn(() => order.push("scope")),
    custodySeed: vi.fn(() => seed), attach: vi.fn(), retire: vi.fn(async () => { order.push("controller-retired"); }) };
  const retireRuntime = vi.fn(async () => { order.push("whole-tree-kill-empty"); return { populated: 0, pruned: true }; });
  const publish = vi.fn();
  const child = Object.assign(new ChildProcess(), { pid: 123, exitCode: null as number | null, signalCode: null, stdout,
    kill: vi.fn(() => true), unref: vi.fn(), stdio: [null, stdout, null, new Writable({ write(_bytes, _encoding, done) {
      order.push("release-root-launcher"); done(); setImmediate(() => {
        if (inner !== undefined) stdout.end(JSON.stringify(inner) + "\n");
        child.exitCode = 0; order.push("engine-exit"); child.emit("exit", 0);
      });
    } })] as [null, PassThrough, null, Writable] });
  const spawnProcess = vi.fn((_file: string, _args: string[], _options: unknown) => { order.push("root-spawn"); setImmediate(() => child.emit("spawn")); return child; });
  const options = { operation, runtime, scope, spawnProcess, signals: new EventEmitter(), source: {},
    assertOutside: vi.fn(() => order.push("root-outside")), retireRuntime, publish,
    prepare: vi.fn((_runtime: unknown, _source: unknown, _operation: unknown, custody: unknown) => {
      order.push("view"); expect(custody).toEqual(seed); return { version: 4 as const, profile: "zeros-cloud-worker-v4" as const,
        engineUid: 10003 as const, engineGid: 10003 as const, runtimeDirectory: "/run/zeros/engine" as const,
        setupDirectory: "/srv/zeros/setup" as const, managedSettingsDirectory: "/srv/zeros/managed-settings" as const,
        runtime, viewDirectory: view, residentHostId: undefined, releaseView: vi.fn() };
    }) };
  return { options, child, order, scope, spawnProcess, retireRuntime, publish };
}
it("keeps the root wrapper outside and releases only the C-owned placement barrier", async () => {
  const { options, order, scope, spawnProcess } = fixture();
  expect(await launchCloudEngine(options)).toBe(0);
  expect(scope.attach).not.toHaveBeenCalled();
  expect(order).toEqual(["root-outside", "scope", "view", "root-spawn", "release-root-launcher", "engine-exit", "controller-retired"]);
  const args = spawnProcess.mock.calls[0][1];
  expect(args[0]).toBe("--await-launch");
  expect(args.slice(-5)).toEqual([runtime.engineNamespace, "--runtime-id", runtime.runtimeId, "--engine-scope", scope.placement]);
});
it("refuses a root monitor inside the delegated tree before any admission", async () => {
  const { options, scope, spawnProcess } = fixture();
  options.assertOutside.mockImplementation(() => { throw new Error("root placement refused"); });
  await expect(launchCloudEngine(options)).rejects.toThrow("root placement refused");
  expect(scope.prepare).not.toHaveBeenCalled(); expect(spawnProcess).not.toHaveBeenCalled();
});
it("positively retires its original prepared controller scope when readonly view admission fails", async () => {
  const { options, scope, spawnProcess } = fixture();
  options.prepare.mockImplementation(() => { throw new Error("readonly projection refused"); });
  await expect(launchCloudEngine(options)).rejects.toThrow("readonly projection refused");
  expect(scope.retire).toHaveBeenCalledOnce();
  expect(spawnProcess).not.toHaveBeenCalled();
});
it("never kills or adopts a scope whose own original admission was refused", async () => {
  const { options, scope, spawnProcess } = fixture();
  scope.prepare.mockImplementation(() => { throw new Error("foreign populated scope"); });
  await expect(launchCloudEngine(options)).rejects.toThrow("foreign populated scope");
  expect(scope.retire).not.toHaveBeenCalled();
  expect(options.prepare).not.toHaveBeenCalled();
  expect(spawnProcess).not.toHaveBeenCalled();
});
const inner = { version: 2, boundary: "workspace-vm", qualified: false, engineChecksPassed: true,
  execution: { vmWorkloadDrain: false, originalProcessGroupsRetired: true } };
it("promotes qualification only after the real engine exits and the outside-root whole tree drains", async () => {
  const { options, order, scope, publish } = fixture("qualify", inner);
  expect(await launchCloudEngine(options)).toBe(0);
  expect(order.indexOf("whole-tree-kill-empty")).toBeGreaterThan(order.indexOf("engine-exit"));
  expect(publish).toHaveBeenCalledWith({ version: 2, boundary: "workspace-vm", qualified: true,
    execution: { vmWorkloadDrain: true, originalProcessGroupsRetired: true } });
  expect(scope.retire).not.toHaveBeenCalled();
});
it.each([{}, { populated: 1, pruned: true }, { populated: 0, pruned: false }])("never invents whole-tree proof from %j", async receipt => {
  const { options, retireRuntime, publish } = fixture("qualify", inner);
  retireRuntime.mockResolvedValue(receipt as { populated: number; pruned: boolean });
  await expect(launchCloudEngine(options)).rejects.toThrow(/retirement/); expect(publish).not.toHaveBeenCalled();
});
it.each([{ ...inner, qualified: true }, { ...inner, engineChecksPassed: false }, { ...inner, execution: { vmWorkloadDrain: true } }])("refuses invented inner final success %j", async value => {
  const { options, publish, retireRuntime } = fixture("qualify", value);
  await expect(launchCloudEngine(options)).rejects.toThrow(/qualification/);
  expect(retireRuntime).toHaveBeenCalledOnce(); expect(publish).not.toHaveBeenCalled();
});
