import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  CLOUD_ENGINE_LIMITS,
  CloudDelegatedCgroups,
  CloudEngineCgroup,
  cloudCgroupDirectory,
} from "../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";

function fixture() {
  let clock = 0;
  let exists = true;
  const controls = new Map<string, string>([
    ["cgroup.events", "populated 0\nfrozen 0"],
    ["cgroup.procs", ""],
  ]);
  const io = {
    exists: vi.fn(() => exists),
    create: vi.fn(() => {
      exists = true;
    }),
    read: vi.fn((_directory: string, name: string) => controls.get(name) ?? ""),
    write: vi.fn((_directory: string, name: string, value: string) => {
      controls.set(name, value);
    }),
    remove: vi.fn(() => {
      exists = false;
    }),
  };
  const scope = new CloudEngineCgroup({
    io,
    now: () => clock,
    pause: async (milliseconds: number) => {
      clock += milliseconds;
    },
  });
  return { scope, io, controls };
}

describe("cloud engine cgroup lifecycle", () => {
  it("uses a separate leaf accepted by the unchanged protected base's stop verifier", () => {
    const tree = cloudRuntimeFixture();
    try {
      const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
      const directory = cloudCgroupDirectory(runtime, "workload", "32345678-1234-4234-8234-123456789abc");
      const result = spawnSync("python3", ["-I", "-c", `
import importlib.util,pathlib,sys,tempfile,types
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('bootstrap','scripts/cloud-workspace-validation/runtime-base-v4/bootstrap.py')
b=importlib.util.module_from_spec(s);s.loader.exec_module(b)
with tempfile.TemporaryDirectory(prefix='zeros-resident-base-') as directory:
 b.CGROUP=directory
 root=pathlib.Path(directory); leaf=root/sys.stdin.read().strip();leaf.mkdir()
 for scope in [root,leaf]: (scope/'cgroup.events').write_text('populated 0\\n')
 host=b.SystemHost()
 host.control=lambda *args: types.SimpleNamespace(returncode=0,stdout=b'')
 host.stop()
`], { input: pathLeaf(directory), encoding: "utf8", timeout: 5000 });
      expect(result.status).toBe(0);
    } finally { tree.dispose(); }
  });
  it("preserves only the explicitly witnessed resident scope during engine replacement", async () => {
    const tree = cloudRuntimeFixture();
    try {
      const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
      const residentId = "32345678-1234-4234-8234-123456789abc";
      const sourceId = "42345678-1234-4234-8234-123456789abc";
      const resident = cloudCgroupDirectory(runtime, "workload", residentId);
      const engine = cloudCgroupDirectory(runtime, "engine", sourceId);
      const children = new Set(["host", "setup", pathLeaf(resident), pathLeaf(engine)]);
      const io = {
        exists: () => true,
        children: () => [...children],
        read: () => "populated 0",
        write: vi.fn(),
        remove: vi.fn((directory: string) => { children.delete(pathLeaf(directory)); }),
      };
      const scopes = new CloudDelegatedCgroups({ runtime, io });
      await scopes.retire({ preserveWorkload: residentId });
      expect(io.write).toHaveBeenCalledWith(engine, "cgroup.kill", "1");
      expect(io.write).not.toHaveBeenCalledWith(resident, "cgroup.kill", "1");
      expect(children).toEqual(new Set(["host", pathLeaf(resident)]));
      // Ordinary stop and recovery retain the complete old retirement rule.
      await scopes.retire();
      expect(io.write).toHaveBeenCalledWith(resident, "cgroup.kill", "1");
      expect(children).toEqual(new Set(["host"]));
    } finally { tree.dispose(); }
  });

  it("rejects missing or malformed preservation witnesses before retiring any engine", async () => {
    const tree = cloudRuntimeFixture();
    try {
      const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
      const io = { exists: () => true, children: () => ["host", "setup"], write: vi.fn() };
      const scopes = new CloudDelegatedCgroups({ runtime, io });
      for (const preserveWorkload of ["../host", "", "32345678-1234-4234-8234-123456789abc"])
        await expect(scopes.retire({ preserveWorkload })).rejects.toThrow(/workload/);
      expect(io.write).not.toHaveBeenCalled();
      expect(() => new CloudEngineCgroup({ kind: "workload", instanceId: "32345678-1234-4234-8234-123456789abc" }))
        .toThrow(/scope identity/);
    } finally { tree.dispose(); }
  });
  it("provides a separate fixed setup scope without accepting arbitrary host cgroups", () => {
    expect(new CloudEngineCgroup({ directory: "/sys/fs/cgroup/zeros-cloud-setup" }).directory).toBe("/sys/fs/cgroup/zeros-cloud-setup");
    for (const directory of ["/sys/fs/cgroup/user.slice", "/sys/fs/cgroup/zeros-cloud-setup/../", "/sys/fs/cgroup/zeros-cloud-setup-extra"])
      expect(() => new CloudEngineCgroup({ directory })).toThrow(/scope identity/);
  });
  it("removes a newly created empty scope when applying its limits fails", () => {
    const { scope, io } = fixture();
    io.exists.mockReturnValue(false);
    io.write.mockImplementation(() => {
      throw new Error("controller unavailable");
    });
    expect(() => scope.prepare()).toThrow(/controller unavailable/);
    expect(io.remove).toHaveBeenCalledOnce();
    expect(io.write).not.toHaveBeenCalledWith(
      scope.directory,
      "cgroup.kill",
      "1",
    );
  });
  it("sets and confirms finite CPU, memory and process limits before placement", () => {
    const { scope, io, controls } = fixture();
    scope.prepare();
    for (const [name, value] of Object.entries(CLOUD_ENGINE_LIMITS))
      expect(controls.get(name)).toBe(value);
    scope.attach(123);
    expect(controls.get("cgroup.procs")).toBe("123");
    expect(io.remove).not.toHaveBeenCalled();
  });
  it("never reuses a populated scope or silently accepts a lost limit write", () => {
    const { scope, io, controls } = fixture();
    controls.set("cgroup.events", "populated 1\nfrozen 0");
    expect(() => scope.prepare()).toThrow(/not retired/);
    expect(io.write).not.toHaveBeenCalled();
    controls.set("cgroup.events", "populated 0");
    io.write.mockImplementation(() => {});
    expect(() => scope.prepare()).toThrow(/not confirmed/);
  });
  it("requires affirmative placement and rejects invalid process identities", () => {
    const { scope, io } = fixture();
    for (const pid of [0, 1, -1, 1.5, NaN, 2 ** 32])
      expect(() => scope.attach(pid)).toThrow(/identity/);
    expect(io.write).not.toHaveBeenCalled();
    io.write.mockImplementation(() => {});
    expect(() => scope.attach(123)).toThrow(/placement/);
  });
  it("kills detached descendants and waits for affirmative emptiness", async () => {
    const { scope, io, controls } = fixture();
    let polls = 0;
    io.read.mockImplementation((_directory, name) =>
      name === "cgroup.events"
        ? `populated ${polls++ < 3 ? 1 : 0}`
        : (controls.get(name) ?? ""),
    );
    await scope.retire();
    expect(io.write).toHaveBeenCalledWith(scope.directory, "cgroup.kill", "1");
    expect(polls).toBe(4);
    expect(io.remove).toHaveBeenCalledOnce();
  });
  it("bounds retirement and preserves an unconfirmed scope for recovery", async () => {
    const { scope, io, controls } = fixture();
    controls.set("cgroup.events", "populated 1");
    await expect(scope.retire(60)).rejects.toThrow(/unconfirmed/);
    expect(io.remove).not.toHaveBeenCalled();
  });
  it("does not infer emptiness from malformed or missing kernel evidence", async () => {
    for (const evidence of [
      "",
      "frozen 0",
      "populated 0\npopulated 1",
      "populated 2",
    ]) {
      const { scope, io, controls } = fixture();
      controls.set("cgroup.events", evidence);
      await expect(scope.retire()).rejects.toThrow(/population evidence/);
      expect(io.remove).not.toHaveBeenCalled();
    }
  });
  it("tolerates an absent retired scope and rejects arbitrary cgroup paths", async () => {
    const { scope, io } = fixture();
    io.exists.mockReturnValue(false);
    await scope.retire();
    expect(io.write).not.toHaveBeenCalled();
    for (const directory of [
      "/sys/fs/cgroup",
      "/sys/fs/cgroup/another",
      "/tmp/zeros-cloud-engine",
    ])
      expect(() => new CloudEngineCgroup({ directory })).toThrow(
        /scope identity/,
      );
  });
});

function pathLeaf(directory: string): string { return directory.slice(directory.lastIndexOf("/") + 1); }
