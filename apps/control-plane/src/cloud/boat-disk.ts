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

/** A stop's outcome. `holds`: exactly one snapshot attempt began after the last read before the stop, it completed, and
 * none was reported failed (true); otherwise false; null when the provider does not report its disk. `failed`: an attempt
 * was in progress (or the machine not hydrated) when the wait before the stop gave up, or one was reported failed while
 * the machine archived. */
export type BoatStop = { stoppedAt: Date | null; holds: boolean | null; failed: boolean; attemptAt: Date | null; status: string | null };

/** Reads right after a stop, a little apart: a failed attempt may be reported for well under a second. */
const STOP_FAST_READS = 10, STOP_FAST_INTERVAL_MS = 300;

/** Stops a machine so its archive holds what it was writing: waits (bounded) while it is not hydrated or a snapshot
 * attempt is in progress, stops it, then reads it until it is archived: at once and every 300 ms for the first seconds,
 * then at `archiveIntervalMs`. Attempt times are compared only with each other (the provider's clock, never ours): an
 * attempt that began after the last read before the stop but before the stop itself shows up as a second new attempt,
 * and is not trusted. Throws code provider_stop_incomplete when the machine is never reported archived, as an
 * unconfirmed stop always has. */
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
  const live = before?.state === "running" || before?.state === "idle";
  const since = before?.snapshotAttemptAt?.getTime() ?? null;
  // Gave up waiting: the stop lands on an attempt in progress, or on a machine still being restored.
  let failed = live && (before?.snapshotStatus === "in_progress" || before?.hydrated === false);
  await compute.stop(sandboxId);
  const attempts = new Set<number>();
  const archiveReads = (wait.archiveReads ?? ARCHIVE_READS) + STOP_FAST_READS;
  for (let read = 1; read <= archiveReads; read++) {
    const inspected = await compute.inspect(sandboxId);
    if (inspected.snapshotStatus === "failed") failed = true;
    const attemptAt = inspected.snapshotAttemptAt?.getTime();
    if (attemptAt !== undefined && (since === null || attemptAt > since)) attempts.add(attemptAt);
    if (inspected.state === "archived") {
      const holds = !known(inspected) || !before || !known(before) ? null
        : !failed && attempts.size === 1 && inspected.snapshotStatus === "completed" && attemptAt !== undefined && attempts.has(attemptAt);
      return { stoppedAt: inspected.stoppedAt ?? null, holds, failed, attemptAt: inspected.snapshotAttemptAt ?? null, status: inspected.snapshotStatus ?? null };
    }
    if (inspected.state !== "archiving") break;
    if (read < archiveReads) await wait.sleep(read <= STOP_FAST_READS ? STOP_FAST_INTERVAL_MS : wait.archiveIntervalMs ?? ARCHIVE_INTERVAL_MS);
  }
  throw Object.assign(new Error("Boat has not stopped the VM"), { code: "provider_stop_incomplete" });
}
