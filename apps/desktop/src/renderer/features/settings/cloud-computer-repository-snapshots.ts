import type { CloudV2InstalledRepository } from "../../platform/cloud-v2";

const STORAGE_KEY = "zeros:cloud-computer-repositories:v1";
const MAX_OWNERS = 16;
const MAX_STORAGE_BYTES = 1_000_000;
type Installed = readonly CloudV2InstalledRepository[] | null;
type Snapshot = { data: Installed; updatedAt: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validKey(key: unknown): key is string {
  if (typeof key !== "string") return false;
  try {
    const parts: unknown = JSON.parse(key);
    return Array.isArray(parts) && parts.length === 2 && parts.every(id => typeof id === "string" && uuid.test(id));
  } catch { return false; }
}
function validInstalled(value: unknown): value is Installed {
  return value === null || Array.isArray(value) && value.length <= 200 && value.every(row =>
    row && typeof row.owner === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(row.owner) &&
    typeof row.name === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(row.name) &&
    row.id === `${row.owner}/${row.name}`.toLowerCase() &&
    (row.defaultBranch === null || typeof row.defaultBranch === "string" && row.defaultBranch.length <= 255));
}

/** This is presentation cache, never create authorization. Restored snapshots
 * render synchronously and revalidate in the background against the same owner. */
export class CloudComputerRepositorySnapshots {
  private rows = new Map<string, Snapshot>();
  constructor(private storage: Pick<Storage, "getItem" | "setItem"> | undefined, private backend: string) {
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (!raw || raw.length > MAX_STORAGE_BYTES) return;
      const value = JSON.parse(raw) as { backend?: unknown; entries?: unknown };
      if (value.backend !== backend || !Array.isArray(value.entries)) return;
      for (const row of value.entries.slice(-MAX_OWNERS)) {
        if (!Array.isArray(row) || row.length !== 2 || !validKey(row[0])) continue;
        const snapshot = row[1] as Snapshot | null;
        if (!snapshot || !Number.isFinite(snapshot.updatedAt) || snapshot.updatedAt < 0 || snapshot.updatedAt > Date.now() + 60_000 || !validInstalled(snapshot.data)) continue;
        this.rows.set(row[0], snapshot);
      }
    } catch { /* A cold network read remains available when storage fails. */ }
  }
  get(key: string): Snapshot | undefined {
    const row = this.rows.get(key);
    // Revalidation starts immediately after a cold renderer launch, with the
    // last confirmed rows already visible. Never extend server freshness.
    return row ? { data: row.data, updatedAt: 0 } : undefined;
  }
  set(key: string, snapshot: Snapshot): void {
    if (!validKey(key) || !validInstalled(snapshot.data)) return;
    this.rows.delete(key);
    this.rows.set(key, snapshot);
    while (this.rows.size > MAX_OWNERS) this.rows.delete(this.rows.keys().next().value!);
    const serialize = () => JSON.stringify({ backend: this.backend, entries: [...this.rows] });
    let serialized = serialize();
    // Keep writes inside the recovery budget too. Catalogs can be fetched
    // again, so evict the oldest owner before discarding the newest snapshot.
    while (serialized.length > MAX_STORAGE_BYTES && this.rows.size > 0) {
      this.rows.delete(this.rows.keys().next().value!);
      serialized = serialize();
    }
    try { this.storage?.setItem(STORAGE_KEY, serialized); } catch { /* Keep the in-memory snapshot. */ }
  }
}
