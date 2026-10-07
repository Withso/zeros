import { describe, expect, it, vi } from "vitest";
import { WorkspaceResourceUsageSampler } from "../resource-usage";

const identity = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  generation: 7, engineInstanceId: "33333333-3333-4333-8333-333333333333",
};
function fixtures() {
  let stat = "cpu 100 0 50 850 0 0 0 0 0 0\ncpu0 0\ncpu1 0\n";
  let memory = "MemTotal: 1000 kB\nMemAvailable: 400 kB\n";
  const read = vi.fn(async (file: string, maxBytes: number) => {
    expect(maxBytes).toBe(64 * 1024);
    return file === "/proc/stat" ? stat : memory;
  });
  const disk = vi.fn(async () => ({ blocks: 1000n, bavail: 200n, bsize: 4096n }));
  const sampler = new WorkspaceResourceUsageSampler({ read, statfs: disk, now: () => Date.parse("2026-10-07T10:00:00Z") });
  return { sampler, read, disk, stat: (next: string) => { stat = next; }, memory: (next: string) => { memory = next; } };
}
describe("cloud VM resource observations", () => {
  it("uses successive aggregate CPU counters, available memory and the admitted volume", async () => {
    const f = fixtures();
    const first = await f.sampler.sample(identity, "/admitted/checkout");
    expect(first.cpu).toEqual({ cores: 2, usedPercent: null });
    expect(first.memory).toEqual({ totalBytes: 1024000, availableBytes: 409600, usedBytes: 614400, usedPercent: 60 });
    expect(first.disk).toEqual({ totalBytes: 4096000, availableBytes: 819200, usedBytes: 3276800, usedPercent: 80 });
    f.stat("cpu 130 0 70 900 0 0 0 0 20 0\ncpu0 0\ncpu1 0\n");
    expect((await f.sampler.sample(identity, "/admitted/checkout")).cpu.usedPercent).toBe(50);
    expect(f.read.mock.calls.map(([file]) => file)).toEqual(["/proc/stat", "/proc/meminfo", "/proc/stat", "/proc/meminfo"]);
    expect(f.disk).toHaveBeenCalledWith("/admitted/checkout");
  });
  it("makes reset, zero delta, unavailable and changed engine CPU samples unknown", async () => {
    const f = fixtures(); await f.sampler.sample(identity, "/admitted");
    expect((await f.sampler.sample(identity, "/admitted")).cpu.usedPercent).toBeNull();
    f.stat("cpu 10 0 5 85 0 0 0 0\ncpu0 0\n");
    expect((await f.sampler.sample(identity, "/admitted")).cpu.usedPercent).toBeNull();
    f.stat("cpu broken\n");
    expect((await f.sampler.sample(identity, "/admitted")).cpu).toEqual({ cores: null, usedPercent: null });
    f.stat("cpu 10 0 5 90 0 0 0 0\ncpu0 0\n");
    expect((await f.sampler.sample(identity, "/admitted")).cpu.usedPercent).toBeNull();
    expect((await f.sampler.sample({ ...identity, generation: 8 }, "/admitted")).cpu.usedPercent).toBeNull();
  });
  it("fails observations closed on overflow, invalid availability and filesystem failures", async () => {
    const f = fixtures();
    f.memory("MemTotal: 1000 kB\nMemAvailable: 2000 kB\n");
    f.disk.mockRejectedValueOnce(new Error("unavailable"));
    const sample = await f.sampler.sample(identity, "/admitted");
    expect(sample.memory.usedPercent).toBeNull(); expect(sample.disk.totalBytes).toBeNull();
    f.stat("cpu 1 2 3 4\n" + "x".repeat(64 * 1024));
    f.disk.mockResolvedValue({ blocks: 0n, bavail: 0n, bsize: 4096n });
    expect((await f.sampler.sample(identity, "/admitted")).cpu.usedPercent).toBeNull();
    expect((await f.sampler.sample(identity, "/admitted")).disk.usedPercent).toBeNull();
  });
});
