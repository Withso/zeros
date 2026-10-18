import type pg from "pg";

import { withSystemTx, type Tx } from "../db.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { queryCloudWorkspaceCatalog, readCatalogVersion, workspaceDocument } from "../cloud-workspaces/routes.js";
import type { RolloutFlagReader } from "../rollout-flags.js";

/** A device-stream re-read covers at most this many workspaces per account,
 * the same bound as `hello.resume.workspaces`. */
export const DEVICE_STREAM_MAX_CATALOG = 1_000;

/** One workspace as the account currently sees it. */
export type DeviceStreamWorkspace = Readonly<{
  id: string;
  organizationId: string;
  ownerUserId: string;
  version: number;
  status: string;
  generation: number;
  observedState: string;
  /** The `GET /v1/cloud-workspaces` document, unchanged. */
  document: Readonly<Record<string, unknown>>;
}>;

export type DeviceStreamCatalogRead = Readonly<{
  /** `cloud_catalog_version_seq`, read before the rows. */
  catalogVersion: number;
  /** The account's `readDeviceStreamOrganizations`, read in the same transaction. */
  organizationIds: readonly string[];
  workspaces: readonly DeviceStreamWorkspace[];
  /** False when the account has more workspaces than one read covers; the
   * stream then never infers a removal from absence. */
  complete: boolean;
}>;

/** Durable reads behind the device stream. Rows are authoritative; change
 * notifications and security events only say what to re-read. */
export interface DeviceStreamCatalogSource {
  /** The account's current catalog (the exact `GET /v1/cloud-workspaces`
   * access set), optionally restricted to `workspaceIds`. */
  read(accountUserId: string, workspaceIds: readonly string[] | null): Promise<DeviceStreamCatalogRead>;
  /** The subset of `accountUserIds` that may have gained access to any of
   * `workspaceIds` (owner, organization member or guest). A superset is
   * fine: `read` decides. */
  candidates(workspaceIds: readonly string[], accountUserIds: readonly string[]): Promise<Set<string>>;
  /** The subset of `accountUserIds` that are members of the organization. */
  organizationAccounts(organizationId: string, accountUserIds: readonly string[]): Promise<Set<string>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ORGANIZATIONS = 1_000;

/** The organizations whose `device_stream` flag admits an account: those it
 * is a member of and those it holds a live guest grant in. Past the bound an
 * account can only be refused the stream, never admitted by mistake. */
export async function readDeviceStreamOrganizations(tx: Tx, accountUserId: string): Promise<string[]> {
  if (!UUID.test(accountUserId)) return [];
  const rows = await tx.query<{ org_id: string }>(
    `SELECT org_id::text AS org_id FROM organization_members WHERE user_id = $1
     UNION SELECT org_id::text FROM cloud_workspace_guest_grants
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
     LIMIT ${MAX_ORGANIZATIONS}`, [accountUserId]);
  return rows.rows.map(row => row.org_id);
}

/** `device_stream` is per organization: an account streams while any of its
 * organizations has it on. `anyEnabled` only decides whether a process mounts
 * the stream at all. */
export function deviceStreamAdmits(flags: RolloutFlagReader, organizationIds: Iterable<string>): boolean {
  for (const organizationId of organizationIds) if (flags.enabled(organizationId, "device_stream")) return true;
  return false;
}

export class DatabaseDeviceStreamCatalogSource implements DeviceStreamCatalogSource {
  constructor(private readonly pool: pg.Pool, private readonly config: CloudWorkspaceBackendConfig | null) {}

  read(accountUserId: string, workspaceIds: readonly string[] | null): Promise<DeviceStreamCatalogRead> {
    const ids = workspaceIds?.filter(id => UUID.test(id)) ?? null;
    return withSystemTx(this.pool, async tx => {
      const catalogVersion = await readCatalogVersion(tx);
      const organizationIds = await readDeviceStreamOrganizations(tx, accountUserId);
      if (ids && ids.length === 0) return { catalogVersion, organizationIds, workspaces: [], complete: true };
      const rows = await queryCloudWorkspaceCatalog(tx, {
        orgId: null, userId: accountUserId, limit: DEVICE_STREAM_MAX_CATALOG + 1, cursor: null,
        ...(ids ? { workspaceIds: ids } : {}),
      });
      const complete = rows.length <= DEVICE_STREAM_MAX_CATALOG;
      const workspaces = rows.slice(0, DEVICE_STREAM_MAX_CATALOG).map(row => {
        const document = workspaceDocument(row, this.config);
        return Object.freeze({
          id: document.id, organizationId: document.organizationId, ownerUserId: document.ownerUserId,
          version: document.version, status: document.status,
          generation: Number(document.generation.number ?? 0), observedState: document.generation.observedState ?? "unknown",
          document: document as Record<string, unknown>,
        });
      });
      return { catalogVersion, organizationIds, workspaces, complete };
    });
  }

  async candidates(workspaceIds: readonly string[], accountUserIds: readonly string[]): Promise<Set<string>> {
    const workspaces = workspaceIds.filter(id => UUID.test(id)), accounts = accountUserIds.filter(id => UUID.test(id));
    if (workspaces.length === 0 || accounts.length === 0) return new Set();
    const rows = await withSystemTx(this.pool, tx => tx.query<{ user_id: string }>(
      `SELECT DISTINCT access.user_id FROM (
         SELECT cw.owner_user_id AS user_id FROM cloud_workspaces cw WHERE cw.id = ANY($1::uuid[])
         UNION ALL SELECT member.user_id FROM organization_members member
           JOIN cloud_workspaces cw ON cw.org_id = member.org_id WHERE cw.id = ANY($1::uuid[])
         UNION ALL SELECT grantee.user_id FROM cloud_workspace_guest_grants grantee WHERE grantee.workspace_id = ANY($1::uuid[])
       ) access WHERE access.user_id = ANY($2::uuid[])`, [workspaces, accounts]));
    return new Set(rows.rows.map(row => row.user_id));
  }

  async organizationAccounts(organizationId: string, accountUserIds: readonly string[]): Promise<Set<string>> {
    const accounts = accountUserIds.filter(id => UUID.test(id));
    if (!UUID.test(organizationId) || accounts.length === 0) return new Set();
    const rows = await withSystemTx(this.pool, tx => tx.query<{ user_id: string }>(
      "SELECT user_id FROM organization_members WHERE org_id = $1 AND user_id = ANY($2::uuid[])", [organizationId, accounts]));
    return new Set(rows.rows.map(row => row.user_id));
  }
}
