import type { ProcessMetricsSnapshot } from "../src/renderer/platform/process-metrics-types";
import type { SampledProcessRow } from "./process-metrics";

/** App logs already have bounded disk/tail retention. Split complete process
 * records below their per-line cap instead of truncating a busy process tree.
 * Never include argv, environment values, page titles or workspace names. */
export function processResourceHistory(
  snapshot: ProcessMetricsSnapshot,
  rows: readonly SampledProcessRow[],
  reason: "periodic" | "copy",
): string[] {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const processes = snapshot.processes.map(process => {
    const row = byPid.get(process.pid);
    return {
      pid: process.pid, parentPid: row?.parentPid ?? process.parentPid,
      identity: process.id, startedAt: row?.startKey ?? null,
      name: process.name, kind: process.kind,
      cpuPercent: snapshot.cpuReady && process.cpuSampled !== false ? process.cpuPercent : null,
      cpuTimeSeconds: row?.cpuTimeSeconds ?? null,
      memoryBytes: process.memoryBytes,
      memorySource: process.memorySource ?? snapshot.memorySource,
      residentBytes: row?.rssBytes ?? null,
    };
  });
  const metadata = { schema: "zeros.resources/v1", sampledAt: snapshot.sampledAt, reason };
  const unknownCpu = processes.filter(row => row.cpuPercent == null).length;
  const lines = [JSON.stringify({ ...metadata, type: "summary", scope: "app-and-descendants",
    samplingIntervalMs: snapshot.samplingIntervalMs, scanDurationMs: snapshot.scanDurationMs,
    processCount: processes.length, cpuPercent: unknownCpu ? null : snapshot.totals.all.cpuPercent,
    observedCpuPercent: snapshot.totals.all.cpuPercent, unknownCpuProcesses: unknownCpu,
    memoryBytes: snapshot.totals.all.memoryBytes,
    footprintProcesses: processes.filter(row => row.memorySource === "footprint").length,
    system: snapshot.system,
  })];
  let chunk: typeof processes = [];
  const serialize = () => JSON.stringify({ ...metadata, type: "processes", processes: chunk });
  for (const process of processes) {
    chunk.push(process);
    if (serialize().length > 8_000 && chunk.length > 1) {
      chunk.pop(); lines.push(serialize()); chunk = [process];
    }
  }
  if (chunk.length) lines.push(serialize());
  return lines.map(line => `[Zeros resources] ${line}`);
}
