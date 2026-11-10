import { readFile, statfs as fsStatfs } from "node:fs/promises";
import { availableParallelism } from "node:os";
import type { CloudWorkspaceResources } from "@zeros/protocol/cloud-v2-relay";

const CPU_WINDOW_MS = 250;
/** Several desktops can open the details popup together; they share a sample. */
const REUSE_MS = 1_000;

interface SamplerOptions {
  read?(path: string): Promise<string>;
  statfs?(path: string): Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }>;
  cores?(): number;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}
const percent = (used: number, total: number) => total > 0 ? Math.min(100, Math.max(0, Math.round(used / total * 1000) / 10)) : 0;
function cpuTimes(stat: string): { idle: number; total: number } {
  const fields = (/^cpu\s+(.+)$/m.exec(stat)?.[1] ?? "").trim().split(/\s+/).map(Number).filter(Number.isFinite);
  // user nice system idle iowait irq softirq steal; guest time is already in user.
  const counted = fields.slice(0, 8);
  return { idle: (counted[3] ?? 0) + (counted[4] ?? 0), total: counted.reduce((sum, value) => sum + value, 0) };
}
const kilobytes = (meminfo: string, name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, "m").exec(meminfo)?.[1] ?? 0) * 1024;

/** Sampled only when asked (`workspace.resources`); nothing here polls. */
export class ResourceSampler {
  private flight?: Promise<CloudWorkspaceResources>;
  private last?: CloudWorkspaceResources;
  constructor(private readonly root: string, private readonly options: SamplerOptions = {}) {}

  sample(): Promise<CloudWorkspaceResources> {
    const now = this.options.now ?? Date.now;
    if (this.last && now() - this.last.sampledAt < REUSE_MS) return Promise.resolve(this.last);
    this.flight ??= this.measure().then(sample => { this.last = sample; return sample; }).finally(() => { this.flight = undefined; });
    return this.flight;
  }

  private async measure(): Promise<CloudWorkspaceResources> {
    const read = this.options.read ?? (path => readFile(path, "utf8"));
    const sleep = this.options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const [before, meminfo, disk] = await Promise.all([read("/proc/stat"), read("/proc/meminfo"), (this.options.statfs ?? fsStatfs)(this.root)]);
    await sleep(CPU_WINDOW_MS);
    const after = cpuTimes(await read("/proc/stat")), start = cpuTimes(before);
    const total = after.total - start.total, idle = after.idle - start.idle;
    const memoryTotal = kilobytes(meminfo, "MemTotal"), available = kilobytes(meminfo, "MemAvailable");
    const used = (disk.blocks - disk.bfree) * disk.bsize, free = disk.bavail * disk.bsize;
    return {
      cpu: { cores: Math.max(1, (this.options.cores ?? availableParallelism)()), usedPercent: percent(total - idle, total) },
      memory: { totalBytes: memoryTotal, usedPercent: percent(memoryTotal - available, memoryTotal) },
      disk: { totalBytes: disk.blocks * disk.bsize, usedPercent: percent(used, used + free) },
      sampledAt: (this.options.now ?? Date.now)(),
    };
  }
}
