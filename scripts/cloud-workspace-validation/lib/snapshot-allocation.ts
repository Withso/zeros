import { randomUUID } from "node:crypto";
import { runBoundedProviderOperation, waitForResourceAbsence } from "./provider-cleanup";

export type SnapshotAllocation = {
  version: 1; providerScope: string; runId: string; name: string;
  requestedAt: string; snapshotId?: string;
};
export interface SnapshotAllocationStore {
  readonly providerScope: string;
  read(): SnapshotAllocation | null;
  write(value: SnapshotAllocation): void;
  clear(): void;
}
export type OwnedSnapshot = { id: string; name: string; state: string };
export interface SnapshotInventory<S extends OwnedSnapshot> {
  list(): AsyncIterable<S>;
  get(id: string): Promise<S | null>;
  delete(snapshot: S): Promise<void>;
}
export function parseSnapshotAllocation(value: unknown): SnapshotAllocation {
  const v = value as SnapshotAllocation;
  if (!v || v.version !== 1 || !/^[a-f0-9]{64}$/.test(v.providerScope) ||
    !/^[a-f0-9-]{36}$/.test(v.runId) || !/^[A-Za-z0-9._-]{1,256}$/.test(v.name) ||
    !Number.isFinite(Date.parse(v.requestedAt)) ||
    (v.snapshotId !== undefined && !/^[A-Za-z0-9._:-]{1,256}$/.test(v.snapshotId)))
    throw new Error("Snapshot allocation receipt is invalid");
  return v;
}

/** An uncertain create does not confer delete authority by name. Only the ID
 * acknowledged to this run can be deleted, followed by independent inventory. */
export async function cleanupOwnedSnapshot<S extends OwnedSnapshot>(client: SnapshotInventory<S>, store: SnapshotAllocationStore): Promise<void> {
  const receipt = store.read();
  if (!receipt) return;
  if (receipt.providerScope !== store.providerScope) throw new Error("Snapshot provider scope changed; retain its original cleanup credential");
  if (!receipt.snapshotId) throw new Error("Snapshot creation is uncertain; retain the receipt for provider reconciliation");
  const snapshot = await client.get(receipt.snapshotId);
  if (snapshot && (snapshot.id !== receipt.snapshotId || snapshot.name !== receipt.name))
    throw new Error("Snapshot cleanup identity changed");
  if (snapshot) {
    try { await runBoundedProviderOperation("owned snapshot deletion", () => client.delete(snapshot), 120_000); }
    catch { /* A lost acknowledgement is settled only by fresh inventory. */ }
  }
  await waitForResourceAbsence("owned snapshot", async () => {
    for await (const candidate of client.list()) if (candidate.id === receipt.snapshotId) return true;
    return false;
  });
  store.clear();
}

/** The VM callback returns the initial POST acknowledgement before waiting for
 * image readiness. A build failure therefore retains exact cleanup ownership. */
export async function createOwnedSnapshot<S extends OwnedSnapshot>(input: {
  client: SnapshotInventory<S>; store: SnapshotAllocationStore; name: string;
  create(signal: AbortSignal): Promise<S>;
  validate(snapshot: S): void;
  createTimeoutMs?: number; buildTimeoutMs?: number; pollMs?: number;
}): Promise<S> {
  const { client, store, name } = input;
  if (store.read()) throw new Error("Reconcile the previous snapshot allocation before baking another");
  for await (const candidate of client.list()) if (candidate.name === name)
    throw new Error("Snapshot name already exists; this run does not own it");
  const receipt = parseSnapshotAllocation({ version: 1, providerScope: store.providerScope, runId: randomUUID(), name, requestedAt: new Date().toISOString() });
  store.write(receipt);
  const controller = new AbortController();
  const createTimeout = input.createTimeoutMs ?? 90_000;
  const deadline = Date.now() + (input.buildTimeoutMs ?? 90 * 60_000);
  try {
    let snapshot = await runBoundedProviderOperation("snapshot creation", () => input.create(controller.signal), createTimeout);
    // Persist the acknowledged ID before checking name, state or placement.
    store.write(parseSnapshotAllocation({ ...receipt, snapshotId: snapshot.id }));
    while (snapshot.state !== "active") {
      if (["error", "build_failed", "failed"].includes(snapshot.state)) throw new Error("Snapshot build failed");
      if (snapshot.id !== store.read()?.snapshotId || snapshot.name !== name || Date.now() >= deadline)
        throw new Error("Snapshot build identity changed or readiness timed out");
      await new Promise(resolve => setTimeout(resolve, input.pollMs ?? 1_000));
      const observed = await runBoundedProviderOperation("snapshot observation", () => client.get(snapshot.id), Math.min(30_000, Math.max(1, deadline - Date.now())));
      if (!observed) throw new Error("Acknowledged snapshot disappeared during build");
      snapshot = observed;
    }
    if (snapshot.id !== store.read()?.snapshotId || snapshot.name !== name) throw new Error("Snapshot build identity changed");
    input.validate(snapshot);
    return snapshot;
  } catch (error) {
    controller.abort();
    // Unacknowledged outcomes retain the intent. They cannot justify deleting
    // a different request's same-name snapshot, even after an empty inventory.
    if (store.read()?.snapshotId) {
      try { await cleanupOwnedSnapshot(client, store); }
      catch { throw new Error("Snapshot build failed and exact cleanup remains unverified; receipt retained"); }
    }
    throw error;
  } finally { controller.abort(); }
}
