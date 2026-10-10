import { expect, it } from "vitest";
import { cloudRootControllerBirth } from "../cloud-workspace-validation/sandbox/publish-cloud-workload-custody.mjs";
const common = "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime";
const runtime = { runtimeId: `r1-${"a".repeat(64)}`, bootId: "12345678-1234-4234-8234-123456789abc", supervisorSessionId: "22345678-1234-4234-8234-123456789abc" };
const scope = { directory: `${common}/engine-workload-32345678-1234-4234-8234-123456789abc`, dev: "0", ino: "21" };
const record = { version: 1, episode: "42345678-1234-4234-8234-123456789abc", runtime, scope,
  common: { directory: common, dev: "0", ino: "20" }, workload: { directory: `${common}/engine-workload-shared/workload`, dev: "0", ino: "22" },
  owner: { pid: 100, startToken: "10" }, monitor: { pid: 200, startToken: "20" }, birth: { kind: "resident", pid: 300, startToken: "30" } };
const stat = (pid: number, ppid: number, birth: string) => `${pid} (pinned controller) S ${ppid} ${Array(17).fill("0").join(" ")} ${birth} 0\n`;
const status = (uid: number) => `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
function fixture() {
  const processes = new Map([
    [100, { source: stat(100, 17, "10"), status: status(0), membership: "0::/system.slice/zeros-host.service/host\n" }],
    [200, { source: stat(200, 100, "20"), status: status(0), membership: "0::/system.slice/zeros-host.service/host\n" }],
    [300, { source: stat(300, 200, "30"), status: status(10003), membership: `0::${scope.directory.slice("/sys/fs/cgroup".length)}\n` }],
  ]);
  const identities = new Map([record.common, record.workload, record.scope].map(value => [value.directory, value]));
  const io = { process: (pid: number) => processes.get(pid), identity: (directory: string) => identities.get(directory) };
  const expected = { runtime, scope, owner: record.owner, episode: record.episode };
  return { processes, identities, io, expected };
}
it("accepts only the original live non-root controller chain after actual placement", () => {
  const { io, expected } = fixture(); expect(cloudRootControllerBirth(record, expected, io)).toEqual(record.birth);
});
it.each(["owner", "monitor", "birth"])("refuses reused or stale %s PID births", kind => {
  const { io, expected, processes } = fixture(); const identity = record[kind as "owner" | "monitor" | "birth"];
  processes.set(identity.pid, { ...processes.get(identity.pid)!, source: stat(identity.pid, kind === "owner" ? 17 : kind === "monitor" ? 100 : 200, "999") });
  expect(() => cloudRootControllerBirth(record, expected, io)).toThrow();
});
it.each(["scope", "common", "workload"])("refuses changed original %s inode", kind => {
  const { io, expected, identities } = fixture(); const identity = record[kind as "scope" | "common" | "workload"];
  identities.set(identity.directory, { ...identity, ino: "999" }); expect(() => cloudRootControllerBirth(record, expected, io)).toThrow();
});
it("record existence before drop/placement never authorizes an infrastructure exemption", () => {
  const { io, expected, processes } = fixture();
  processes.set(300, { ...processes.get(300)!, status: status(0), membership: "0::/system.slice/zeros-host.service/host\n" });
  expect(() => cloudRootControllerBirth(record, expected, io)).toThrow();
});
it("refuses a root monitor/owner inside the delegated tree, or an unrelated live child chain", () => {
  for (const change of [{ pid: 100, membership: `0::${common.slice("/sys/fs/cgroup".length)}/own-sibling\n` },
    { pid: 200, membership: `0::${scope.directory.slice("/sys/fs/cgroup".length)}\n` },
    { pid: 300, source: stat(300, 999, "30") }]) {
    const { io, expected, processes } = fixture(); processes.set(change.pid, { ...processes.get(change.pid)!, ...change });
    expect(() => cloudRootControllerBirth(record, expected, io)).toThrow();
  }
});
it("refuses foreign runtime, boot, episode and selected scope", () => {
  const { io, expected } = fixture();
  for (const value of [{ ...record, runtime: { ...runtime, runtimeId: `r1-${"b".repeat(64)}` } },
    { ...record, runtime: { ...runtime, bootId: "52345678-1234-4234-8234-123456789abc" } },
    { ...record, episode: "62345678-1234-4234-8234-123456789abc" },
    { ...record, scope: { ...scope, directory: scope.directory.replace("32345678", "72345678") } }])
    expect(() => cloudRootControllerBirth(value, expected, io)).toThrow();
});
it("refuses ambiguous/overflow/private record shapes and vanished controllers", () => {
  const { io, expected, processes } = fixture();
  for (const value of [{ ...record, token: "synthetic" }, { ...record, birth: { ...record.birth, startToken: "030" } },
    { ...record, owner: { ...record.owner, pid: 1 } }]) expect(() => cloudRootControllerBirth(value, expected, io)).toThrow();
  processes.delete(200); expect(() => cloudRootControllerBirth(record, expected, io)).toThrow();
});
