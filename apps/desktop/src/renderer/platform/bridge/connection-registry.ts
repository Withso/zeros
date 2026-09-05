import {
  runtimeExecutionKey,
  type RuntimeClient,
  type RuntimeExecutionIdentity,
} from "./ws-client";

export type RuntimeConnectionRegistryClient = Pick<
  RuntimeClient,
  "executionIdentity" | "onExecutionIdentityChange" | "dispose"
>;

type Entry = {
  key: string;
  client: RuntimeConnectionRegistryClient;
  touched: number;
  stopIdentityListener: () => void;
};

/** Bounded, secret-free registry for renderer execution connections. It never
 * persists a descriptor and never keys by URL, token, display name, or current
 * selection. A generation/authority/engine rotation atomically rekeys the
 * client; a collision retires the ambiguous newcomer fail-closed. */
export class RuntimeConnectionRegistry {
  private readonly entries = new Map<string, Entry>();
  private activeKey: string | null = null;
  private sequence = 0;

  constructor(private readonly maxEntries = 8) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 32) {
      throw new Error("Runtime connection registry capacity is invalid");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  register(client: RuntimeConnectionRegistryClient): string {
    const existingEntry = [...this.entries.values()].find(
      (entry) => entry.client === client,
    );
    if (existingEntry) {
      existingEntry.touched = ++this.sequence;
      return existingEntry.key;
    }
    const key = runtimeExecutionKey(client.executionIdentity);
    if (this.entries.has(key)) {
      throw new Error("Runtime execution is already registered");
    }
    this.makeCapacity();
    const entry: Entry = {
      key,
      client,
      touched: ++this.sequence,
      stopIdentityListener: () => undefined,
    };
    entry.stopIdentityListener = client.onExecutionIdentityChange((identity) =>
      this.rekey(entry, identity),
    );
    this.entries.set(key, entry);
    return key;
  }

  get(identity: RuntimeExecutionIdentity): RuntimeConnectionRegistryClient | null {
    const entry = this.entries.get(runtimeExecutionKey(identity));
    if (!entry) return null;
    entry.touched = ++this.sequence;
    return entry.client;
  }

  activate(
    identity: RuntimeExecutionIdentity,
  ): RuntimeConnectionRegistryClient | null {
    const key = runtimeExecutionKey(identity);
    const entry = this.entries.get(key);
    if (!entry) return null;
    entry.touched = ++this.sequence;
    this.activeKey = key;
    return entry.client;
  }

  active(): RuntimeConnectionRegistryClient | null {
    if (!this.activeKey) return null;
    return this.entries.get(this.activeKey)?.client ?? null;
  }

  retire(identity: RuntimeExecutionIdentity): boolean {
    const key = runtimeExecutionKey(identity);
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.remove(entry, true);
    return true;
  }

  clear(): void {
    for (const entry of [...this.entries.values()]) this.remove(entry, true);
  }

  private makeCapacity(): void {
    if (this.entries.size < this.maxEntries) return;
    const candidate = [...this.entries.values()]
      .filter((entry) => entry.key !== this.activeKey)
      .sort((left, right) => left.touched - right.touched)[0];
    if (!candidate) {
      throw new Error("Runtime connection registry is at active capacity");
    }
    this.remove(candidate, true);
  }

  private rekey(entry: Entry, identity: RuntimeExecutionIdentity): void {
    if (this.entries.get(entry.key) !== entry) return;
    const nextKey = runtimeExecutionKey(identity);
    if (nextKey === entry.key) {
      entry.touched = ++this.sequence;
      return;
    }
    const collision = this.entries.get(nextKey);
    if (collision && collision !== entry) {
      // Two live clients claiming the same execution would let stale handlers
      // mutate the wrong workspace. Retire the identity-changing client and
      // retain the already-authoritative exact-key entry.
      this.remove(entry, true);
      return;
    }
    const wasActive = this.activeKey === entry.key;
    this.entries.delete(entry.key);
    entry.key = nextKey;
    entry.touched = ++this.sequence;
    this.entries.set(nextKey, entry);
    if (wasActive) this.activeKey = nextKey;
  }

  private remove(entry: Entry, dispose: boolean): void {
    if (this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key);
    if (this.activeKey === entry.key) this.activeKey = null;
    entry.stopIdentityListener();
    if (dispose) entry.client.dispose();
  }
}
