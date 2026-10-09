import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { cloudRoleIdentityProbe } from "../cloud-workspace-validation/sandbox/cloud-role-identity";
const directory = "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime/engine-workload-shared/workload";
const names = ["mnt", "pid", "user", "net", "cgroup"];
const namespaces = Object.fromEntries(names.map((name, index) => [name, `${name}:[${100 + index}]`]));
const status = ["CapEff", "CapPrm", "CapInh", "CapBnd", "CapAmb"].map(name => `${name}:\t0000000000000000`).join("\n") + "\nNoNewPrivs:\t1\nSeccomp:\t2\n";
function run(changes: { uid?: number; status?: string; membership?: string; namespace?: string; home?: string; credential?: string } = {}) {
  const script = cloudRoleIdentityProbe({ workloadDirectory: directory, home: "/fixture/home", credential: "absent" },
    (file: string) => namespaces[file.split("/").at(-1)!]!) + "process.stdout.write('qualified');";
  let output = "", code = 0; const stopped = {};
  try { runInNewContext(script, { require: () => ({
    readFileSync: (file: string) => file.endsWith("/status") ? changes.status ?? status : changes.membership ?? `0::${directory.slice("/sys/fs/cgroup".length)}\n`,
    readlinkSync: (file: string) => changes.namespace ?? namespaces[file.split("/").at(-1)!],
  }), process: { getuid: () => changes.uid ?? 10003, geteuid: () => changes.uid ?? 10003, getgid: () => changes.uid ?? 10003, getegid: () => changes.uid ?? 10003,
    env: { HOME: changes.home ?? "/fixture/home", CURSOR_API_KEY: changes.credential }, stdout: { write: (value: string) => { output += value; } },
    exit: (value: number) => { code = value; throw stopped; } }, Buffer }); }
  catch (error) { if (error !== stopped) throw error; }
  return { code, output };
}
it("requires actual same-user, same-namespace, no-cap target placement and physical HOME", () => {
  expect(run()).toEqual({ code: 0, output: "qualified" });
});
it.each([
  { uid: 0 }, { uid: 10001 }, { namespace: "user:[foreign]" }, { membership: "0::/unrelated\n" },
  { home: "/other/home" }, { credential: "synthetic-unexpected" },
  { status: status.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0") },
  { status: status.replace("Seccomp:\t2", "Seccomp:\t0") },
  { status: status.replace("CapBnd:\t0000000000000000", "CapBnd:\t0000000000000001") },
])("refuses changed target identity or startup protection %j", change => {
  expect(run(change)).toEqual({ code: 91, output: "" });
});
