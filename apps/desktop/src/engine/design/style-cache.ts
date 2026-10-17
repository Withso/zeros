// One size-weighted, least-recently-used budget for every cached style result
// in the engine: resolved sources, compiled generations, per-frame builds and
// App fonts. A few large sources cannot grow memory without bound, and many
// small ones share the room. The newest entry always stays, so a source larger
// than the whole budget is still read once per change, not once per frame.
//
// Keys start with the workspace root, so Update can forget one checkout.

export const MAX_DESIGN_STYLE_CACHE_BYTES = 64 * 1024 * 1024;

interface Entry {
  value: unknown;
  bytes: number;
}

export class DesignStyleCache {
  private readonly entries = new Map<string, Entry>();
  private total = 0;

  constructor(private readonly budget: number) {}

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  set(key: string, value: unknown, bytes: number): void {
    this.delete(key);
    const size = Math.max(0, Math.ceil(bytes));
    this.entries.set(key, { value, bytes: size });
    this.total += size;
    while (this.total > this.budget && this.entries.size > 1) {
      this.delete(this.entries.keys().next().value!);
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.bytes;
  }

  /** Forget every entry whose key starts with `prefix`. */
  deletePrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.delete(key);
  }

  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }
}

export const designStyleCache = new DesignStyleCache(MAX_DESIGN_STYLE_CACHE_BYTES);

/** The cache key for one workspace's entry in a namespace. */
export function designStyleCacheKey(root: string, namespace: string, rest: string): string {
  return `${root}\0${namespace}\0${rest}`;
}

/** Bytes a JavaScript string holds, near enough for budgeting. */
export function stringCost(value: string | null | undefined): number {
  return value ? value.length : 0;
}
