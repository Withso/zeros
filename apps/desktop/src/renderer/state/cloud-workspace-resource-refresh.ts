const REFRESH_INTERVAL_MS = 30_000;

/** A bounded clock for resource revisions not carried by the device stream.
 * The account lifecycle supplies only orgs omitted from its catalog fallback;
 * active cache consumers still own reads, single-flight and retained snapshots. */
export class CloudWorkspaceResourceRefresh {
  private readonly due = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;

  constructor(private readonly publish: (organizations: ReadonlySet<string>) => void,
    private readonly now = () => performance.now()) {}

  sync(organizations: readonly string[]): void {
    const next = new Set(organizations), now = this.now();
    for (const id of this.due.keys()) if (!next.has(id)) this.due.delete(id);
    for (const id of next) if (!this.due.has(id)) this.due.set(id, now + REFRESH_INTERVAL_MS);
    this.active = true;
    this.schedule();
  }

  /** A completed read or another resource opportunity already refreshed these
   * consumers. Unrelated scopes cannot postpone a covered owner's deadline. */
  observed(organizations?: ReadonlySet<string>): void {
    const next = this.now() + REFRESH_INTERVAL_MS;
    for (const id of this.due.keys()) if (!organizations || organizations.has(id)) this.due.set(id, next);
    this.schedule();
  }

  pause(): void {
    this.active = false;
    clearTimeout(this.timer); this.timer = undefined;
  }

  clear(): void { this.pause(); this.due.clear(); }

  private schedule(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.active || !this.due.size) return;
    const next = Math.min(...this.due.values());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const now = this.now(), organizations = new Set<string>();
      for (const [id, due] of this.due) if (due <= now) {
        organizations.add(id); this.due.set(id, now + REFRESH_INTERVAL_MS);
      }
      try { if (organizations.size) this.publish(organizations); }
      finally { this.schedule(); }
    }, Math.max(0, Math.ceil(next - this.now())));
  }
}
