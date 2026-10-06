export type GithubReadCredentialBroker = {
  mintWorkspaceRead(input: { installationId: number; repositoryId: number }): Promise<{ token: string; expiresAtMs: number }>;
  revoke(token: string): Promise<void>;
};
type Repository = { installationId: number; repositoryId: number };
type Entry = { token: string; expiresAtMs: number; users: number; retired: boolean; drain?: () => void; retirement?: Promise<void> };
const unavailable = () => new Error("GitHub repository read is unavailable.");
const REFRESH_BEFORE_MS = 5 * 60_000;

/** Installation secrets exist only in this bounded, process-local cache.
 * Eviction/expiry retires an entry immediately and revokes it after its active
 * readers drain. Minting is coalesced by immutable installation/repository ID. */
export class GithubReadCredentials {
  private readonly entries = new Map<string, Entry>();
  private readonly minting = new Map<string, Promise<Entry>>();
  private readonly retiring = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private closed = false;
  constructor(private readonly broker: GithubReadCredentialBroker, options: { now?: () => number; maxEntries?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 64;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > 64) throw unavailable();
  }
  private retire(entry: Entry): Promise<void> {
    if (entry.retirement) return entry.retirement;
    entry.retired = true;
    entry.retirement = new Promise(resolve => {
      entry.drain = () => { delete entry.drain; void this.broker.revoke(entry.token).catch(() => undefined).finally(resolve); };
    });
    const retirement = entry.retirement;
    this.retiring.add(retirement);
    void retirement.then(() => this.retiring.delete(retirement));
    if (!entry.users) entry.drain!();
    return retirement;
  }
  private expire(): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs - this.now() <= REFRESH_BEFORE_MS) {
        this.entries.delete(key); void this.retire(entry);
      }
    }
  }
  async cleanup(): Promise<void> {
    this.expire();
    await Promise.all([...this.retiring]);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.entries.values()) void this.retire(entry);
    this.entries.clear();
    await Promise.allSettled([...this.minting.values()]);
    await Promise.all([...this.retiring]);
  }
  async use<T>(repository: Repository, read: (token: string) => Promise<T>): Promise<T> {
    if (this.closed) throw unavailable();
    this.expire();
    const key = `${repository.installationId}:${repository.repositoryId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      let pending = this.minting.get(key);
      if (!pending) {
        if (this.minting.size >= 64) throw unavailable();
        pending = this.broker.mintWorkspaceRead(repository).then(minted => {
          const created: Entry = { ...minted, users: 0, retired: false };
          if (this.closed || minted.expiresAtMs - this.now() <= REFRESH_BEFORE_MS) {
            void this.retire(created); throw unavailable();
          }
          this.entries.set(key, created);
          while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value!;
            const evicted = this.entries.get(oldest)!;
            this.entries.delete(oldest); void this.retire(evicted);
          }
          return created;
        });
        this.minting.set(key, pending);
      }
      try { entry = await pending; }
      finally { if (this.minting.get(key) === pending) this.minting.delete(key); }
    }
    if (this.closed || entry.retired) throw unavailable();
    this.entries.delete(key); this.entries.set(key, entry);
    entry.users++;
    try { return await read(entry.token); }
    finally { entry.users--; if (!entry.users && entry.retired) entry.drain?.(); }
  }
}
