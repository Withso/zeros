import { readdirSync } from "node:fs";
import { CloudOwnedWorkloadRegistry } from "../../cloud-owned-workloads";
import { createCloudWorkloadCustody } from "../../cloud-workload-custody";
import { nativeCloudWorkloadIO, type CloudWorkloadKernelProcess } from "../../cloud-workload-cgroup.mjs";
import type { CloudWorkerConfiguration } from "../../cloud-worker-config";
import { cloudWorkloadKernelFixture, common, engine, resident, workload } from "./cloud-workload-kernel";

/** Portable consumer fixture: real ORIGINAL Host groups and /proc births,
 * explicit FAKE cgroup membership. This never qualifies native entry/custody.
 * Tests must separately mock the deployment brand and runtime resolver. */
export function portableCloudWorkloads(configuration: CloudWorkerConfiguration, options: {
  maxScopes?: number;
  projectProcess?(member: CloudWorkloadKernelProcess, members: readonly CloudWorkloadKernelProcess[]): CloudWorkloadKernelProcess;
} = {}) {
  const f = cloudWorkloadKernelFixture(), original = nativeCloudWorkloadIO.process(process.pid);
  if (!original) throw new Error("portable cloud fixture requires its actual process birth");
  f.groups.delete(resident); f.processes.clear();
  f.projection.infrastructure = [{ kind: "engine", pid: process.pid, startToken: original.startToken }];
  f.io.identity = () => ({ pid: process.pid, uid: 10003, gid: 10003, euid: 10003, egid: 10003 });
  const observed = new Map<number, string>();
  let registry: CloudOwnedWorkloadRegistry | undefined;
  function refresh() {
    const all = new Map<number, CloudWorkloadKernelProcess>();
    const ids = readdirSync("/proc").filter(value => /^[1-9]\d*$/.test(value));
    if (ids.length > 32768) throw new Error("portable process fixture exceeds capacity");
    for (const id of ids) {
      const member = nativeCloudWorkloadIO.process(Number(id));
      if (member && member.state !== "Z" && member.state !== "X") all.set(member.pid, member);
    }
    const roots = new Set(registry?.snapshot().scopes.flatMap(scope => scope.processGroups) ?? []);
    const selected = new Set<number>();
    for (const member of all.values())
      if (roots.has(member.group) || observed.get(member.pid) === member.startToken) selected.add(member.pid);
    for (let index = 0; index < all.size; index++) {
      const count = selected.size;
      for (const member of all.values()) if (selected.has(member.parent)) selected.add(member.pid);
      if (count === selected.size) break;
    }
    const members = [...selected].map(pid => ({ ...all.get(pid)!, directory: workload, uid: 10003 }));
    for (const member of members) observed.set(member.pid, member.startToken);
    f.processes.clear();
    const owner = all.get(process.pid);
    if (owner) f.processes.set(process.pid, { ...owner, directory: engine, uid: 10003 });
    for (const member of members) f.processes.set(member.pid, options.projectProcess?.(member, members) ?? member);
    f.groups.get(engine)!.pids = owner ? [process.pid] : [];
    f.groups.get(workload)!.pids = members.map(member => member.pid);
  }
  const read = f.io.read;
  f.io.read = (directory, name) => { if (directory === common && name === "cgroup.procs") refresh(); return read(directory, name); };
  refresh();
  const custody = createCloudWorkloadCustody(configuration, { io: f.io });
  registry = new CloudOwnedWorkloadRegistry({ custody, maxScopes: options.maxScopes });
  return registry;
}
