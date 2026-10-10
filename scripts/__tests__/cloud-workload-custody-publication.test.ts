import { closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { cloudWorkloadCustodyBirth, replaceCloudCustodyDocument } from "../cloud-workspace-validation/sandbox/publish-cloud-workload-custody.mjs";
const common = "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime";
const scope = `${common}/engine-32345678-1234-4234-8234-123456789abc`;
const seed = { version: 1, common: { directory: common, dev: "0", ino: "201" }, workload: { directory: `${common}/engine-workload-shared/workload`, dev: "0", ino: "202" }, infrastructure: [],
  cpuSplit: { engine: { cpuMax: "max 100000", cpuWeight: 100 }, workload: { controllers: ["cpu"], cpuWeight: 100, cap: { kind: "applied", effectiveCpus: 4, cpuMax: "300000 100000" } } } };
const source = `345 (fixed C child) S 234 ${Array(17).fill("0").join(" ")} 987654 0\n`;
const child = { pid: 345, parentPid: 234, source, scope };
it("publishes only the original direct blocked child birth, with immutable scope inode facts", () => {
  expect(cloudWorkloadCustodyBirth(seed, child)).toEqual({ ...seed, infrastructure: [{ kind: "engine", pid: 345, startToken: "987654" }] });
  expect(seed.infrastructure).toEqual([]);
});
it("uses the kernel comm terminator, retaining a real comm containing right parentheses", () => {
  expect(cloudWorkloadCustodyBirth(seed, { ...child, source: source.replace("fixed C child", "fixed) C) child") }).infrastructure[0].startToken).toBe("987654");
});
it.each([{ ...child, parentPid: 999 }, { ...child, pid: 346 }, { ...child, scope: `${common}/../host` }, { ...child, scope: common }, { ...child, source: source.replace(" S ", " Z ") }, { ...child, source: source.replace("987654", "0") }])("refuses foreign, unowned, dead or malformed blocked child %#", value => {
  expect(() => cloudWorkloadCustodyBirth(seed, value)).toThrow();
});
it("retains only prior original controller births and refuses same-PID contradictions", () => {
  const prior = { ...seed, infrastructure: [{ kind: "resident", pid: 123, startToken: "456" }] };
  expect(cloudWorkloadCustodyBirth(prior, child).infrastructure).toEqual([...prior.infrastructure, { kind: "engine", pid: 345, startToken: "987654" }]);
  expect(() => cloudWorkloadCustodyBirth({ ...prior, infrastructure: [{ kind: "resident", pid: 345, startToken: "12" }] }, child)).toThrow();
});
it("refuses changed paths, noncanonical inode data, oversize lists or private extra fields", () => {
  for (const value of [{ ...seed, common: { ...seed.common, directory: "/sys/fs/cgroup/host" } }, { ...seed, workload: { ...seed.workload, ino: "0202" } },
    { ...seed, infrastructure: Array.from({ length: 16 }, (_, n) => ({ kind: "resident", pid: 1000 + n, startToken: String(1000 + n) })) }, { ...seed, token: "synthetic-private" }])
    expect(() => cloudWorkloadCustodyBirth(value, child)).toThrow();
});
it("replaces the seed it read through the same descriptor from byte zero", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "zeros-custody-document-"));
  const published = JSON.stringify(cloudWorkloadCustodyBirth(seed, child));
  try {
    const descriptor = openSync(path.join(directory, "custody.json"), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeSync(descriptor, JSON.stringify({ ...seed, prior: "x".repeat(96) }), 0);
      // As in the publisher, reading the seed leaves the offset at its end.
      JSON.parse(readFileSync(descriptor, "utf8"));
      replaceCloudCustodyDocument(descriptor, published);
      const bytes = Buffer.alloc(fstatSync(descriptor).size);
      expect(readSync(descriptor, bytes, 0, bytes.length, 0)).toBe(bytes.length);
      expect(bytes.toString("utf8")).toBe(published);
    } finally { closeSync(descriptor); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
