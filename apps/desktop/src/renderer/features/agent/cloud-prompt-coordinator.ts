import { CloudPromptChannel, promptOwnerKey, type CloudPromptApi, type CloudPromptJournal, type CloudPromptOwner,
  type PromptJournalRecord } from "./cloud-prompt-channel";

type Waiter = { resolve(): void; reject(error: Error): void };
type Job = { waiters: Waiter[]; channel: CloudPromptChannel; current(): boolean; retired: boolean; running: boolean; refreshing: boolean; committing: boolean; due: number; recover: boolean; requested: boolean };

/** One bounded scheduler for explicit durable work, shared by every chat view.
 * It never opens a bridge or wakes a VM. Idle conversations have no timer. */
export class CloudPromptCoordinator {
  private readonly jobs = new Map<string, Job>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private inFlight = 0;
  constructor(readonly journal: CloudPromptJournal, private readonly idle: () => void = () => {}) {}
  owns(channel: CloudPromptChannel): boolean {
    const job = this.jobs.get(promptOwnerKey(channel.owner));
    return job?.channel === channel && job.current();
  }
  private retire(job: Job): void {
    job.retired = true;
    for (const waiter of job.waiters.splice(0)) waiter.reject(new Error("The cloud account or owner changed."));
  }
  channel(owner: CloudPromptOwner, api: CloudPromptApi, current: () => boolean, changed: (record: PromptJournalRecord) => void): CloudPromptChannel {
    const key = promptOwnerKey(owner), old = this.jobs.get(key);
    if (old?.current()) return old.channel;
    if (old) { this.retire(old); this.jobs.delete(key); }
    if (this.jobs.size >= 64) {
      for (const [key, job] of this.jobs) if (!job.running && !job.committing && (!job.current() || !job.requested && !job.channel.pending)) { this.retire(job); this.jobs.delete(key); break; }
      if (this.jobs.size >= 64) throw new Error("Finish an active cloud conversation before opening another.");
    }
    const job: Job = { waiters: [], retired: false, running: false, refreshing: false, committing: false, due: 0, recover: false, requested: false,
      current: () => !this.closed && !job.retired && current(),
      channel: new CloudPromptChannel(owner, this.journal, api, () => job.current(), changed),
    };
    this.jobs.set(key, job); return job.channel;
  }
  wake(channel: CloudPromptChannel, recover = false): void {
    const job = this.jobs.get(promptOwnerKey(channel.owner));
    if (!job || job.channel !== channel || !job.current()) return;
    job.requested = true; job.recover ||= recover; job.due = 0; this.schedule(0);
  }
  /** Foreground Send starts its HTTPS commit immediately, within the same
   * global concurrency bound as recovery. Resolves before status/history reads. */
  flush(channel: CloudPromptChannel): Promise<void> {
    const job = this.jobs.get(promptOwnerKey(channel.owner));
    if (!job || job.channel !== channel || !job.current()) return Promise.reject(new Error("The cloud account or owner changed."));
    const result = new Promise<void>((resolve, reject) => { job.waiters.push({ resolve, reject }); });
    job.requested = true; job.due = 0; void this.tick(); return result;
  }
  refreshPending(): void {
    for (const job of this.jobs.values()) if (job.channel.pending) { job.requested = true; job.due = 0; }
    this.schedule(0);
  }
  async erase(owner: CloudPromptOwner): Promise<void> {
    const key = promptOwnerKey(owner), job = this.jobs.get(key);
    if (job) this.retire(job);
    this.jobs.delete(key); await this.journal.erase(owner);
  }
  stop(): void { this.closed = true; clearTimeout(this.timer); for (const job of this.jobs.values()) this.retire(job); this.jobs.clear(); }
  private schedule(ms: number): void {
    if (this.closed) return;
    if (this.timer) { if (ms) return; clearTimeout(this.timer); }
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, ms);
  }
  private async tick(): Promise<void> {
    if (this.closed) return;
    const now = Date.now(), ready: Job[] = [];
    for (const [key, job] of this.jobs) {
      if (!job.current()) { this.retire(job); this.jobs.delete(key); continue; }
      if (!job.committing && ((!job.running && job.due <= now && (job.requested || job.channel.pending)) ||
          job.refreshing && job.waiters.length > 0)) ready.push(job);
    }
    // Foreground commits never wait behind their own status/history read. The
    // overlap still consumes one of the four shared network slots.
    ready.sort((a, b) => Number(b.waiters.length > 0) - Number(a.waiters.length > 0));
    // Round-robin bounds recurring DB reads even with many restored chats.
    for (const job of ready.slice(0, Math.max(0, 4 - this.inFlight))) {
      this.jobs.delete(promptOwnerKey(job.channel.owner)); this.jobs.set(promptOwnerKey(job.channel.owner), job);
      const commitOnly = job.running;
      if (commitOnly) job.committing = true; else job.running = true;
      this.inFlight++;
      const waiters = job.waiters.splice(0), recover = job.recover;
      if (!commitOnly) { job.recover = false; job.requested = false; }
      void (async () => {
        try {
          await job.channel.flush();
          if (!job.current()) throw new Error("The cloud account or owner changed.");
          for (const waiter of waiters) waiter.resolve();
          if (!commitOnly) { job.refreshing = true; await job.channel.refresh(recover); }
        } catch {
          // A saved attempt retries the same id. Foreground callers only see a
          // safe owner/storage error; no raw network diagnostic reaches chat.
          for (const waiter of waiters) waiter.reject(new Error("Cloud delivery could not be confirmed. Your saved message has been kept."));
        }
        finally {
          if (commitOnly) job.committing = false; else { job.running = false; job.refreshing = false; }
          this.inFlight--;
          job.due = job.requested ? 0 : Date.now() + 2_000;
          if (job.current() && !job.running && !job.committing && !job.channel.pending) this.idle();
          if ([...this.jobs.values()].some(candidate => candidate.current() && !candidate.committing &&
              (!candidate.running && (candidate.channel.pending || candidate.requested) || candidate.refreshing && candidate.waiters.length)))
            this.schedule(0);
        }
      })();
    }
    if ([...this.jobs.values()].some(job => !job.running && !job.committing && (job.channel.pending || job.requested))) this.schedule(2_000);
  }
}
