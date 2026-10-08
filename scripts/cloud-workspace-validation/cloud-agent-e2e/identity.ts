import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { HarnessFailure } from "./assertions";
import { assertPrivatePidNamespace } from "./fixture-scope";
type ProcessIdentity = { pid: number; executable: string; uidMap: string; gidMap: string; status: string };
const mapping = [[0, 10003, 1], [10001, 10001, 2], [10004, 10004, 1]];
function exactMap(value: string): boolean {
  const rows = value.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  return JSON.stringify(rows) === JSON.stringify(mapping);
}
export function selectRuntimeEngineProcess(samples: readonly ProcessIdentity[], root: string): number {
  if (!/^\/opt\/zeros-infra\/r1-[a-f0-9]{64}$/.test(root)) throw new HarnessFailure("fixture_contract_invalid");
  const matches = samples.filter(sample => Number.isSafeInteger(sample.pid) && sample.pid > 1 && sample.executable === `${root}/bin/node` &&
    exactMap(sample.uidMap) && exactMap(sample.gidMap) && ["Uid", "Gid"].every(kind => {
      const line = sample.status.split("\n").find(line => line.startsWith(`${kind}:`));
      const ids = line?.slice(4).trim().split(/\s+/).map(Number);
      return ids?.length === 4 && ids.every(id => id === 10003);
    }));
  if (matches.length !== 1) throw new HarnessFailure("engine_identity_missing");
  return matches[0].pid;
}
/** Read only fixed proc identity files, exclusively in this fixture PID domain.
 * No command lines or environments are opened. */
export function observedRuntimeEngine(root: string, outerPidNamespace: string): number {
  assertPrivatePidNamespace(outerPidNamespace, readlinkSync("/proc/self/ns/pid"), process.pid);
  const samples: ProcessIdentity[] = [];
  for (const name of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    const pid = Number(name); if (pid <= 1) continue;
    try {
      const executable = readlinkSync(`/proc/${pid}/exe`);
      if (executable !== `${root}/bin/node`) continue;
      samples.push({ pid, executable, uidMap: readFileSync(`/proc/${pid}/uid_map`, "utf8"),
        gidMap: readFileSync(`/proc/${pid}/gid_map`, "utf8"), status: readFileSync(`/proc/${pid}/status`, "utf8") });
    } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new HarnessFailure("engine_identity_missing"); }
  }
  return selectRuntimeEngineProcess(samples, root);
}
