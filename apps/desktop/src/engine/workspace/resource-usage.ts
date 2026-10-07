import { open, statfs } from "node:fs/promises";
import {
  WorkspaceResourceUsageSchema,
  type WorkspaceResourceUsage,
  type WorkspaceResourceUsageIdentity,
} from "@zeros/protocol/workspace-resource-usage";

const MAX_PROC_BYTES = 64 * 1024;
type Volume = { blocks: bigint; bavail: bigint; bsize: bigint };
type Dependencies = {
  read: (path: string, maxBytes: number) => Promise<string>;
  statfs: (path: string) => Promise<Volume>;
  now: () => number;
};
const unknownCapacity = () => ({ totalBytes: null, availableBytes: null, usedBytes: null, usedPercent: null });

async function readBounded(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error("Resource observation exceeded its bound");
    return buffer.toString("utf8", 0, offset);
  } finally { await file.close(); }
}

function cpuCounters(source: string): { counters: bigint[]; cores: number } | null {
  if (Buffer.byteLength(source) > MAX_PROC_BYTES) return null;
  const match = /^cpu\s+([^\n]+)$/m.exec(source);
  const fields = match?.[1].trim().split(/\s+/);
  const cores = source.split("\n").filter(line => /^cpu\d+\s/.test(line)).length;
  if (!fields || fields.length < 4 || fields.length > 10 || !cores || cores > 4096 ||
      fields.some(field => !/^\d{1,20}$/.test(field))) return null;
  // Guest/guest_nice are already included in user/nice; count the first eight
  // counters only. Keep the counters individually to detect a reset of any one.
  return { counters: Array.from({ length: 8 }, (_, index) => BigInt(fields[index] ?? "0")), cores };
}
function capacity(total: bigint, available: bigint) {
  if (total <= 0n || available < 0n || available > total || total > BigInt(Number.MAX_SAFE_INTEGER))
    return unknownCapacity();
  const totalBytes = Number(total), availableBytes = Number(available);
  const usedBytes = totalBytes - availableBytes;
  return { totalBytes, availableBytes, usedBytes, usedPercent: usedBytes / totalBytes * 100 };
}
function memoryCapacity(source: string) {
  if (Buffer.byteLength(source) > MAX_PROC_BYTES) return unknownCapacity();
  const total = /^MemTotal:\s+(\d{1,20})\s+kB\s*$/m.exec(source);
  const available = /^MemAvailable:\s+(\d{1,20})\s+kB\s*$/m.exec(source);
  return total && available ? capacity(BigInt(total[1]) * 1024n, BigInt(available[1]) * 1024n) : unknownCapacity();
}

/** One fixed sampler per service, serialized without a permanent timer. Only
 * the admitted service chooses the checkout; callers cannot supply host paths. */
export class WorkspaceResourceUsageSampler {
  private previous: { identity: string; counters: bigint[]; cores: number } | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly dependencies: Dependencies = {
    read: readBounded, statfs: path => statfs(path, { bigint: true }), now: Date.now,
  }) {}

  sample(identity: WorkspaceResourceUsageIdentity, checkout: string): Promise<WorkspaceResourceUsage> {
    const sample = this.pending.then(() => this.observe(identity, checkout));
    this.pending = sample.catch(() => {});
    return sample;
  }

  private async observe(identity: WorkspaceResourceUsageIdentity, checkout: string): Promise<WorkspaceResourceUsage> {
    const [cpu, memory, disk] = await Promise.allSettled([
      this.dependencies.read("/proc/stat", MAX_PROC_BYTES),
      this.dependencies.read("/proc/meminfo", MAX_PROC_BYTES),
      this.dependencies.statfs(checkout),
    ]);
    const current = cpu.status === "fulfilled" ? cpuCounters(cpu.value) : null;
    const key = JSON.stringify(identity);
    const old = this.previous;
    let usedPercent: number | null = null;
    if (current && old?.identity === key && old.cores === current.cores &&
        current.counters.every((count, index) => count >= old.counters[index])) {
      const deltas = current.counters.map((count, index) => count - old.counters[index]);
      const total = deltas.reduce((sum, count) => sum + count, 0n);
      const idle = deltas[3] + deltas[4];
      if (total > 0n && total <= BigInt(Number.MAX_SAFE_INTEGER))
        usedPercent = Number(total - idle) / Number(total) * 100;
    }
    this.previous = current ? { identity: key, ...current } : null;
    const volume = disk.status === "fulfilled" ? disk.value : null;
    return WorkspaceResourceUsageSchema.parse({
      version: 1, ...identity, sampledAt: new Date(this.dependencies.now()).toISOString(),
      cpu: { cores: current?.cores ?? null, usedPercent },
      memory: memory.status === "fulfilled" ? memoryCapacity(memory.value) : unknownCapacity(),
      disk: volume && volume.bsize > 0n ? capacity(volume.blocks * volume.bsize, volume.bavail * volume.bsize) : unknownCapacity(),
    });
  }
}
