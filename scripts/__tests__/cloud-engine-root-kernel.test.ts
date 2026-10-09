import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

it.skipIf(process.env.ZEROS_RUNTIME_KERNEL_FIXTURE !== "1")("places the fully dropped original engine before native work and root-drains every shared descendant", async () => {
  const require = createRequire(import.meta.url);
  const tsx = path.join(path.dirname(require.resolve("tsx/package.json")), "dist/cli.mjs");
  let output;
  try {
    output = execFileSync("sudo", ["-n", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", process.execPath, tsx,
      path.resolve("scripts/__tests__/helpers/cloud-engine-root-kernel-runner.ts")], { cwd: process.cwd(), timeout: 25_000, encoding: "utf8", maxBuffer: 65536 });
  } catch (error) {
    const failed = error as { stdout?: string };
    const result = failed.stdout ? JSON.parse(failed.stdout) : { cause: "runtime_kernel_root_runner_unavailable" };
    throw new Error(result.cause);
  }
  const result = JSON.parse(output);
  writeFileSync(".context/agents-fix/scratch/W3/zsr/kernel-c4-current-evidence.json", JSON.stringify(result, null, 2) + "\n");
  expect(result.uid).toBe(10003); expect(result.gid).toBe(10003);
  expect(result.uidMap).toMatch(/^10003\s+10003\s+1$/);
  expect(result.gidMap).toMatch(/^10003\s+10003\s+1$/);
  expect(result.status).toEqual({ CapEff: "0000000000000000", CapPrm: "0000000000000000", CapInh: "0000000000000000",
    CapBnd: "0000000000000000", CapAmb: "0000000000000000", NoNewPrivs: "1", Seccomp: "2" });
  for (const key of ["recordBeforeEntry", "rootOutside", "everyTreeMemberNonRoot", "controlAliasAbsent", "limitsDenied", "hostDenied",
    "detachedWriting", "treeRemoved", "detachedWritesStopped", "movedControllerRefused"]) expect(result[key]).toBe(true);
  expect(result.detachedMembership).toBe(result.expectedSiblingMembership);
  expect(result.finalReceipt).toMatchObject({ populated: 0, pruned: true });
  expect(result.agentExit).toBe(0);
  expect(result.census).toMatchObject({ complete: true, workloadPids: [result.writerPid], infrastructurePids: [result.pid] });
  expect(result.actualLimits).toMatchObject({ common: { "memory.max": "7516192768", "pids.max": "4096", "memory.oom.group": "1" },
    engine: { "cpu.max": "max 100000", "cpu.weight": "100" }, workload: { "cpu.weight": "100" }, controllers: "cpu" });
  expect(result.rootControllersRestored).toBe(true); expect(result.venueRemoved).toBe(true);
  expect(result.stderrBytes).toBe(0);
  expect(result.resourceQualification).toBe(false); expect(result.hostEntryQualification).toBe(true);
}, 30_000);
