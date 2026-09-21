import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ type: 0x65735546, uid: 0, mode: 0o100644, size: 32768, source: "65534\n" }));
vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(),
  openSync: vi.fn(() => 123), closeSync: vi.fn(),
  fstatSync: vi.fn(() => ({ ...fixture, nlink: 1, isFile: () => true })),
  statfsSync: vi.fn(() => ({ type: fixture.type })),
  readSync: vi.fn((_fd: number, buffer: Buffer, offset: number, length: number) =>
    Buffer.from(fixture.source).copy(buffer, offset, offset, offset + length)),
}));
import { readCloudEngineKernelParameter } from "../cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs";

describe("fixed cloud kernel parameter reads", () => {
  beforeEach(() => Object.assign(fixture, { type: 0x65735546, uid: 0, mode: 0o100644, size: 32768, source: "65534\n" }));
  it("reads a provider-virtualized root-owned sysctl with a synthetic stat size", () => {
    expect(readCloudEngineKernelParameter("/proc/sys/kernel/overflowuid", 32).toString()).toBe("65534\n");
  });
  it("bounds actual bytes and rejects worker-writable or foreign filesystems", () => {
    fixture.source = "x".repeat(33);
    expect(() => readCloudEngineKernelParameter("/proc/sys/kernel/overflowuid", 32)).toThrow(/too large/);
    fixture.source = "65534\n"; fixture.uid = 10001;
    expect(() => readCloudEngineKernelParameter("/proc/sys/kernel/overflowuid", 32)).toThrow();
    fixture.uid = 0; fixture.mode = 0o100666;
    expect(() => readCloudEngineKernelParameter("/proc/sys/kernel/overflowuid", 32)).toThrow();
    fixture.mode = 0o100644; fixture.type = 0x794c7630;
    expect(() => readCloudEngineKernelParameter("/proc/sys/kernel/overflowuid", 32)).toThrow();
  });
  it("requires real procfs for process identity and refuses arbitrary paths", () => {
    fixture.source = "0 951968 65536\n";
    expect(() => readCloudEngineKernelParameter("/proc/self/uid_map", 4096)).toThrow();
    fixture.type = 0x9fa0; fixture.uid = 65534;
    expect(readCloudEngineKernelParameter("/proc/self/uid_map", 4096).toString()).toBe(fixture.source);
    expect(() => readCloudEngineKernelParameter("/tmp/kernel", 4096)).toThrow();
  });
});
