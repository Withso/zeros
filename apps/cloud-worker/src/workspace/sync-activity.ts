import { SYNC_LIMITS } from "@zeros/protocol/workspace-sync";

/** CONTRACT.md 12 (2026-11-11 amendment): a sync that is moving bytes keeps the
 * VM awake through the worker's ordinary busy report, for SYNC_LIMITS.
 * transferActivityMs after its last read and at most transferActivityCapMs of
 * one continuous run per Mac (device id, across its sockets, so reconnects
 * do not restart it). An in-sync mirror (snapshots, hints) never counts, so a
 * mirrored workspace still idle-stops. */
export class SyncTransferActivity {
  private readonly runs = new Map<string, { started: number; last: number }>();

  transferred(device: string, now: number): void {
    const run = this.runs.get(device);
    // A pause longer than the window ends the continuous run.
    if (!run || now - run.last > SYNC_LIMITS.transferActivityMs) this.runs.set(device, { started: now, last: now });
    else run.last = now;
    // Old runs expire by time; the map stays small (four sync sockets at most).
    for (const [key, value] of this.runs) if (now - value.last > SYNC_LIMITS.transferActivityCapMs) this.runs.delete(key);
  }
  active(now: number): boolean {
    for (const { started, last } of this.runs.values())
      if (now - last <= SYNC_LIMITS.transferActivityMs && last - started < SYNC_LIMITS.transferActivityCapMs) return true;
    return false;
  }
}
