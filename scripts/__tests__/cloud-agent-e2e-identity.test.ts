import { describe, expect, it } from "vitest";
import { selectRuntimeEngineProcess } from "../cloud-workspace-validation/cloud-agent-e2e/identity";
const root = `/opt/zeros-infra/r1-${"a".repeat(64)}`;
const map = "         0      10003          1\n     10001      10001          2\n     10004      10004          1\n";
const sample = { pid: 9, executable: `${root}/bin/node`, uidMap: map, gidMap: map,
  status: "Name:\tnode\nUid:\t10003\t10003\t10003\t10003\nGid:\t10003\t10003\t10003\t10003\n" };
describe("private observed engine identity", () => {
  it("requires the actual executable, all effective/saved ids and exact kernel uid/gid maps", () => {
    expect(selectRuntimeEngineProcess([sample], root)).toBe(9);
    for (const wrong of [ { ...sample, executable: "/usr/bin/node" }, { ...sample, uidMap: "0 0 4294967295\n" },
      { ...sample, gidMap: "0 10003 1\n10001 10001 2\n" }, { ...sample, status: sample.status.replace("Uid:\t10003", "Uid:\t0") } ])
      expect(() => selectRuntimeEngineProcess([wrong], root)).toThrow("engine_identity_missing");
  });
  it("refuses ambiguous or absent process identity before a graceful signal", () => {
    expect(() => selectRuntimeEngineProcess([], root)).toThrow("engine_identity_missing");
    expect(() => selectRuntimeEngineProcess([sample, { ...sample, pid: 10 }], root)).toThrow("engine_identity_missing");
    expect(() => selectRuntimeEngineProcess([{ ...sample, pid: 1 }], root)).toThrow("engine_identity_missing");
  });
});
