import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareClaudeCloudWorkload } from "../adapters/claude-sdk/__tests__/helpers/legacy-execution";
import { portableKernelProcess } from "../containment/__tests__/helpers/portable-cloud-custody";

const fault = { remaining: 0, failures: 0 };

let directory: string | undefined;
let physical: Awaited<ReturnType<typeof prepareClaudeCloudWorkload>> | undefined;
afterEach(async () => {
  fault.remaining = 0;
  await physical?.dispose();
  physical = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  fault.failures = 0;
});
async function prepare() {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-boot-census-cleanup-")));
  physical = await prepareClaudeCloudWorkload({ cwd: directory, dataRoot: directory,
    executionId: randomUUID(), conversationId: "census-cleanup", provider: "claude" }, {
    observeProcess(pid) {
      // The live test runner is a known foreign member of the /proc census.
      // Inject at the portable observation seam, not an unused native reader.
      if (pid === process.ppid && fault.remaining !== 0) {
        if (fault.remaining > 0) fault.remaining--;
        fault.failures++;
        throw new Error("Synthetic foreign proc observation is unavailable");
      }
      return portableKernelProcess(pid);
    },
  });
  return physical;
}

describe.runIf(process.platform === "linux")("portable cloud fixture census cleanup", () => {
  it("retries an incomplete foreign proc observation before requiring a positive empty proof", async () => {
    const scope = await prepare();
    fault.remaining = 1;
    await expect(scope.dispose()).resolves.toBeUndefined();
    expect(fault.failures).toBe(1);
    expect(scope.workloads.snapshot()).toMatchObject({ complete: true, scopes: [], pendingLaunches: 0, failedRetirements: 0 });
  });
  it("still refuses cleanup when a positive empty census remains unavailable", async () => {
    const scope = await prepare();
    fault.remaining = -1;
    await expect(scope.dispose()).rejects.toThrow("cloud workload drain is not positively empty");
    expect(fault.failures).toBeGreaterThan(0);
  });
});
