import { loadCloudWorkloadCustody } from "../../cloud-workload-cgroup.mjs";
import type { CloudWorkloadKernelIO, CloudWorkloadKernelProcess } from "../../cloud-workload-cgroup.mjs";

export const service = "/sys/fs/cgroup/system.slice/zeros-host.service";
export const common = `${service}/engine-runtime`;
export const engine = `${common}/engine-11111111-1111-4111-8111-111111111111`;
export const resident = `${common}/engine-workload-22222222-2222-4222-8222-222222222222`;
const container = `${common}/engine-workload-shared`;
export const workload = `${container}/workload`;
export const identity = (ino: string) => ({ dev: "7", ino, uid: 10003, mode: 0o40755, filesystem: 0x63677270 });
export const kernelProcess = (pid: number, directory: string, startToken = String(pid * 10)): CloudWorkloadKernelProcess => ({
  pid, parent: 1, group: pid, session: pid, tty: 0, foreground: -1, state: "S", startToken, directory,
  uid: 10003, executable: { dev: "4", ino: "99" },
});

export function cloudWorkloadKernelFixture() {
  const groups = new Map([
    [common, { identity: identity("1"), pids: [] as number[] }],
    [engine, { identity: identity("2"), pids: [101] }],
    [resident, { identity: identity("3"), pids: [102] }],
    [container, { identity: identity("4"), pids: [] as number[] }],
    [workload, { identity: identity("5"), pids: [] as number[] }],
  ]);
  const processes = new Map([[101, kernelProcess(101, engine)], [102, kernelProcess(102, resident)]]);
  const projection = { version: 1, common: { directory: common, dev: "7", ino: "1" },
    workload: { directory: workload, dev: "7", ino: "5" },
    infrastructure: [{ kind: "engine", pid: 101, startToken: "1010" }, { kind: "resident", pid: 102, startToken: "1020" }],
    cpuSplit: { engine: { cpuMax: "max 100000", cpuWeight: 100 }, workload: { controllers: ["cpu"], cpuWeight: 100,
      cap: { kind: "applied", effectiveCpus: 4, cpuMax: "300000 100000" } } },
  };
  const writes: string[] = [];
  let beforeRead: ((directory: string, control: string) => void) | undefined;
  let migrationFailure = false;
  const io: CloudWorkloadKernelIO = {
    identity: () => ({ pid: 101, uid: 10003, gid: 10003, euid: 10003, egid: 10003 }),
    projection: () => JSON.stringify(projection),
    directory: directory => {
      const group = groups.get(directory);
      if (!group) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return { ...group.identity };
    },
    control: (directory, control) => ({ ...groups.get(directory)!.identity, mode: 0o100644,
      uid: ["cgroup.procs", "cgroup.threads", "cgroup.subtree_control"].includes(control) ? 10003 : 65534 }),
    read: (directory, control) => {
      beforeRead?.(directory, control);
      if (control === "cgroup.procs") return groups.get(directory)!.pids.join("\n");
      if (control === "cgroup.events") return `populated ${[...groups].some(([name, group]) =>
        (name === directory || name.startsWith(`${directory}/`)) && group.pids.length) ? 1 : 0}\nfrozen 0\n`;
      if (control === "cgroup.subtree_control") return directory === common || directory === container ? "cpu" : "";
      if (control === "cpu.max") return directory === common ? "400000 100000" : directory === workload ? "300000 100000" : "max 100000";
      if (control === "cpu.weight") return "100";
      if (control === "memory.max") return "7516192768";
      if (control === "pids.max") return "4096";
      if (control === "memory.oom.group") return "1";
      throw new Error("unknown control");
    },
    children: directory => [...groups.keys()].filter(name => name.startsWith(`${directory}/`) && !name.slice(directory.length + 1).includes("/"))
      .map(name => name.slice(directory.length + 1)),
    process: pid => processes.get(pid) ?? null,
    writeSelf: directory => {
      if (migrationFailure) throw new Error("migration denied");
      writes.push(directory);
      for (const group of groups.values()) group.pids = group.pids.filter(pid => pid !== 101);
      groups.get(directory)!.pids.push(101);
      processes.set(101, { ...processes.get(101)!, directory });
    },
  };
  const load = () => loadCloudWorkloadCustody(service, io);
  return { io, groups, processes, projection, writes, load,
    beforeRead: (callback: typeof beforeRead) => { beforeRead = callback; }, denyMigration: () => { migrationFailure = true; } };
}
