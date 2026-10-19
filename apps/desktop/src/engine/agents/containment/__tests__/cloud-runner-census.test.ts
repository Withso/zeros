import { describe, expect, it } from "vitest";
import { cloudRunnerCensusRoots } from "../cloud-runner-boundary";
import type { CloudWorkloadCustody } from "../cloud-workload-custody";
import { cloudWorkloadKernelFixture, identity, kernelProcess, workload } from "./helpers/cloud-workload-kernel";

function fixture() {
  const f = cloudWorkloadKernelFixture(), directory = `${workload}/runner-boot/original.service`;
  f.groups.set(directory, { identity: { ...identity("99"), dev: "7" }, pids: [] });
  const proofs = [{ directory, dev: "7", ino: "99" }];
  const members = [{ ...kernelProcess(401, directory), parent: 1 },
    { ...kernelProcess(402, `${directory}/nested`), parent: 1 },
    { ...kernelProcess(403, `${directory}-different`), parent: 1 }];
  const census = { complete: true, populated: true, processes: members, workloadPids: [401, 402, 403], infrastructurePids: [],
    common: f.projection.common, groups: 3, censusSha256: "a".repeat(64) };
  const custody: CloudWorkloadCustody = { entry: { version: 1, common: f.projection.common, workload: f.projection.workload },
    controller: { kind: "engine", pid: 101, startToken: "1010" }, cpuSplit: f.projection.cpuSplit,
    assertLive() {}, inspect: () => census };
  return { ...f, directory, proofs, custody, census };
}
describe("original unit read-only descendant census", () => {
  it("includes reparented children without crossing a sibling unit name", () => {
    const f = fixture();
    expect(cloudRunnerCensusRoots(f.proofs, f.custody, f.io)).toEqual([{ pid: 401, startToken: "4010" }, { pid: 402, startToken: "4020" }]);
    expect(f.writes).toEqual([]);
  });
  it.each(["incomplete", "replaced", "foreign", "late-replaced"])("keeps %s census unknown", kind => {
    const f = fixture(), replace = () => { f.groups.get(f.directory)!.identity.ino = "100"; };
    if (kind === "incomplete") f.census.complete = false;
    if (kind === "replaced") replace();
    if (kind === "foreign") f.census.processes[0]!.uid = 0;
    if (kind === "late-replaced") f.custody.inspect = () => { replace(); return f.census; };
    expect(() => cloudRunnerCensusRoots(f.proofs, f.custody, f.io)).toThrow();
    expect(f.writes).toEqual([]);
  });
});
