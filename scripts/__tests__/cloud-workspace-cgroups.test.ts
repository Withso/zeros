import { describe, expect, it } from "vitest";
import { effectiveCloudResourceLimits } from "../cloud-workspace-validation/sandbox/cgroup-resources.mjs";

function files(values: Record<string, string>) {
  return (file: string) => values[file] ?? null;
}

describe("cloud cgroup v2 effective limits", () => {
  it("accounts for finite ancestor limits when the process scope says max", () => {
    const result = effectiveCloudResourceLimits(
      "0::/init.scope\n",
      files({
        "/sys/fs/cgroup/init.scope/memory.max": "max",
        "/sys/fs/cgroup/init.scope/cpu.max": "max 100000",
        "/sys/fs/cgroup/init.scope/pids.max": "max",
        "/sys/fs/cgroup/memory.max": "4294967296",
        "/sys/fs/cgroup/cpu.max": "200000 100000",
        "/sys/fs/cgroup/pids.max": "2048",
      }),
    );
    expect(result).toMatchObject({
      finite: true,
      memoryMax: "4294967296",
      cpuMax: "200000 100000",
      pidsMax: "2048",
    });
  });

  it("takes the tightest independent bound including unequal CPU periods", () => {
    const result = effectiveCloudResourceLimits(
      "0::/parent/worker\n",
      files({
        "/sys/fs/cgroup/parent/worker/memory.max": "9223372036854775807",
        "/sys/fs/cgroup/parent/worker/cpu.max": "150000 50000",
        "/sys/fs/cgroup/parent/worker/pids.max": "128",
        "/sys/fs/cgroup/parent/memory.max": "4294967296",
        "/sys/fs/cgroup/parent/cpu.max": "200000 100000",
        "/sys/fs/cgroup/parent/pids.max": "1024",
      }),
    );
    expect(result).toMatchObject({
      finite: true,
      memoryMax: "4294967296",
      cpuMax: "200000 100000",
      pidsMax: "128",
    });
  });

  it("does not invent a limit on an unrestricted VM", () => {
    expect(effectiveCloudResourceLimits("0::/\n", files({}))).toMatchObject({
      finite: false,
      memoryMax: null,
      cpuMax: null,
      pidsMax: null,
    });
  });

  it("rejects malformed kernel paths and limit values instead of normalizing them", () => {
    for (const membership of [
      "",
      "1:memory:/\n",
      "0::/../outside",
      "0::/a/../../outside",
      "0::relative",
      "0::/a\n0::/b",
    ]) {
      expect(() =>
        effectiveCloudResourceLimits(membership, files({})),
      ).toThrow();
    }
    for (const value of [
      "0",
      "-1",
      "NaN",
      "1.2",
      "1e12",
      "99999999999999999999999999",
    ]) {
      expect(() =>
        effectiveCloudResourceLimits(
          "0::/",
          files({ "/sys/fs/cgroup/memory.max": value }),
        ),
      ).toThrow();
    }
    for (const value of ["0 100000", "100000 0", "max", "1 2 3"]) {
      expect(() =>
        effectiveCloudResourceLimits(
          "0::/",
          files({ "/sys/fs/cgroup/cpu.max": value }),
        ),
      ).toThrow();
    }
  });
});
