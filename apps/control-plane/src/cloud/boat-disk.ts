// What the provider says of a machine's disk, and the two questions every place that stops or forks right after writing
// asks: "has this machine's restore settled" and "are its writes in the archive its stop made".
//
// Observed: the provider can report a failed snapshot attempt when a machine is stopped while one is in progress, most
// clearly seconds after the machine starts, before it reports hydrated; a fork of that machine then lacked the files
// written just before. So a stop waits until the machine is hydrated with no attempt in progress, and a failed attempt
// reported during the stop is never called a good archive (ready-copies and retention integration tests).
import type { BoatInspection, CloudV2Compute } from "./boat.js";

/** How long to wait, and how to sleep. Reads are Boat inspect calls. */
export type BoatDiskWait = { sleep(ms: number): Promise<void>; reads?: number; intervalMs?: number };
const SETTLE_READS = 30, SETTLE_INTERVAL_MS = 1_000;
const ARCHIVE_READS = 30, ARCHIVE_INTERVAL_MS = 2_000;

/** Whether Boat said anything of this machine's disk. */
const known = (inspected: BoatInspection) => inspected.hydrated !== undefined && inspected.snapshotStatus !== undefined;

/** Waits (bounded) until Boat reports the machine hydrated with no snapshot attempt in progress. "unknown" when Boat
 * does not report its disk; "timeout" when it never settled within the wait. */
export async function diskSettled(compute: Pick<CloudV2Compute, "inspect">, sandboxId: string, wait: BoatDiskWait): Promise<"settled" | "timeout" | "unknown"> {
  const reads = wait.reads ?? SETTLE_READS;
  for (let read = 1; read <= reads; read++) {
    const inspected = await compute.inspect(sandboxId);
    if (!known(inspected)) return "unknown";
    if (inspected.hydrated && inspected.snapshotStatus !== "in_progress") return "settled";
    if (read < reads) await wait.sleep(wait.intervalMs ?? SETTLE_INTERVAL_MS);
  }
  return "timeout";
}

/** A stop's outcome. `holds`: Boat completed a snapshot attempt that began after the stop was asked for, and reported
 * no failed one during it (true); it reported a failed one, or none completed (false); or it does not report its disk
 * (null). `failed`: Boat reported a failed attempt while the machine was archiving. */
export type BoatStop = { stoppedAt: Date | null; holds: boolean | null; failed: boolean; attemptAt: Date | null; status: string | null };

/** Stops a machine so its archive holds what it was writing: waits (bounded) while it is not hydrated or a snapshot
 * attempt is in progress, stops it, then reads it until it is archived, watching for an attempt that failed. Throws code
 * provider_stop_incomplete when Boat never reports it archived, as an unconfirmed stop always has. */
export async function stopKeepingWrites(compute: Pick<CloudV2Compute, "inspect" | "stop">, sandboxId: string, wait: BoatDiskWait & { archiveReads?: number;
  archiveIntervalMs?: number }): Promise<BoatStop> {
  // Before the stop: hydrated, with no attempt in progress, so the stop's own attempt is the one that saves the disk.
  let before: BoatInspection | null = null;
  const reads = wait.reads ?? SETTLE_READS;
  for (let read = 1; read <= reads; read++) {
    before = await compute.inspect(sandboxId);
    if (before.state !== "running" && before.state !== "idle") break;
    if (before.snapshotStatus !== "in_progress" && before.hydrated !== false) break;
    if (read < reads) await wait.sleep(wait.intervalMs ?? SETTLE_INTERVAL_MS);
  }
  const since = before?.snapshotAttemptAt?.getTime() ?? null;
  await compute.stop(sandboxId);
  let failed = before?.snapshotStatus === "in_progress";
  const archiveReads = wait.archiveReads ?? ARCHIVE_READS;
  for (let read = 1; read <= archiveReads; read++) {
    const inspected = await compute.inspect(sandboxId);
    if (inspected.snapshotStatus === "failed") failed = true;
    if (inspected.state === "archived") {
      const attemptAt = inspected.snapshotAttemptAt ?? null;
      const holds = !known(inspected) || !before || !known(before) ? null
        : !failed && inspected.snapshotStatus === "completed" && attemptAt !== null && (since === null || attemptAt.getTime() > since);
      return { stoppedAt: inspected.stoppedAt ?? null, holds, failed, attemptAt, status: inspected.snapshotStatus ?? null };
    }
    if (inspected.state !== "archiving") break;
    if (read < archiveReads) await wait.sleep(wait.archiveIntervalMs ?? ARCHIVE_INTERVAL_MS);
  }
  throw Object.assign(new Error("Boat has not stopped the VM"), { code: "provider_stop_incomplete" });
}
