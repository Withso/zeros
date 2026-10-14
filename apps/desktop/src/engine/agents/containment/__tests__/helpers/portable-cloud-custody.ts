import { readFileSync, readdirSync, statSync } from "node:fs";
import { CloudOwnedWorkloadRegistry } from "../../cloud-owned-workloads";
import { createCloudWorkloadCustody } from "../../cloud-workload-custody";
import type { CloudWorkloadKernelProcess } from "../../cloud-workload-cgroup.mjs";
import type { CloudWorkerConfiguration } from "../../cloud-worker-config";
import { cloudWorkloadKernelFixture, common, engine, resident, workload } from "./cloud-workload-kernel";

/** Real process births/groups/executables, but deliberately FAKE cgroup and
 * UID placement. Reading the host's unused cgroup/status here couples a
 * portable test to unrelated runner processes and their namespace/exit races. */
export function portableKernelProcess(pid: number): CloudWorkloadKernelProcess | null {
  try {
    const source = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = source.lastIndexOf(")"), fields = source.slice(end + 1).trim().split(/\s+/);
    const numbers = [fields[1], fields[2], fields[3], fields[4], fields[5]].map(Number);
    const invalid = source.length === 0 ? "stat_empty" : source.length > 65536 ? "stat_size" :
      end < 0 || !source.startsWith(`${pid} (`) ? "stat_identity" :
      !/^[1-9][0-9]{0,19}$/.test(fields[19] ?? "") ? "stat_birth" :
      !/^[A-Z]$/.test(fields[0] ?? "") ? "stat_state" : null;
    if (invalid) throw new Error(`portable process fixture has invalid kernel identity: ${invalid}`);
    // A task observed during final reaping can still expose state X and its
    // birth, after the kernel has cleared group/session to -1. It is dead,
    // not a malformed live member. Never extend this to a live state.
    if (fields[0] === "X") return null;
    if (!numbers.every(Number.isSafeInteger) || numbers.slice(0, 3).some(value => value < 0))
      throw new Error("portable process fixture has invalid kernel identity: stat_numbers");
    let executable: CloudWorkloadKernelProcess["executable"] = null;
    try {
      const image = statSync(`/proc/${pid}/exe`, { bigint: true });
      if (image.isFile()) executable = { dev: String(image.dev), ino: String(image.ino) };
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    return { pid, parent: numbers[0]!, group: numbers[1]!, session: numbers[2]!, tty: numbers[3]!, foreground: numbers[4]!,
      startToken: fields[19]!, state: fields[0]!, directory: workload, uid: 10003, executable };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

/** Portable consumer fixture: real ORIGINAL Host groups and /proc births,
 * explicit FAKE cgroup membership. This never qualifies native entry/custody.
 * Tests must separately mock the deployment brand and runtime resolver. */
export function portableCloudWorkloads(configuration: CloudWorkerConfiguration, options: {
  maxScopes?: number;
  projectProcess?(member: CloudWorkloadKernelProcess, members: readonly CloudWorkloadKernelProcess[]): CloudWorkloadKernelProcess;
} = {}) {
  const f = cloudWorkloadKernelFixture(), original = portableKernelProcess(process.pid);
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
      const member = portableKernelProcess(Number(id));
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
