import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { CloudWorkspaceResourcesSchema } from "@zeros/protocol/cloud-v2-relay";
import { ResourceSampler } from "./sampler";

const meminfo = "MemTotal:        8000000 kB\nMemFree:  1000000 kB\nMemAvailable:    2000000 kB\n";
function fixture() {
  const stats = ["cpu  100 0 100 700 100 0 0 0 0 0\n", "cpu  160 0 140 780 120 0 0 0 0 0\n"];
  const read = vi.fn(async (path: string) => path === "/proc/meminfo" ? meminfo : stats.shift() ?? stats[0] ?? "");
  const statfs = vi.fn(async () => ({ bsize: 4096, blocks: 1000, bfree: 400, bavail: 300 }));
  let clock = 10_000;
  const sampler = new ResourceSampler("/checkout", { read, statfs, cores: () => 4, sleep: async () => { clock += 250; }, now: () => clock });
  return { sampler, read, statfs, advance: (ms: number) => { clock += ms; } };
}

describe("workspace resources", () => {
  it("measures CPU over a short window, memory from MemAvailable and the checkout's file system", async () => {
    const f = fixture();
    expect(await f.sampler.sample()).toEqual({
      cpu: { cores: 4, usedPercent: 50 },
      memory: { totalBytes: 8_000_000 * 1024, usedPercent: 75 },
      disk: { totalBytes: 4096 * 1000, usedPercent: 66.7 },
      sampledAt: 10_250,
    });
    expect(f.statfs).toHaveBeenCalledWith("/checkout");
  });

  it("shares one sample between concurrent askers and briefly afterwards, and reads nothing unless asked", async () => {
    const f = fixture();
    expect(f.read).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([f.sampler.sample(), f.sampler.sample()]);
    expect(a).toBe(b);
    expect(await f.sampler.sample()).toBe(a);
    expect(f.read).toHaveBeenCalledTimes(3);
    f.advance(1_000);
    await f.sampler.sample();
    expect(f.read.mock.calls.length).toBeGreaterThan(3);
  });

  it.skipIf(process.platform !== "linux")("produces a schema-valid sample from the real machine", async () => {
    expect(CloudWorkspaceResourcesSchema.safeParse(await new ResourceSampler(tmpdir()).sample()).success).toBe(true);
  });
});
