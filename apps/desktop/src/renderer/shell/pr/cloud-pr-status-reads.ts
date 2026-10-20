import type { PR, PrChecksResult } from "../../platform/git";

type Result = [PromiseSettledResult<PR>, PromiseSettledResult<PrChecksResult>];
type Entry = { result: Promise<Result>; pending: boolean; retryAt: number; failures: number };
const unavailable = (): Result => [{ status: "rejected", reason: new Error("PR status unavailable") },
  { status: "rejected", reason: new Error("PR checks unavailable") }];

/** Cloud Git broadcasts report local edits, not new GitHub state. Share only
 * that external observation; the island still refreshes Git status/counts on
 * every generation. No timers or authority are retained here. */
export class CloudPrStatusReads {
  private readonly entries = new Map<string, Entry>();

  read(key: string, load: () => Promise<Result>): Promise<Result> {
    const previous = this.entries.get(key);
    if (previous && (previous.pending || Date.now() < previous.retryAt)) return previous.result;
    if (!previous && this.entries.size >= 64) {
      const oldest = [...this.entries].find(([, entry]) => !entry.pending);
      if (!oldest) return Promise.resolve(unavailable());
      this.entries.delete(oldest[0]);
    }
    const entry: Entry = { result: Promise.resolve(unavailable()), pending: true, retryAt: 0, failures: previous?.failures ?? 0 };
    entry.result = Promise.resolve().then(load).catch(unavailable).then(result => {
      if (this.entries.get(key) !== entry) return unavailable();
      const failed = result.some(value => value.status === "rejected");
      entry.failures = failed ? Math.min(4, entry.failures + 1) : 0;
      entry.retryAt = Date.now() + (failed ? Math.min(300_000, 60_000 * 2 ** (entry.failures - 1)) : 30_000);
      entry.pending = false;
      return result;
    });
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.result;
  }

  /** A successful explicit mutation invalidates the old observation. */
  forget(key: string): void { this.entries.delete(key); }
  forgetWorkspace(workspaceId: string): void {
    for (const key of this.entries.keys()) if (key.startsWith(`${workspaceId}#`)) this.forget(key);
  }
}
