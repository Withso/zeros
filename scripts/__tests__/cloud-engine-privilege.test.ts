import { expect, it } from "vitest";
import { cloudEnginePrivilegeStatus } from "../cloud-workspace-validation/sandbox/qualify-cloud-engine.mjs";
const names = { effective: "CapEff", permitted: "CapPrm", inheritable: "CapInh", bounding: "CapBnd", ambient: "CapAmb" };
const status = Object.values(names).map(name => `${name}:\t0000000000000000`).join("\n") + "\nNoNewPrivs:\t1\nSeccomp:\t2\n";
it("observes all five empty kernel capability sets and retained NNP/seccomp", () => {
  expect(cloudEnginePrivilegeStatus(status)).toEqual({ noNewPrivs: 1, seccompMode: 2,
    capabilities: { effective: 0, permitted: 0, inheritable: 0, bounding: 0, ambient: 0 } });
});
it.each(Object.entries(names))("does not infer empty %s from missing, duplicate or nonzero kernel evidence", (key, name) => {
  for (const value of [status.replace(`${name}:\t0000000000000000\n`, ""),
    status.replace(`${name}:\t0000000000000000`, `${name}:\t0000000000000001`),
    status + `${name}:\t0000000000000000\n`])
    expect(cloudEnginePrivilegeStatus(value).capabilities[key]).not.toBe(0);
});
it.each(["NoNewPrivs", "Seccomp"])("refuses absent or conflicting %s evidence", name => {
  const expected = name === "NoNewPrivs" ? 1 : 2;
  for (const value of [status.replace(`${name}:\t${expected}\n`, ""), status + `${name}:\t${expected}\n`,
    status.replace(`${name}:\t${expected}`, `${name}:\tunknown`)])
    expect(cloudEnginePrivilegeStatus(value)[name === "NoNewPrivs" ? "noNewPrivs" : "seccompMode"]).not.toBe(expected);
});
it.each(Object.entries(names))("counts malformed duplicate %s lines as conflicting evidence", (key, name) => {
  for (const value of ["invalid duplicate", "", "0000000000000000 extra"])
    expect(cloudEnginePrivilegeStatus(status + `${name}:\t${value}\n`).capabilities[key]).not.toBe(0);
});
it.each(["NoNewPrivs", "Seccomp"])("counts malformed duplicate %s protection lines", name => {
  const key = name === "NoNewPrivs" ? "noNewPrivs" : "seccompMode";
  expect(cloudEnginePrivilegeStatus(status + `${name}:\tinvalid duplicate\n`)[key]).toBeNull();
});
