import { createHash, randomUUID } from "node:crypto";
import {
  HttpError,
  requireOrganizationMembership,
  requireOrganizationRole,
} from "../authz.js";
import type { Tx } from "../db.js";
import { normalizeCloudWorkspaceSettingsDocument } from "./settings.js";

// Persisted identity/FK compatibility: enrollment retains an existing profile
// and its recipe. A new identity gets the historical empty version, never an
// executable recipe or an active image.
const empty = { repositories: [], installScript: "", timeoutSeconds: 900 };
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest();
function profileDocument(document: typeof empty) {
  return normalizeCloudWorkspaceSettingsDocument({
    values: { cloudComputer: document },
    setupCommands: [],
  }).document;
}
async function authority(
  tx: Tx,
  organizationId: string,
  userId: string,
  admin = false,
  lockRows = true,
) {
  if (admin) await requireOrganizationRole(tx, organizationId, userId, "admin");
  else await requireOrganizationMembership(tx, organizationId, userId);
  const row = (
    await tx.query<{ role: string }>(
      `SELECT member.role FROM organization_members member JOIN organizations org ON org.id=member.org_id
    WHERE member.org_id=$1 AND member.user_id=$2 AND NOT org.is_personal AND org.deleted_at IS NULL${lockRows ? " FOR SHARE OF org,member" : ""}`,
      [organizationId, userId],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(
      404,
      "not_found",
      "Cloud Computer is available only in organizations.",
    );
  // Membership may have changed since the preliminary role check. Use the
  // locked row so demotion cannot authorize a mutation with a stale role.
  if (admin && row.role !== "owner" && row.role !== "admin")
    throw new HttpError(403, "forbidden", "Requires admin role");
  return row;
}
async function lock(tx: Tx, org: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,62171))", [
    org,
  ]);
}
export {
  authority as requireCloudComputerAuthority,
  lock as lockCloudComputerOrganization,
};

/** V2 enrollment reuses the existing identity without rewriting a legacy
 * recipe or publishing it as a v2 build. Called under the organization lock. */
export async function ensureCloudComputerIdentity(
  tx: Tx,
  org: string,
  userId: string,
) {
  if (
    (await tx.query("SELECT 1 FROM cloud_computers WHERE org_id=$1", [org]))
      .rowCount
  )
    return;
  const profileId = randomUUID();
  await tx.query(
    `INSERT INTO environment_profiles(id,org_id,owner_kind,name,placement,is_default,current_version)
    VALUES($1,$2,'organization',$3,'cloud',false,1)`,
    [profileId, org, `Cloud Computer ${profileId.slice(0, 8)}`],
  );
  await tx.query(
    `INSERT INTO environment_profile_versions(profile_id,org_id,version,document,created_by)
    VALUES($1,$2,1,$3::jsonb,$4)`,
    [profileId, org, JSON.stringify(profileDocument(empty)), userId],
  );
  await tx.query(
    `INSERT INTO cloud_computers(org_id,profile_id,draft_version,operation_id,request_sha256)
    VALUES($1,$2,1,$3,$4)`,
    [org, profileId, randomUUID(), digest({ document: empty })],
  );
}
