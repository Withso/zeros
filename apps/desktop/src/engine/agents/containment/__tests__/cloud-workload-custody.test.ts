import { describe, expect, it } from "vitest";
import { enterCloudWorkload, inspectCloudWorkloadTree, loadCloudWorkloadCustody } from "../cloud-workload-cgroup.mjs";

import { cloudWorkloadKernelFixture as fixture, common, engine, identity, kernelProcess as process, resident, service, workload } from "./helpers/cloud-workload-kernel";

describe("delegated cloud workload kernel custody (explicit fake kernel IO)", () => {
  it("binds original common/workload identity and exact current controller births", () => {
    const f = fixture(), custody = f.load();
    expect(Object.isFrozen(custody)).toBe(true);
    expect(inspectCloudWorkloadTree(custody, f.io)).toMatchObject({ complete: true, populated: true,
      workloadPids: [], infrastructurePids: [101, 102] });
    expect(f.writes).toEqual([]);
  });
  it("catches a detached child whose parent exited before the first scan", () => {
    const f = fixture(); f.groups.get(workload)!.pids.push(301); f.processes.set(301, process(301, workload));
    const custody = f.load();
    expect(inspectCloudWorkloadTree(custody, f.io)).toMatchObject({ complete: true, workloadPids: [301] });
    f.groups.get(workload)!.pids = []; f.processes.delete(301);
    expect(inspectCloudWorkloadTree(custody, f.io)).toMatchObject({ complete: true, workloadPids: [] });
  });
  it.each([engine, `${common}/new-user-sibling`, `${common}/new-user-sibling/nested`])("counts a migrated job in %s", directory => {
    const f = fixture(), custody = f.load();
    if (!f.groups.has(directory)) f.groups.set(`${common}/new-user-sibling`, { identity: identity("8"), pids: [] });
    if (!f.groups.has(directory)) f.groups.set(directory, { identity: identity("9"), pids: [] });
    f.groups.get(directory)!.pids.push(301); f.processes.set(301, process(301, directory));
    expect(inspectCloudWorkloadTree(custody, f.io)).toMatchObject({ complete: true, workloadPids: [301] });
  });
  it.each(["recycled", "moved", "root"])("never exempts a %s controller", condition => {
    const f = fixture(), custody = f.load();
    if (condition === "recycled") f.processes.set(102, process(102, resident, "9999"));
    if (condition === "root") f.processes.set(102, { ...process(102, resident), uid: 0 });
    if (condition === "moved") {
      f.groups.get(resident)!.pids = []; f.groups.get(engine)!.pids.push(102);
      f.processes.set(102, process(102, engine));
    }
    expect(inspectCloudWorkloadTree(custody, f.io).workloadPids).toContain(102);
  });
  it.each(["common", "workload"] as const)("refuses a changed %s inode", which => {
    const f = fixture(), custody = f.load(); f.groups.get(f.projection[which].directory)!.identity.ino = "987";
    expect(inspectCloudWorkloadTree(custody, f.io).complete).toBe(false);
    expect(() => enterCloudWorkload(custody, f.io)).toThrow(); expect(f.writes).toEqual([]);
  });
  it("marks a concurrently created sibling census incomplete", () => {
    const f = fixture(), custody = f.load(); let changed = false;
    f.beforeRead((directory, control) => {
      if (!changed && directory === workload && control === "cgroup.procs") {
        changed = true; const sibling = `${common}/late`;
        f.groups.set(sibling, { identity: identity("10"), pids: [301] }); f.processes.set(301, process(301, sibling));
      }
    });
    expect(inspectCloudWorkloadTree(custody, f.io).complete).toBe(false);
  });
  it("refuses unreadable, overflowing or internally inconsistent membership", () => {
    for (const condition of ["unreadable", "overflow", "migrated"]) {
      const f = fixture(), custody = f.load();
      if (condition === "unreadable") f.beforeRead(() => { throw new Error("unreadable"); });
      if (condition === "overflow") f.groups.get(workload)!.pids = Array.from({ length: 4097 }, (_, i) => i + 400);
      if (condition === "migrated") { f.groups.get(workload)!.pids.push(301); f.processes.set(301, process(301, engine)); }
      expect(inspectCloudWorkloadTree(custody, f.io).complete).toBe(false);
    }
  });
  it("does not pin an exited original resident solely from metadata", () => {
    const f = fixture(), custody = f.load(); f.groups.get(resident)!.pids = []; f.processes.delete(102);
    expect(inspectCloudWorkloadTree(custody, f.io)).toMatchObject({ complete: true, workloadPids: [], infrastructurePids: [101] });
  });
  it("never exempts an original resident birth after its control leaf inode changes", () => {
    const f = fixture(), custody = f.load(); f.groups.get(resident)!.identity.ino = "999";
    expect(inspectCloudWorkloadTree(custody, f.io).workloadPids).toContain(102);
  });
  it("self-enters with unprivileged credentials before target execution and closes migration authority", () => {
    const f = fixture(), custody = f.load(); enterCloudWorkload(custody, f.io);
    expect(f.writes).toEqual([workload]); expect(f.processes.get(101)!.directory).toBe(workload);
  });
  it("binds census identity to workloads and sibling groups, while controller scheduling is inert", () => {
    const f = fixture(), custody = f.load();
    const first = inspectCloudWorkloadTree(custody, f.io);
    expect(first.censusSha256).toMatch(/^[a-f0-9]{64}$/);
    f.processes.set(101, { ...f.processes.get(101)!, state: "R" });
    expect(inspectCloudWorkloadTree(custody, f.io).censusSha256).toBe(first.censusSha256);
    const sibling = `${common}/empty-new-sibling`; f.groups.set(sibling, { identity: identity("77"), pids: [] });
    expect(inspectCloudWorkloadTree(custody, f.io).censusSha256).not.toBe(first.censusSha256);
  });
  it("does not confuse regexp punctuation with the exact admitted controller path", () => {
    const f = fixture(); f.processes.set(101, process(101, engine.replace("system.slice", "systemXslice")));
    expect(f.load).toThrow();
  });
  it.each([engine, workload])("requires root-owned actual cpu.weight 100 at %s", directory => {
    const f = fixture(), read = f.io.read;
    f.io.read = (candidate, name) => candidate === directory && name === "cpu.weight" ? "101" : read(candidate, name);
    expect(f.load).toThrow();
  });
  it.each(["18446744073709551616", "99999999999999999999"])("refuses overflowing kernel decimal %s", value => {
    const f = fixture(); f.projection.common.dev = value; f.groups.get(common)!.identity.dev = value;
    expect(f.load).toThrow();
  });
  it("refuses source outside the delegated tree and a failed migration", () => {
    const f = fixture(), custody = f.load(); f.processes.set(101, process(101, `${service}/host`));
    expect(() => enterCloudWorkload(custody, f.io)).toThrow(); expect(f.writes).toEqual([]);
    const denied = fixture(), other = denied.load(); denied.denyMigration();
    expect(() => enterCloudWorkload(other, denied.io)).toThrow(); expect(denied.writes).toEqual([]);
  });
  it.each(["root", "missing-current", "unknown-field", "foreign-destination", "duplicate-birth", "root-limit-writable"])(
    "rejects %s projection or delegation before activation", condition => {
      const f = fixture();
      if (condition === "root") f.io.identity = () => ({ pid: 101, uid: 0, gid: 0, euid: 0, egid: 0 });
      if (condition === "missing-current") f.projection.infrastructure.shift();
      if (condition === "unknown-field") Object.assign(f.projection, { callerPid: 301 });
      if (condition === "foreign-destination") f.projection.workload.directory = `${service}/host`;
      if (condition === "duplicate-birth") f.projection.infrastructure.push({ ...f.projection.infrastructure[0]! });
      if (condition === "root-limit-writable") {
        const control = f.io.control; f.io.control = (directory, name) => ({ ...control(directory, name), uid: 10003 });
      }
      expect(f.load).toThrow();
    });
});
