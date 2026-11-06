import type { PR, PrChecksResult } from "../../platform/git";

type Result = [PromiseSettledResult<PR>, PromiseSettledResult<PrChecksResult>];
type Read = { refsVersion: number; load: () => Promise<Result> };
type Entry = { result: Promise<Result>; pending: boolean; retryAt: number; failures: number; refsVersion: number; next?: Read };
const unavailable = (): Result => [{ status: "rejected", reason: new Error("PR status unavailable") },
  { status: "rejected", reason: new Error("PR checks unavailable") }];

/** Ordinary cloud file broadcasts cannot bypass the GitHub observation window;
 * acknowledged ref hints can. Git status/counts remain fresh on every generation. */
export class CloudPrStatusReads {
  private readonly entries = new Map<string, Entry>();

  read(key: string, load: () => Promise<Result>, refsVersion = 0): Promise<Result> {
    const previous = this.entries.get(key);
    if (previous?.pending) {
      if (refsVersion > previous.refsVersion && refsVersion > (previous.next?.refsVersion ?? -1)) previous.next = { refsVersion, load };
      return previous.result;
    }
    if (previous && Date.now() < previous.retryAt && (previous.failures > 0 || previous.refsVersion === refsVersion)) return previous.result;
    if (!previous && this.entries.size >= 64) {
      const oldest = [...this.entries].find(([, entry]) => !entry.pending);
      if (!oldest) return Promise.resolve(unavailable());
      this.entries.delete(oldest[0]);
    }
    const entry: Entry = { result: Promise.resolve(unavailable()), pending: true, retryAt: 0, failures: previous?.failures ?? 0, refsVersion };
    entry.result = Promise.resolve().then(async () => {
      let read = load;
      for (;;) {
        let result: Result;
        try { result = await read(); } catch { result = unavailable(); }
        if (this.entries.get(key) !== entry) return unavailable();
        if (entry.next) {
          ({ load: read, refsVersion: entry.refsVersion } = entry.next);
          entry.next = undefined;
          continue;
        }
        const failed = result.some(value => value.status === "rejected");
        entry.failures = failed ? Math.min(4, entry.failures + 1) : 0;
        entry.retryAt = Date.now() + (failed ? Math.min(300_000, 60_000 * 2 ** (entry.failures - 1)) : 30_000);
        entry.pending = false;
        return result;
      }
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
