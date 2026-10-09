import type { Tx } from "../db.js";
import { isDeepStrictEqual } from "node:util";
import { HttpError } from "../authz.js";
import type { CloudAgentCredentialKeys, CloudAgentCredentialEnvelope } from "./agent-credential-envelope.js";
import { customizationDigest, customizationHistoryAuthority, repositoryCustomizationDigest, openCustomization, sealCustomization,
  CloudBootCustomizationBindingSchema, CloudBootCustomizationSnapshotSchema, CloudRepositoryMcpSchema,
  repositoryBootCustomizationDigest, openBootCustomization, sealBootCustomization,
  type CloudBootCustomizationBinding, type CloudBootCustomizationSnapshot, type CloudMcpServer, type CloudCustomizationDocument } from "./mcp-contract.js";
import { lockCustomization, readCustomizationDocument, readCustomizationRows } from "./customization-store.js";

type Scope = { organizationId: string; workspaceId: string; actorUserId: string };
type SnapshotRow = { lease_id: string; org_id: string; actor_user_id: string; organization_revision: string; member_revision: string;
  repository_digest: string; digest: string; key_version: number; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer };
const rejected = (): never => { throw new HttpError(403, "cloud_customization_changed", "Agent customization authority changed."); };
export async function validateCustomizationSnapshot(tx: Tx, leaseId: string, actorUserId: string) {
  const row = (await tx.query<SnapshotRow>("SELECT * FROM cloud_customization_execution_snapshots WHERE lease_id=$1", [leaseId])).rows[0];
  if (!row) return rejected();
  if (row.actor_user_id !== actorUserId) rejected();
  await lockCustomization(tx, row.org_id);
  const rows = await readCustomizationRows(tx, row.org_id, actorUserId);
  if (Number(row.organization_revision) !== Number(rows.find(value => value.owner_user_id === null)?.revision ?? 0) ||
      Number(row.member_revision) !== Number(rows.find(value => value.owner_user_id === actorUserId)?.revision ?? 0)) rejected();
  return row;
}
export async function admitCustomization(tx: Tx, scope: Scope, leaseId: string, repository: CloudMcpServer[], keys: CloudAgentCredentialKeys, previous: boolean, history = false) {
  const binding = { id: leaseId, organizationId: scope.organizationId, ownerUserId: scope.actorUserId, revision: 1, keyVersion: keys.currentKeyVersion };
  await lockCustomization(tx, scope.organizationId);
  if (previous) {
    const row = await validateCustomizationSnapshot(tx, leaseId, scope.actorUserId);
    if (!row || row.repository_digest !== repositoryCustomizationDigest(repository, { ...binding, keyVersion: row.key_version }, keys)) return rejected();
    const snapshot = openCustomization({ nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag },
      { id: leaseId, organizationId: scope.organizationId, ownerUserId: scope.actorUserId, revision: 1, keyVersion: row.key_version }, keys) as CustomizationSnapshot;
    if (!!snapshot.history !== history) rejected();
    return snapshot;
  }
  const repositoryDigest = repositoryCustomizationDigest(repository, binding, keys);
  const rows = await readCustomizationRows(tx, scope.organizationId, scope.actorUserId);
  const servers = new Map<string, { server: Omit<CloudMcpServer, "id">; scope: "organization" | "member" | "repository"; secretRef: string | null; revision: number }>();
  const skills = new Map<string, CloudCustomizationDocument["skills"][number]>();
  // Repository declarations win only their own names. A replacement never
  // inherits another source's environment or headers.
  for (const row of rows) {
    const document = readCustomizationDocument(row, keys);
    for (const { id, ...server } of document.servers) servers.set(server.name, { server, scope: row.owner_user_id ? "member" : "organization", secretRef: id!, revision: Number(row.revision) });
    for (const skill of document.skills) skills.set(skill.name, skill);
  }
  for (const { id: _id, ...server } of repository) servers.set(server.name, { server, scope: "repository", secretRef: null, revision: 0 });
  if (servers.size > 64 || skills.size > 64) rejected();
  const content = { version: 1 as const, repositoryDigest, ...(history ? {history: customizationHistoryAuthority(scope.organizationId, scope.workspaceId, scope.actorUserId, keys)} : {}), servers: [...servers.values()].sort((a, b) => a.server.name.localeCompare(b.server.name)),
    skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)), cursorTeamSettings: "disabled" as const };
  const snapshot = { ...content, digest: customizationDigest(content) };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 768 * 1024) rejected();
  const envelope = sealCustomization(snapshot, { id: leaseId, organizationId: scope.organizationId, ownerUserId: scope.actorUserId, revision: 1, keyVersion: keys.currentKeyVersion }, keys);
  await tx.query(`INSERT INTO cloud_customization_execution_snapshots(lease_id,org_id,actor_user_id,organization_revision,member_revision,repository_digest,digest,key_version,nonce,ciphertext,auth_tag)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [leaseId, scope.organizationId, scope.actorUserId,
    Number(rows.find(row => row.owner_user_id === null)?.revision ?? 0), Number(rows.find(row => row.owner_user_id === scope.actorUserId)?.revision ?? 0),
    repositoryDigest, snapshot.digest, keys.currentKeyVersion, envelope.nonce, envelope.ciphertext, envelope.authTag]);
  await tx.query("UPDATE cloud_agent_execution_leases SET customization_digest=$2 WHERE id=$1", [leaseId, snapshot.digest]);
  return snapshot;
}
type CustomizationSnapshot = { version: 1; repositoryDigest: string; digest: string; servers: { server: Omit<CloudMcpServer, "id">; scope: "organization" | "member" | "repository"; secretRef: string | null; revision: number }[];
  history?: ReturnType<typeof customizationHistoryAuthority>; skills: CloudCustomizationDocument["skills"]; cursorTeamSettings: "disabled" };

export type CloudBootCustomizationAdmission = {
  binding: CloudBootCustomizationBinding; snapshot: CloudBootCustomizationSnapshot;
  organizationRevision: number; memberRevision: number; repositoryDigest: string;
  digest: string; keyVersion: number; envelope: CloudAgentCredentialEnvelope;
};
export type CloudBootCustomizationStored = Omit<CloudBootCustomizationAdmission, "snapshot"> & { snapshot?: CloudBootCustomizationSnapshot };
function bootRevisions(rows: Awaited<ReturnType<typeof readCustomizationRows>>, actorUserId: string) {
  const organizationRevision = Number(rows.find(row => row.owner_user_id === null)?.revision ?? 0);
  const memberRevision = Number(rows.find(row => row.owner_user_id === actorUserId)?.revision ?? 0);
  if (![organizationRevision, memberRevision].every(value => Number.isSafeInteger(value) && value >= 0)) rejected();
  return { organizationRevision, memberRevision };
}

/** Called only after the boot endpoint positively confirms the real recorded
 * actor/funding grant. Locking and secret scope stay separate from provider
 * funding; this helper neither stores a fake lease nor grants actor authority. */
export async function admitBootCustomization(tx: Tx, value: CloudBootCustomizationBinding, repository: CloudMcpServer[], keys: CloudAgentCredentialKeys): Promise<CloudBootCustomizationAdmission> {
  const parsedBinding = CloudBootCustomizationBindingSchema.safeParse(value), parsedRepository = CloudRepositoryMcpSchema.safeParse(repository);
  if (!parsedBinding.success || !parsedRepository.success) return rejected();
  const binding = parsedBinding.data;
  await lockCustomization(tx, binding.organizationId);
  const rows = await readCustomizationRows(tx, binding.organizationId, binding.actorUserId);
  if (rows.some(row => row.org_id !== binding.organizationId || (row.owner_user_id !== null && row.owner_user_id !== binding.actorUserId))) return rejected();
  const revisions = bootRevisions(rows, binding.actorUserId);
  const servers = new Map<string, CloudBootCustomizationSnapshot["servers"][number]>();
  const skills = new Map<string, CloudCustomizationDocument["skills"][number]>();
  for (const row of rows) {
    const document = readCustomizationDocument(row, keys);
    for (const { id, ...server } of document.servers) servers.set(server.name, {
      server, scope: row.owner_user_id === null ? "organization" : "member", secretRef: id!, revision: Number(row.revision),
    });
    for (const skill of document.skills) skills.set(skill.name, skill);
  }
  // Accepted repository declarations replace only the same name. A replacing
  // entry never acquires another actor/source's environment or auth headers.
  for (const { id: _id, ...server } of parsedRepository.data) servers.set(server.name, { server, scope: "repository", secretRef: null, revision: 0 });
  if (servers.size > 64 || skills.size > 64) return rejected();
  const repositoryDigest = repositoryBootCustomizationDigest(parsedRepository.data, binding, keys.currentKeyVersion, keys);
  const content = { version: 1 as const, repositoryDigest,
    history: customizationHistoryAuthority(binding.organizationId, binding.workspaceId, binding.actorUserId, keys),
    servers: [...servers.values()].sort((a, b) => a.server.name.localeCompare(b.server.name)),
    skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)), cursorTeamSettings: "disabled" as const,
  };
  const snapshot = CloudBootCustomizationSnapshotSchema.parse({ ...content, digest: customizationDigest(content) });
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 768 * 1024) return rejected();
  const envelope = sealBootCustomization(snapshot, binding, keys);
  return { binding, snapshot, ...revisions, repositoryDigest, digest: snapshot.digest, keyVersion: keys.currentKeyVersion, envelope };
}

/** Reopens only the exact stored0140 context while actor-specific source
 * revisions and accepted repository set still match. The endpoint separately
 * rechecks recorded actor/engine/funding authority before AND after this. */
export async function validateBootCustomization(tx: Tx, value: CloudBootCustomizationBinding, stored: CloudBootCustomizationStored, repository: CloudMcpServer[], keys: CloudAgentCredentialKeys): Promise<CloudBootCustomizationSnapshot> {
  const parsedBinding = CloudBootCustomizationBindingSchema.safeParse(value), parsedRepository = CloudRepositoryMcpSchema.safeParse(repository);
  if (!parsedBinding.success || !parsedRepository.success || !isDeepStrictEqual(parsedBinding.data, stored.binding)) return rejected();
  const binding = parsedBinding.data;
  await lockCustomization(tx, binding.organizationId);
  const rows = await readCustomizationRows(tx, binding.organizationId, binding.actorUserId);
  if (rows.some(row => row.org_id !== binding.organizationId || (row.owner_user_id !== null && row.owner_user_id !== binding.actorUserId))) return rejected();
  const revisions = bootRevisions(rows, binding.actorUserId);
  if (stored.organizationRevision !== revisions.organizationRevision || stored.memberRevision !== revisions.memberRevision) return rejected();
  let snapshot: CloudBootCustomizationSnapshot;
  try {
    if (stored.repositoryDigest !== repositoryBootCustomizationDigest(parsedRepository.data, binding, stored.keyVersion, keys)) return rejected();
    snapshot = openBootCustomization(stored.envelope, binding, stored.keyVersion, keys);
  } catch { return rejected(); }
  const { digest, ...content } = snapshot;
  if (digest !== stored.digest || digest !== customizationDigest(content) || snapshot.repositoryDigest !== stored.repositoryDigest ||
      !snapshot.history || snapshot.history.owner !== customizationHistoryAuthority(binding.organizationId, binding.workspaceId, binding.actorUserId, keys).owner ||
      !isDeepStrictEqual(snapshot.servers.filter(entry => entry.scope === "repository").map(entry => entry.server), [...parsedRepository.data].sort((a, b) => a.name.localeCompare(b.name))) ||
      (stored.snapshot !== undefined && !isDeepStrictEqual(snapshot, stored.snapshot))) return rejected();
  return snapshot;
}
