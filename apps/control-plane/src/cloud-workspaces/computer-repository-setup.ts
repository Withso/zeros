import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import type { UpdateRepositorySetupScript } from "./computer-tools.js";
import {
  lockCloudComputerOrganization,
  requireCloudComputerAuthority,
} from "./computer-identity.js";
import {
  CloudComputerV2RepositorySchema,
  CloudComputerV2RepositorySetupSchema,
  type CloudComputerV2RepositorySetupResult,
} from "./computer-v2-contract.js";
import {
  normalizeCloudWorkspaceSettingsDocument,
  type CloudWorkspaceSettingsDocument,
} from "./settings.js";

/** Also called by the Phase D tool. The actor is authenticated by the caller;
 * active-account and organization authority are always checked here. The public
 * repository ID is GitHub's canonical ID, matching the computer configuration. */
export async function updateRepositorySetupScript(
  pool: pg.Pool,
  organizationId: string,
  actorUserId: string,
  repositoryId: string,
  value: unknown,
  transaction?: Tx,
): Promise<CloudComputerV2RepositorySetupResult> {
  const parsed = CloudComputerV2RepositorySetupSchema.safeParse(value);
  if (
    !parsed.success ||
    !CloudComputerV2RepositorySchema.shape.id.safeParse(repositoryId).success
  )
    throw new HttpError(
      422,
      "invalid_input",
      "Invalid repository setup input.",
    );
  const input = parsed.data;
  const write = async (tx: Tx) => {
    const account = (
      await tx.query(
        "SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL AND auth_status='active' FOR SHARE",
        [actorUserId],
      )
    ).rows[0];
    if (!account)
      throw new HttpError(
        404,
        "not_found",
        "Cloud Computer not found",
      );
    await requireCloudComputerAuthority(tx, organizationId, actorUserId, true);
    await lockCloudComputerOrganization(tx, organizationId);
    const selected = (
      await tx.query<{
        repository_owner: string;
        repository_name: string;
        installation_id: string;
      }>(
        `SELECT repo.repository_owner,repo.repository_name,repo.installation_id
       FROM cloud_computer_v2_heads head
       LEFT JOIN cloud_computer_v2_builds active ON active.id=head.active_build_id AND active.org_id=head.org_id
       JOIN cloud_computer_v2_config_repositories repo ON repo.org_id=head.org_id
         AND repo.config_id IN (head.draft_config_id,active.config_id)
       WHERE head.org_id=$1 AND repo.repository_id=$2
       ORDER BY (repo.config_id=head.draft_config_id) DESC LIMIT 1`,
        [organizationId, repositoryId],
      )
    ).rows[0];
    if (!selected)
      throw new HttpError(
        404,
        "not_found",
        "Repository is not selected for this Cloud Computer.",
      );
    // A selected repository can have a setup hook before its first workspace.
    // Preserve all metadata on an existing canonical row; this no-op update
    // takes the same repository lock as the generic settings writer.
    const repository = (
      await tx.query<{ id: string }>(
        `INSERT INTO repositories(org_id,forge,forge_repository_id,identity_state,owner_name,repository_name,github_installation_id,created_by)
       VALUES($1,'github.com',$2,'verified',$3,$4,$5,$6)
       ON CONFLICT (org_id,forge,forge_repository_id) WHERE deleted_at IS NULL
       DO UPDATE SET forge_repository_id=repositories.forge_repository_id RETURNING id`,
        [
          organizationId,
          repositoryId,
          selected.repository_owner,
          selected.repository_name,
          selected.installation_id,
          actorUserId,
        ],
      )
    ).rows[0]!;
    const current = (
      await tx.query<{
        current_version: string;
        document: CloudWorkspaceSettingsDocument;
      }>(
        `SELECT head.current_version,version.document FROM repository_settings_heads head
       JOIN repository_settings_versions version ON version.org_id=head.org_id AND version.repository_id=head.repository_id
         AND version.scope=head.scope AND version.version=head.current_version
       WHERE head.org_id=$1 AND head.repository_id=$2 AND head.scope='cloud' FOR UPDATE OF head`,
        [organizationId, repository.id],
      )
    ).rows[0];
    const currentVersion = Number(current?.current_version ?? 0);
    // ACD-6: this settings write is CAS-only. operationId is an audit identity,
    // not permission to replay over another admin's intervening settings.
    if (currentVersion !== input.expectedSettingsVersion)
      throw new HttpError(
        409,
        "cloud_settings_version_conflict",
        "Cloud settings changed; reload before saving",
        { currentVersion },
      );
    const version = currentVersion + 1;
    const document = normalizeCloudWorkspaceSettingsDocument({
      ...(current?.document ?? { values: {} }),
      setupCommands: input.script.trim()
        ? [{ command: input.script, timeoutSeconds: input.timeoutSeconds }]
        : [],
    });
    await tx.query(
      `INSERT INTO repository_settings_versions(org_id,repository_id,scope,version,schema_version,document,created_by)
      VALUES($1,$2,'cloud',$3,1,$4::jsonb,$5)`,
      [
        organizationId,
        repository.id,
        version,
        document.canonicalJson,
        actorUserId,
      ],
    );
    await tx.query(
      `INSERT INTO repository_settings_heads(org_id,repository_id,scope,current_version) VALUES($1,$2,'cloud',$3)
      ON CONFLICT (org_id,repository_id,scope) DO UPDATE SET current_version=EXCLUDED.current_version,updated_at=now()`,
      [organizationId, repository.id, version],
    );
    await tx.query(
      `INSERT INTO audit_log(org_id,actor_id,action,subject) VALUES($1,$2,'cloud_computer_v2.repository_setup_updated',$3::jsonb)`,
      [
        organizationId,
        actorUserId,
        JSON.stringify({
          repositoryId,
          version,
          operationId: input.operationId,
        }),
      ],
    );
    await tx.query(
      `INSERT INTO cloud_workspace_outbox(org_id,event_type,aggregate_key,aggregate_revision,idempotency_key,payload)
      VALUES($1,'cloud_settings.repository_updated',$2,$3,$4,$5::jsonb) ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        organizationId,
        `repository-settings:${repository.id}:cloud`,
        version,
        `repository-settings:${repository.id}:cloud:${version}`,
        JSON.stringify({
          repositoryId: repository.id,
          scope: "cloud",
          version,
        }),
      ],
    );
    return { repositoryId, version };
  };
  return transaction ? write(transaction) : withSystemTx(pool, write);
}

/** The admin tool identifies the canonical repository row by UUID. Translate
 * inside its authority transaction; the shared writer still checks the active
 * or draft selection and settings CAS using the GitHub repository identity. */
export function createRepositorySetupScriptWriter(pool: pg.Pool): UpdateRepositorySetupScript {
  return async ({ orgId, repositoryId, actorUserId, ...input }, tx) => {
    const repository = (await tx.query<{ forge_repository_id: string }>(
      `SELECT forge_repository_id FROM repositories WHERE org_id=$1 AND id=$2
        AND forge='github.com' AND deleted_at IS NULL AND forge_repository_id IS NOT NULL FOR SHARE`,
      [orgId, repositoryId],
    )).rows[0];
    if (!repository) throw new HttpError(403, "forbidden", "Repository is unavailable.");
    const { version } = await updateRepositorySetupScript(pool, orgId, actorUserId, repository.forge_repository_id, input, tx);
    return { version };
  };
}
