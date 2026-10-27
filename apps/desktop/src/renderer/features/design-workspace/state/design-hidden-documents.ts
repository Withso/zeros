export const DESIGN_HIDDEN_DOCUMENT_GRACE_MS = 10_000;
export const DESIGN_MAX_WARM_HIDDEN_DOCUMENTS = 12;
const EMPTY: ReadonlySet<string> = new Set();
interface Demand {
  owner: string;
  active: boolean;
  files: ReadonlySet<string>;
  available?: readonly string[];
  protectedFiles: readonly string[];
  retainAll: boolean;
}
interface Entry {
  demand: Demand;
  files: ReadonlySet<string>;
  hiddenAt: number | null;
  order: number;
  retire(files: string[]): void;
}
const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((file) => b.has(file));

/** Documents have a shorter lifetime than camera/selection and saved pixels.
 * A timer can retire optional documents, never authorize losing an editor or
 * unresolved mutation. Protected leases are counted separately from warmth. */
export class DesignHiddenDocuments {
  private entries = new Map<object, Entry>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private order = 0;
  constructor(private readonly policy = { graceMs: DESIGN_HIDDEN_DOCUMENT_GRACE_MS, maxHidden: DESIGN_MAX_WARM_HIDDEN_DOCUMENTS }) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  read = (token: object): ReadonlySet<string> => this.entries.get(token)?.files ?? EMPTY;

  update(token: object, demand: Demand, retire: Entry["retire"]): void {
    const previous = this.entries.get(token);
    const current = previous?.demand.owner === demand.owner ? previous : undefined;
    const files = demand.active ? demand.files : current?.files ?? EMPTY;
    const entry: Entry = {
      demand, files: current && same(current.files, files) ? current.files : files,
      hiddenAt: demand.active ? null : current?.hiddenAt ?? Date.now(), retire,
      order: !current || (current.demand.active && !demand.active) ? ++this.order : current.order,
    };
    this.entries.set(token, entry);
    this.reconcile(previous?.files !== entry.files);
  }

  remove(token: object): void {
    this.entries.delete(token);
    this.reconcile(false);
  }

  usage() {
    let active = 0, warm = 0, protectedCount = 0;
    for (const entry of this.entries.values()) {
      if (entry.demand.active) { active += entry.files.size; continue; }
      for (const file of entry.files) {
        if (entry.demand.retainAll || entry.demand.protectedFiles.includes(file)) protectedCount++;
        else warm++;
      }
    }
    return { active, warm, protected: protectedCount };
  }

  private reconcile(changed: boolean): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const now = Date.now();
    let remaining = this.policy.maxHidden;
    let nextExpiry = Infinity;
    const retired: Array<() => void> = [];
    // Recent destinations get the small global warm allowance first.
    const hidden = [...this.entries.values()].filter((entry) => !entry.demand.active)
      .sort((a, b) => b.order - a.order);
    for (const entry of hidden) {
      const keep = new Set<string>();
      const removed: string[] = [];
      for (const file of entry.files) {
        const protectedFile = entry.demand.retainAll || entry.demand.protectedFiles.includes(file);
        const warm = (!entry.demand.available || entry.demand.available.includes(file)) &&
          now < entry.hiddenAt! + this.policy.graceMs && remaining > 0;
        if (protectedFile || warm) {
          keep.add(file);
          if (!protectedFile) {
            remaining--;
            nextExpiry = Math.min(nextExpiry, entry.hiddenAt! + this.policy.graceMs);
          }
        } else removed.push(file);
      }
      if (removed.length) {
        entry.files = keep.size ? keep : EMPTY;
        changed = true;
        retired.push(() => entry.retire(removed));
      }
    }
    if (Number.isFinite(nextExpiry)) this.timer = setTimeout(() => { this.timer = null; this.reconcile(false); }, Math.max(1, nextExpiry - now));
    if (changed) for (const listener of this.listeners) listener();
    for (const retire of retired) retire();
  }
}

export const designHiddenDocuments = new DesignHiddenDocuments();
