import { SYNC_LIMITS } from "@zeros/protocol/workspace-sync";

/** CONTRACT.md 12 (2026-11-11 amendment): a sync that is moving bytes keeps the
 * VM awake through the worker's ordinary busy report, for SYNC_LIMITS.
 * transferActivityMs after its last read and at most transferActivityCapMs of
 * one continuous run per sync socket. An in-sync mirror (snapshots, hints)
 * never counts, so a mirrored workspace still idle-stops. */
export class SyncTransferActivity {
  private readonly runs = new Map<string, { started: number; last: number }>();

  transferred(clientId: string, now: number): void {
    const run = this.runs.get(clientId);
    // A pause longer than the window ends the continuous run.
    if (!run || now - run.last > SYNC_LIMITS.transferActivityMs) this.runs.set(clientId, { started: now, last: now });
    else run.last = now;
  }
  ended(clientId: string): void { this.runs.delete(clientId); }
  active(now: number): boolean {
    for (const { started, last } of this.runs.values())
      if (now - last <= SYNC_LIMITS.transferActivityMs && last - started < SYNC_LIMITS.transferActivityCapMs) return true;
    return false;
  }
}
