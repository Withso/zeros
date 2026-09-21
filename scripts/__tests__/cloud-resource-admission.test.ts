import { describe, expect, it } from "vitest";
// @ts-expect-error Image-owned JavaScript is also exercised without root privileges.
import {
  cloudResourcesMeetContract,
  validCloudResourceContract,
  cloudImageReferenceMatchesBuild,
  cloudAllocationCapacity,
} from "../cloud-workspace-validation/sandbox/cloud-resource-admission.mjs";
const MIB = 1024 * 1024;
const contract = {
  architecture: "linux/amd64",
  cpuMillicores: 4000,
  memoryMiB: 8192,
  storageMiB: 40960,
};
const measured = {
  finite: true,
  cpuMax: "400000 100000",
  memoryMax: String(7168 * MIB),
  allocation: {
    architecture: "linux/amd64",
    cpuMillicores: 4000,
    memoryBytes: 8000 * MIB,
    storageBytes: 40000 * MIB,
  },
};
describe("cloud generation resource admission", () => {
  it("measures the engine placement without confusing a bootstrap-command quota with VM capacity", () => {
    const files: Record<string, string> = {
      "/proc/meminfo": "MemTotal:        8131788 kB\n",
      "/sys/fs/cgroup/user.slice/memory.max": String(6750 * MIB),
      "/sys/fs/cgroup/user.slice/cpu.max": "200000 100000",
      "/sys/fs/cgroup/memory.max": "max",
      "/sys/fs/cgroup/cpu.max": "max 100000",
    };
    const input = {
      isolated: true,
      membership: "0::/user.slice\n",
      read: (file: string) => files[file] ?? null,
      architecture: "x64",
      availableCPUs: 4,
      storageBytes: 40000 * MIB,
    };
    expect(cloudAllocationCapacity(input)).toMatchObject({
      cpuMillicores: 4000,
      memoryBytes: 8131788 * 1024,
    });
    expect(
      cloudAllocationCapacity({ ...input, isolated: false }),
    ).toMatchObject({ cpuMillicores: 2000, memoryBytes: 6750 * MIB });
    // A container provider's root still constrains every child engine scope.
    files["/sys/fs/cgroup/memory.max"] = String(4096 * MIB);
    files["/sys/fs/cgroup/cpu.max"] = "200000 100000";
    expect(cloudAllocationCapacity(input)).toMatchObject({
      cpuMillicores: 2000,
      memoryBytes: 4096 * MIB,
    });
  });
  it("binds Boat's mutable snapshot name to the qualified build digest", () => {
    const digest = "a".repeat(64);
    expect(
      cloudImageReferenceMatchesBuild(
        `boat:qualified-image@sha256:${digest}`,
        digest,
      ),
    ).toBe(true);
    expect(
      cloudImageReferenceMatchesBuild(
        `boat:qualified-image@sha256:${digest}`,
        "b".repeat(64),
      ),
    ).toBe(false);
    expect(cloudImageReferenceMatchesBuild("boat:mutable-name", digest)).toBe(
      false,
    );
    expect(
      cloudImageReferenceMatchesBuild("existing-daytona-snapshot", digest),
    ).toBe(true);
  });
  it("accounts for kernel/filesystem overhead and the bounded VM-service reserve", () => {
    expect(cloudResourcesMeetContract(contract, measured)).toBe(true);
    expect(
      cloudResourcesMeetContract(
        {
          ...contract,
          cpuMillicores: 2000,
          memoryMiB: 4096,
          storageMiB: 10240,
        },
        {
          finite: true,
          cpuMax: "200000 100000",
          memoryMax: String(4096 * MIB),
          allocation: {
            ...measured.allocation,
            memoryBytes: 4096 * MIB,
            storageBytes: 10240 * MIB,
          },
        },
      ),
    ).toBe(true);
  });
  it("rejects undercapacity, wrong architecture and unenforced tenant bounds", () => {
    for (const allocation of [
      { cpuMillicores: 2000 },
      { memoryBytes: 7000 * MIB },
      { storageBytes: 20480 * MIB },
      { architecture: "linux/arm64" },
      { memoryBytes: Infinity },
      { storageBytes: 0 },
    ])
      expect(
        cloudResourcesMeetContract(contract, {
          ...measured,
          allocation: { ...measured.allocation, ...allocation },
        }),
      ).toBe(false);
    for (const change of [
      { finite: false },
      { cpuMax: "200000 100000" },
      { cpuMax: "800000 100000" },
      { cpuMax: "max 100000" },
      { memoryMax: "max" },
      { memoryMax: String(8193 * MIB) },
      { memoryMax: String(7167 * MIB) },
      { memoryMax: "9007199254740992" },
    ])
      expect(
        cloudResourcesMeetContract(contract, { ...measured, ...change }),
      ).toBe(false);
  });
  it("never guesses missing or malformed requested resources", () => {
    for (const invalid of [
      undefined,
      null,
      {},
      { ...contract, cpuMillicores: 1.5 },
      { ...contract, storageMiB: 0 },
      { ...contract, architecture: "linux/riscv64" },
      { ...contract, unbounded: true },
    ]) {
      expect(validCloudResourceContract(invalid)).toBe(false);
      expect(cloudResourcesMeetContract(invalid, measured)).toBe(false);
    }
  });
});
