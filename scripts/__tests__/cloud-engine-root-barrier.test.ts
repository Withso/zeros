import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
let directory: string, binary: string;
const dropped = "Uid:\t10003\t10003\t10003\t10003\nGid:\t10003\t10003\t10003\t10003\nState:\tS (sleeping)\n" +
  ["CapEff", "CapPrm", "CapInh", "CapBnd", "CapAmb"].map(name => `${name}:\t0000000000000000\n`).join("") + "NoNewPrivs:\t1\nSeccomp:\t2\n";
beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "zeros-root-barrier-")); binary = path.join(directory, "probe");
  const source = path.join(directory, "probe.c");
  writeFileSync(source, `#define main zeros_namespace_main
#include ${JSON.stringify(path.resolve("scripts/cloud-workspace-validation/sandbox/cloud-engine-namespace.c"))}
#undef main
int main(void) { char source[8193];size_t count=fread(source,1,sizeof(source)-1,stdin);source[count]=0;require_engine_child_status(source);return 0; }
`);
  execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", binary], { timeout: 15000, stdio: "pipe" });
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
it("admits only the already dropped blocked non-root engine child", () => { expect(spawnSync(binary, [], { input: dropped, timeout: 3000 }).status).toBe(0); });
it.each(["Uid:\t0\t0\t0\t0", "Uid:\t10003\t0\t10003\t10003", "Gid:\t10003\t10001\t10003\t10003"])("refuses root or mixed credential identity %s before cgroup migration", replacement => {
  expect(spawnSync(binary, [], { input: dropped.replace(replacement.startsWith("Uid") ? /^Uid:.*$/m : /^Gid:.*$/m, replacement), timeout: 3000 }).status).toBe(125);
});
it.each(["CapEff", "CapPrm", "CapInh", "CapBnd", "CapAmb"])("refuses missing, duplicate or nonzero %s before release", name => {
  for (const value of [dropped.replace(`${name}:\t0000000000000000\n`, ""), dropped + `${name}:\t0000000000000000\n`, dropped.replace(`${name}:\t0000000000000000`, `${name}:\t0000000000000001`)])
    expect(spawnSync(binary, [], { input: value, timeout: 3000 }).status).toBe(125);
});
it.each([dropped.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"), dropped.replace("Seccomp:\t2", "Seccomp:\t0"), dropped.replace("State:\tS (sleeping)", "State:\tZ (zombie)")])("refuses lost deployment guards or dead child before migration", source => {
  expect(spawnSync(binary, [], { input: source, timeout: 3000 }).status).toBe(125);
});
