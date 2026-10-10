import { describe, expect, it } from "vitest";
import * as identity from "../cloud-workspace-validation/cloud-agent-e2e/identity";
import { fixtureDescriptor } from "../cloud-workspace-validation/cloud-agent-e2e/runtime-contract";
const root = `/opt/zeros-infra/r1-${"a".repeat(64)}`;
const map = "     10003      10003          1\n";
const zeroCaps = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map(name => `${name}:\t0000000000000000`).join("\n");
const stat = (pid: number, parent: number, birth = 90) => `${pid} (node) ${["S", parent, ...Array(17).fill(0), birth].join(" ")}`;
const sample = { pid: 9, executable: `${root}/bin/node`, uidMap: map, gidMap: map, stat: stat(9, 8),
  status: `Name:\tnode\nPPid:\t8\nUid:\t10003\t10003\t10003\t10003\nGid:\t10003\t10003\t10003\t10003\n${zeroCaps}\nNoNewPrivs:\t1\nSeccomp:\t2\n` };
describe("private observed engine identity", () => {
  it("requires the actual executable, all effective/saved ids and exact kernel uid/gid maps", () => {
    expect(identity.selectRuntimeEngineProcess([sample], root, 8)).toBe(9);
    for (const wrong of [ { ...sample, executable: "/usr/bin/node" }, { ...sample, uidMap: "0 0 4294967295\n" },
      { ...sample, gidMap: "0 10003 1\n10001 10001 2\n" }, { ...sample, uidMap: "0 10003 1\n" },
      { ...sample, status: sample.status.replace("Uid:\t10003", "Uid:\t0") } ])
      expect(() => identity.selectRuntimeEngineProcess([wrong], root, 8)).toThrow("engine_identity_missing");
  });
  it("refuses ambiguous or absent process identity before a graceful signal", () => {
    expect(() => identity.selectRuntimeEngineProcess([], root, 8)).toThrow("engine_identity_missing");
    expect(() => identity.selectRuntimeEngineProcess([sample, { ...sample, pid: 10, stat: stat(10, 8) }], root, 8)).toThrow("engine_identity_missing");
    expect(() => identity.selectRuntimeEngineProcess([{ ...sample, pid: 1 }], root, 8)).toThrow("engine_identity_missing");
  });
  it("selects the engine ancestor rather than same-Node Host supervisor and provider descendants", () => {
    const child = { ...sample, pid: 12, stat: stat(12, 9, 100), status: sample.status.replace("PPid:\t8", "PPid:\t9") };
    const provider = { ...sample, pid: 13, stat: stat(13, 12, 110), status: sample.status.replace("PPid:\t8", "PPid:\t12") };
    expect(identity.selectRuntimeEngineProcess([provider, child, sample], root, 8)).toBe(9);
  });
  it("accepts the original launcher after exec but refuses to substitute its child when the engine protections fail", () => {
    const child = { ...sample, pid: 12, stat: stat(12, 9, 100), status: sample.status.replace("PPid:\t8", "PPid:\t9") };
    expect(identity.selectRuntimeEngineProcess([child, sample], root, 9)).toBe(9);
    const unsafe = { ...sample, status: sample.status.replace("CapBnd:\t0000000000000000", "CapBnd:\t0000000000000001") };
    expect(() => identity.selectRuntimeEngineProcess([child, unsafe], root, 8)).toThrow("engine_identity_missing");
  });
  it.each(["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"])("refuses a missing or nonzero %s", field => {
    for (const status of [sample.status.replace(`${field}:\t0000000000000000`, `${field}:\t0000000000000001`),
      sample.status.replace(`${field}:\t0000000000000000\n`, "")])
      expect(() => identity.selectRuntimeEngineProcess([{ ...sample, status }], root, 8)).toThrow("engine_identity_missing");
  });
  it.each(["NoNewPrivs", "Seccomp"])("refuses disabled %s", field => {
    const status = sample.status.replace(new RegExp(`${field}:\\t\\d`), `${field}:\t0`);
    expect(() => identity.selectRuntimeEngineProcess([{ ...sample, status }], root, 8)).toThrow("engine_identity_missing");
  });
  it("never selects a matching peer outside the original launcher family or a cyclic parent graph", () => {
    expect(() => identity.selectRuntimeEngineProcess([sample], root, 99)).toThrow("engine_identity_missing");
    const first = { ...sample, stat: stat(9, 12), status: sample.status.replace("PPid:\t8", "PPid:\t12") };
    const second = { ...sample, pid: 12, stat: stat(12, 9), status: sample.status.replace("PPid:\t8", "PPid:\t9") };
    expect(() => identity.selectRuntimeEngineProcess([first, second], root, 8)).toThrow("engine_identity_missing");
  });
  it("binds later observations to original birth, refusing PID reuse and malformed stat", () => {
    const observed = identity.selectRuntimeEngineIdentity([sample], root, 8);
    expect(observed).toMatchObject({ pid: 9, startTimeTicks: 90 });
    expect(identity.selectRuntimeEngineIdentity([sample], root, 8, observed)).toEqual(observed);
    expect(() => identity.selectRuntimeEngineIdentity([{ ...sample, stat: stat(9, 8, 91) }], root, 8, observed)).toThrow("engine_identity_missing");
    for (const malformed of ["", stat(10, 8), stat(9, 999), `${stat(9, 8)} unexpected`, stat(9, 8, Number.MAX_SAFE_INTEGER + 1)])
      expect(() => identity.selectRuntimeEngineIdentity([{ ...sample, stat: malformed }], root, 8)).toThrow("engine_identity_missing");
  });
});

describe("original installed-runtime root and engine births", () => {
  const active = fixtureDescriptor("a".repeat(64), "/sys/fs/cgroup/system.slice/zeros-host.service").active;
  const observation = () => ({ pid: 8, startTimeTicks: 70, executable: `${root}/bin/node`, uid: 0, gid: 0, euid: 0, egid: 0,
    mountNamespace: "mnt:[44]", pidNamespace: "pid:[45]", procFilesystemType: 0x9fa0, cgroupFilesystemType: 0x63677270,
    cgroup: "0::/system.slice/zeros-host.service/host\n",
    service: { directory: active.cgroupRoot, dev: "43", ino: "101" },
    host: { directory: `${active.cgroupRoot}/host`, dev: "43", ino: "102" } });
  const rootSample = () => ({ pid: 8, executable: `${root}/bin/node`, uidMap: "0 0 4294967295\n", gidMap: "0 0 4294967295\n",
    stat: stat(8, 1, 70), status: "PPid:\t1\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\n", cgroup: observation().cgroup });
  const engine = () => ({ ...sample, cgroup: "0::/system.slice/zeros-host.service/engine-runtime/engine-32345678-1234-4234-8234-123456789abc\n" });
  const scope = `${active.cgroupRoot}/engine-runtime/engine-32345678-1234-4234-8234-123456789abc`;

  it("permits only the pinned outside-root controller and records actual service/host inode identities", () => {
    const original = identity.requireInstalledRootIdentity(observation(), active);
    expect(original).toEqual(observation());
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.service)).toBe(true);
    expect(identity.requireInstalledRootIdentity(observation(), active, original)).toEqual(original);
  });
  it("binds the installed operator child root to its original parent, PID and unchanged service/host", () => {
    const parent = identity.requireInstalledRootIdentity(observation(), active), child = { ...observation(), pid: 10, startTimeTicks: 80 };
    const original = identity.requireInstalledHarnessChildRoot(child, active, parent, 10);
    expect(original).toEqual(child);
    expect(identity.requireInstalledHarnessChildRoot(child, active, parent, 10, original)).toEqual(child);
    for (const changed of [{ pid: 11 }, { startTimeTicks: 60 }, { mountNamespace: "mnt:[46]" }, { pidNamespace: "pid:[46]" },
      { service: { ...child.service, ino: "103" } }, { host: { ...child.host, ino: "103" } }])
      expect(() => identity.requireInstalledHarnessChildRoot({ ...child, ...changed }, active, parent, 10)).toThrow("fixture_contract_invalid");
    expect(() => identity.requireInstalledHarnessChildRoot({ ...child, startTimeTicks: 81 }, active, parent, 10, original))
      .toThrow("fixture_contract_invalid");
  });

  it.each([
    { uid: 10003 }, { euid: 10003 }, { gid: 10003 }, { egid: 10003 }, { pid: 1 }, { startTimeTicks: 0 },
    { executable: "/usr/bin/node" }, { procFilesystemType: 0x01021994 }, { cgroupFilesystemType: 0x01021994 },
    { cgroup: "0::/system.slice/zeros-host.service/engine-runtime\n" },
    { mountNamespace: "unknown" }, { pidNamespace: "unknown" },
  ])("refuses an unproved root controller %j", changed => {
    expect(() => identity.requireInstalledRootIdentity({ ...observation(), ...changed }, active)).toThrow("fixture_contract_invalid");
  });

  it("refuses controller PID reuse, changed namespaces, and replacement service/host inodes", () => {
    const original = identity.requireInstalledRootIdentity(observation(), active);
    for (const changed of [{ pid: 9 }, { startTimeTicks: 71 }, { mountNamespace: "mnt:[46]" }, { pidNamespace: "pid:[46]" },
      { host: { ...observation().host, ino: "103" } }, { service: { ...observation().service, dev: "44" } }])
      expect(() => identity.requireInstalledRootIdentity({ ...observation(), ...changed }, active, original))
        .toThrow("fixture_contract_invalid");
  });

  it("selects the original child engine in its exact control leaf, retaining ancestor and birth checks", () => {
    const original = identity.requireInstalledRootIdentity(observation(), active);
    const observed = identity.selectInstalledRuntimeEngineIdentity([rootSample(), engine()], active, original, 9, scope);
    expect(observed).toMatchObject({ pid: 9, startTimeTicks: 90, engineUid: 10003 });
    expect(identity.selectInstalledRuntimeEngineIdentity([rootSample(), engine()], active, original, 9, scope, observed)).toEqual(observed);
    for (const changed of [{ stat: stat(9, 8, 91) }, { cgroup: "0::/system.slice/zeros-host.service/engine-runtime/engine-workload-shared/workload\n" }])
      expect(() => identity.selectInstalledRuntimeEngineIdentity([rootSample(), { ...engine(), ...changed }], active, original, 9, scope, observed))
        .toThrow("engine_identity_missing");
  });

  it("refuses a missing/replaced root birth or a protected child substituted for an unsafe engine", () => {
    const original = identity.requireInstalledRootIdentity(observation(), active);
    expect(() => identity.selectInstalledRuntimeEngineIdentity([engine()], active, original, 9, scope)).toThrow("engine_identity_missing");
    expect(() => identity.selectInstalledRuntimeEngineIdentity([{ ...rootSample(), stat: stat(8, 1, 71) }, engine()], active, original, 9, scope))
      .toThrow("engine_identity_missing");
    const unsafe = { ...engine(), status: sample.status.replace("CapBnd:\t0000000000000000", "CapBnd:\t0000000000000001") };
    const child = { ...engine(), pid: 12, stat: stat(12, 9, 100), status: sample.status.replace("PPid:\t8", "PPid:\t9") };
    expect(() => identity.selectInstalledRuntimeEngineIdentity([rootSample(), unsafe, child], active, original, 9, scope))
      .toThrow("engine_identity_missing");
  });
});
