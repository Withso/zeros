import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareClaudeCloudWorkload } from "../adapters/claude-sdk/__tests__/helpers/legacy-execution";

const fault = vi.hoisted(() => ({ remaining: 0, failures: 0 }));
vi.mock("../containment/cloud-workload-cgroup.mjs", async original => {
  const actual = await original<typeof import("../containment/cloud-workload-cgroup.mjs")>();
  return { ...actual, nativeCloudWorkloadIO: Object.freeze({ ...actual.nativeCloudWorkloadIO,
    process(pid: number) {
      if (pid !== process.pid && fault.remaining !== 0) {
        if (fault.remaining > 0) fault.remaining--;
        fault.failures++;
        throw new Error("Synthetic foreign proc observation is unavailable");
      }
      return actual.nativeCloudWorkloadIO.process(pid);
    },
  }) };
});

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
    executionId: randomUUID(), conversationId: "census-cleanup", provider: "claude" });
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
