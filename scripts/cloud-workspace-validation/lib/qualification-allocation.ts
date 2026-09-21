import { randomUUID } from "node:crypto";
import type { CreateSandboxFromSnapshotParams } from "@daytona/sdk";
import { verifySandboxAbsent } from "./provider-cleanup";

export type QualificationAllocation = {
  version: 1;
  providerScope: string;
  runId: string;
  name: string;
  snapshot: string;
  createdAt: string;
  ttlMinutes: number;
  sandboxId?: string;
  creationAcknowledged?: true;
};
export interface QualificationAllocationStore {
  readonly providerScope: string;
  read(): QualificationAllocation | null;
  write(intent: QualificationAllocation): void;
  clear(): void;
}
type Sandbox = {
  id: string; name: string; labels: Record<string, string>;
  snapshot?: string; createdAt?: string; autoDestroyAt?: string;
  delete(): Promise<void>;
};
interface Client<S extends Sandbox> {
  create(params: CreateSandboxFromSnapshotParams, options: { timeout: number }): Promise<S>;
  get(idOrName: string): Promise<S>;
  list(query: { id?: string; labels?: Record<string, string>; limit: number }): AsyncIterable<S>;
}

/** Caller holds the cross-process mutation lock for the entire operation.
 * Cleanup authority belongs only to the intent first persisted by this run. */
export async function withQualificationAllocationRun<S extends Sandbox, T>(
  client: Client<S>, store: QualificationAllocationStore,
  run: (ownedStore: QualificationAllocationStore) => Promise<T>,
  options: { hasExistingState?: boolean } = {},
): Promise<T> {
  if (store.read() || options.hasExistingState) throw new Error("Clean up the previous qualification allocation before creating another");
  let ownedRunId: string | undefined;
  const ownedStore: QualificationAllocationStore = {
    providerScope: store.providerScope,
    read: () => store.read(), clear: () => store.clear(),
    write(intent) {
      if (ownedRunId && intent.runId !== ownedRunId) throw new Error("Qualification run ownership changed");
      store.write(intent);
      ownedRunId = intent.runId;
    },
  };
  try { return await run(ownedStore); }
  catch (error) {
    if (ownedRunId && store.read()?.runId === ownedRunId) {
      try { await cleanupQualificationAllocation(client, store); }
      catch { throw new Error("Qualification failed and exact cleanup remains unverified; private intent retained"); }
    }
    throw error;
  }
}

export function parseQualificationAllocation(value: unknown): QualificationAllocation {
  const v = value as QualificationAllocation;
  if (!v || v.version !== 1 || !/^[a-f0-9]{64}$/.test(v.providerScope) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.runId) ||
      v.name !== `zeros-validation-${v.runId}` || typeof v.snapshot !== "string" ||
      !/^[a-zA-Z0-9._:-]{1,256}$/.test(v.snapshot) ||
      !Number.isFinite(Date.parse(v.createdAt)) || !Number.isInteger(v.ttlMinutes) ||
      v.ttlMinutes < 1 || v.ttlMinutes > 720 ||
      (v.sandboxId !== undefined && !/^[a-zA-Z0-9._:-]{1,256}$/.test(v.sandboxId)) ||
      (v.creationAcknowledged !== undefined && (v.creationAcknowledged !== true || !v.sandboxId))) {
    throw new Error("Qualification allocation intent is invalid");
  }
  return v;
}

function assertIdentity(sandbox: Sandbox, intent: QualificationAllocation): void {
  const created = Date.parse(sandbox?.createdAt ?? "");
  if (!sandbox || !/^[a-zA-Z0-9._:-]{1,256}$/.test(sandbox.id) ||
      (intent.sandboxId && sandbox.id !== intent.sandboxId) ||
      sandbox.name !== intent.name || sandbox.labels?.zeros_qualification_run !== intent.runId ||
      sandbox.snapshot !== intent.snapshot || !Number.isFinite(created) ||
      created < Date.parse(intent.createdAt) - 120_000 || created > Date.now() + 120_000) {
    throw new Error("Qualification allocation identity cannot be verified");
  }
}

/** Persist BEFORE the provider request; no retry allocates another resource.
 * The server-enforced wall-clock TTL bounds spend even if the runner is killed
 * before any response/state write. This TTL is for disposable tests only. */
export async function createQualificationSandbox<S extends Sandbox>(
  client: Client<S>, store: QualificationAllocationStore,
  params: CreateSandboxFromSnapshotParams & { snapshot: string; ttlMinutes: number },
): Promise<S> {
  if (store.read()) throw new Error("Clean up the previous qualification allocation before creating another");
  const runId = randomUUID();
  const intent = parseQualificationAllocation({ version: 1, runId, providerScope: store.providerScope,
    name: `zeros-validation-${runId}`, snapshot: params.snapshot,
    createdAt: new Date().toISOString(), ttlMinutes: params.ttlMinutes });
  store.write(intent);
  let sandbox: S;
  let receipt = intent;
  try {
    sandbox = await client.create({ ...params, name: intent.name, public: false,
      labels: { ...params.labels, zeros_qualification_run: runId } }, { timeout: 180 });
  } catch {
    // A failed response can conceal a committed create. Only recover this
    // recorded, random run identity; never issue a second create automatically.
    try { sandbox = await client.get(intent.name); }
    catch { throw new Error("Qualification create outcome is uncertain; allocation intent retained for cleanup"); }
    assertIdentity(sandbox, intent);
    receipt = { ...intent, sandboxId: sandbox.id };
    store.write(receipt);
  }
  // An authenticated successful create response proves allocation ownership,
  // independently of whether its image/deadline passes qualification. Persist
  // that receipt before rejecting metadata, so cleanup cannot strand it.
  if (!receipt.sandboxId && /^[a-zA-Z0-9._:-]{1,256}$/.test(sandbox?.id)) {
    receipt = { ...intent, sandboxId: sandbox.id, creationAcknowledged: true };
    store.write(receipt);
  }
  assertIdentity(sandbox, intent);
  const deadline = Date.parse(sandbox.autoDestroyAt ?? "");
  if (!Number.isFinite(deadline) || deadline <= Date.now() ||
      deadline > Date.parse(sandbox.createdAt!) + intent.ttlMinutes * 60_000 + 120_000) {
    throw new Error("Provider did not confirm the qualification wall-clock deadline; cleanup is required");
  }
  return sandbox;
}

export async function cleanupQualificationAllocation<S extends Sandbox>(
  client: Client<S>, store: QualificationAllocationStore,
): Promise<void> {
  const raw = store.read();
  if (!raw) return;
  const intent = parseQualificationAllocation(raw);
  if (intent.providerScope !== store.providerScope) throw new Error("Qualification provider scope changed; retain the original receipt and credentials for cleanup");
  let sandbox: S;
  try { sandbox = await client.get(intent.sandboxId ?? intent.name); }
  catch {
    if (intent.sandboxId) {
      await verifySandboxAbsent(client, intent.sandboxId);
      store.clear(); return;
    }
    throw new Error("Qualification allocation is unresolved; retain intent until exact cleanup is verified");
  }
  if (intent.creationAcknowledged) {
    if (!sandbox || sandbox.id !== intent.sandboxId) throw new Error("Qualification allocation identity cannot be verified");
  } else assertIdentity(sandbox, intent);
  store.write({ ...intent, sandboxId: sandbox.id });
  try { await sandbox.delete(); } catch { /* Verify a lost acknowledgement below. */ }
  await verifySandboxAbsent(client, sandbox.id);
  store.clear();
}
