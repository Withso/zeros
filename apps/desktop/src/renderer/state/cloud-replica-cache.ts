import { z } from "zod";
import { onAuthStateChange } from "../features/auth/auth-store";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import { KeyedAsyncCache } from "../shared/lib/keyed-async-cache";
import {
  listCloudReplicas, readCloudReplicaDivergences, readCloudReplicaIdentity,
  type CloudReplica, type CloudReplicaDivergence, type CloudReplicaIdentity, type CloudReplicaScope,
} from "../platform/cloud-replicas";
import type { CloudWorkspaceTarget } from "../platform/bridge/cloud-workspace-key";

export const CLOUD_REPLICA_FRESHNESS_MS = 10_000;
export type CloudReplicaSnapshot = { replica: CloudReplica | null; divergences: CloudReplicaDivergence[] };
function retainEqual<T>(previous: T | undefined, next: T): T {
  return previous !== undefined && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
// Enrollment metadata is account-owned. Downloaded state is keyed separately
// by the exact account/device/org/workspace and sign-in generation.
export const cloudReplicaIdentityCache = new KeyedAsyncCache<CloudReplicaIdentity>({ maxEntries: 8, reconcile: retainEqual });
export const cloudReplicaCache = new KeyedAsyncCache<CloudReplicaSnapshot>({ maxEntries: 32, reconcile: retainEqual,
  maxWeight: 4 * 1024 * 1024, weightOf: value => JSON.stringify(value).length * 2 });
const AccountKeySchema = z.tuple([z.string().uuid(), z.number().int().nonnegative()]);
const ScopeKeySchema = z.tuple([z.string().uuid(), z.number().int().nonnegative(), z.string().uuid(), z.string().uuid(), z.string().uuid()]);

export function cloudReplicaIdentityKey(accountUserId: string): string {
  return JSON.stringify([accountUserId, getOrganizationStoreGeneration()]);
}
export function cloudReplicaScopeKey(scope: CloudReplicaScope): string {
  return JSON.stringify([scope.accountUserId, scope.accountEpoch, scope.deviceId, scope.organizationId, scope.workspaceId]);
}
export function cloudReplicaScopeFromKey(key: string): CloudReplicaScope {
  const [accountUserId, accountEpoch, deviceId, organizationId, workspaceId] = ScopeKeySchema.parse(JSON.parse(key));
  return { accountUserId, accountEpoch, deviceId, organizationId, workspaceId };
}
export function readCloudReplicaIdentityKey(key: string): Promise<CloudReplicaIdentity> {
  const [accountUserId, accountEpoch] = AccountKeySchema.parse(JSON.parse(key));
  return readCloudReplicaIdentity({ accountUserId, accountEpoch });
}
export async function readCloudReplicaScopeKey(key: string): Promise<CloudReplicaSnapshot> {
  const scope = cloudReplicaScopeFromKey(key);
  const rows = await listCloudReplicas(scope);
  // The existing engine admits one live replica per account/device/workspace.
  if (rows.length > 1) throw new Error("Local replica identity is ambiguous");
  const replica = rows[0] ?? null;
  const divergences = replica?.observedState === "diverged" || replica?.desiredState === "paused"
    ? await readCloudReplicaDivergences(scope, replica.replicaId) : [];
  return { replica, divergences };
}
export async function warmCloudWorkspaceReplicas(accountUserId: string, target: CloudWorkspaceTarget): Promise<void> {
  const accountKey = cloudReplicaIdentityKey(accountUserId);
  const [_, accountEpoch] = AccountKeySchema.parse(JSON.parse(accountKey));
  const identity = await cloudReplicaIdentityCache.load(accountKey, () => readCloudReplicaIdentityKey(accountKey), { maxAgeMs: CLOUD_REPLICA_FRESHNESS_MS });
  const key = cloudReplicaScopeKey({ ...identity, ...target, accountEpoch });
  await cloudReplicaCache.load(key, () => readCloudReplicaScopeKey(key), { maxAgeMs: CLOUD_REPLICA_FRESHNESS_MS });
}
export function clearCloudReplicaCaches(): void {
  cloudReplicaIdentityCache.clear(); cloudReplicaCache.clear();
}
onAuthStateChange(clearCloudReplicaCaches);
