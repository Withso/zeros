import { z } from "zod";
import { getOrganizationStoreGeneration, getTeamStoreState } from "../features/team/team-store";
import { getActiveBridge } from "./bridge/active-bridge";
import { workspaceOp } from "./bridge/workspace-bridge";
import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";
import { dialogPickFolder } from "./git";

const IdentitySchema = z.object({ accountUserId: z.string().uuid(), deviceId: z.string().uuid() });
export type CloudReplicaIdentity = z.infer<typeof IdentitySchema>;
export type CloudReplicaAccount = { accountUserId: string; accountEpoch: number };
export type CloudReplicaScope = CloudReplicaAccount & CloudReplicaIdentity & CloudWorkspaceTarget;

// This is a projection of the existing local engine RPC, not a new protocol.
// Proofs, tokens and filesystem contents never enter the replica controls.
const ReplicaSchema = IdentitySchema.extend({
  organizationId: z.string().uuid(), workspaceId: z.string().uuid(), replicaId: z.string().uuid(),
  rootPath: z.string().min(1),
  desiredState: z.enum(["active", "paused", "removed"]),
  observedState: z.enum(["bootstrapping", "pending", "syncing", "in_sync", "diverged", "paused", "detached", "failed", "removed"]),
  manifestRevision: z.number().int().nonnegative().nullable(), eventCursor: z.number().int().nonnegative(),
  ignorePolicy: z.unknown(), lastErrorCode: z.string().nullable(),
});
export type CloudReplica = z.infer<typeof ReplicaSchema>;
const DivergenceSchema = z.object({ path: z.string().min(1), detectedAt: z.number().int().nonnegative() });
export type CloudReplicaDivergence = z.infer<typeof DivergenceSchema>;

export function assertCloudReplicaAccount(owner: CloudReplicaAccount): void {
  if (owner.accountEpoch !== getOrganizationStoreGeneration() ||
    owner.accountUserId !== getTeamStoreState().me?.user.id) {
    throw new Error("Cloud replica account changed; reopen sync controls");
  }
}

function coordinates(scope: CloudReplicaScope) {
  return { accountUserId: scope.accountUserId, deviceId: scope.deviceId,
    organizationId: scope.organizationId, workspaceId: scope.workspaceId };
}

async function localReplicaOp(owner: CloudReplicaAccount, op: string, params: Record<string, unknown>, timeoutMs = 10_000) {
  assertCloudReplicaAccount(owner);
  const bridge = getActiveBridge();
  if (!bridge || bridge.executionIdentity.kind !== "local") throw new Error("Sync requires this Mac's local engine connection");
  const value = await workspaceOp(bridge, `cloudReplica.${op}`, params, timeoutMs);
  assertCloudReplicaAccount(owner);
  if (bridge !== getActiveBridge()) throw new Error("Local replica connection changed; reopen sync controls");
  return value;
}

export async function readCloudReplicaIdentity(owner: CloudReplicaAccount): Promise<CloudReplicaIdentity> {
  const identity = IdentitySchema.parse(await localReplicaOp(owner, "identity", { accountUserId: owner.accountUserId }));
  if (identity.accountUserId !== owner.accountUserId) throw new Error("Local replica identity changed");
  return identity;
}

function assertReplicaIdentity(scope: CloudReplicaScope, replica: CloudReplica, workspace = true) {
  if (replica.accountUserId !== scope.accountUserId || replica.deviceId !== scope.deviceId ||
    (workspace && (replica.organizationId !== scope.organizationId || replica.workspaceId !== scope.workspaceId))) {
    throw new Error("Local replica identity changed");
  }
}

export async function listCloudReplicas(scope: CloudReplicaScope): Promise<CloudReplica[]> {
  const rows = z.array(ReplicaSchema).parse(await localReplicaOp(scope, "list", coordinates(scope)));
  for (const row of rows) assertReplicaIdentity(scope, row, false);
  return rows.filter(row => row.organizationId === scope.organizationId && row.workspaceId === scope.workspaceId && row.desiredState !== "removed");
}

export async function readCloudReplicaDivergences(scope: CloudReplicaScope, replicaId: string): Promise<CloudReplicaDivergence[]> {
  return z.array(DivergenceSchema).parse(await localReplicaOp(scope, "divergences", { ...coordinates(scope), replicaId }));
}

/** The picker neither registers a project nor changes the selected runtime. */
export async function pickCloudReplicaFolder(owner: CloudReplicaAccount): Promise<string | null> {
  assertCloudReplicaAccount(owner);
  const path = await dialogPickFolder({ title: "Choose an empty folder for cloud downloads" });
  assertCloudReplicaAccount(owner);
  return path;
}

export async function createCloudReplica(scope: CloudReplicaScope, rootPath: string, idempotencyKey: string): Promise<CloudReplica> {
  const replica = ReplicaSchema.parse(await localReplicaOp(scope, "create", {
    ...coordinates(scope), rootPath, pathLabel: rootPath.split("/").filter(Boolean).at(-1) ?? null, idempotencyKey,
  }, 120_000));
  assertReplicaIdentity(scope, replica);
  return replica;
}

export async function changeCloudReplica(scope: CloudReplicaScope, replicaId: string, operation: "pause" | "resume" | "remove",
  idempotencyKey: string, replaceDiverged = false): Promise<CloudReplica> {
  const replica = ReplicaSchema.parse(await localReplicaOp(scope, operation, {
    ...coordinates(scope), replicaId, idempotencyKey, ...(operation === "resume" ? { replaceDiverged } : {}),
  }, 120_000));
  assertReplicaIdentity(scope, replica);
  if (replica.replicaId !== replicaId) throw new Error("Local replica identity changed");
  return replica;
}
