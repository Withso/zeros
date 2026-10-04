import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx, type Tx } from "../db.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import {
  persistDatabaseCloudWorkspaceSettings,
  type DatabaseResolvedCloudWorkspaceSettings,
} from "./settings.js";

type Fixture = { organizationId: string; workspaceId: string; userId: string };
export async function pinTestComputerEnvironment(
  pool: pg.Pool,
  fixture: Fixture,
  key: string,
  values: Record<string, string>,
) {
  const service = new DatabaseCloudComputerV2Service(pool, {
    settingsSecretKeyV1: key,
  } as CloudWorkspaceBackendConfig);
  const built = await service.build(fixture.organizationId, fixture.userId, {
    expectedRevision: 0,
    operationId: randomUUID(),
    draft: {
      repositories: [],
      installScript: "",
      timeoutSeconds: 900,
      environment: Object.entries(values).map(([name, value]) => ({
        op: "set",
        name,
        value,
      })),
    },
  });
  const pins = {
    baseImageId: "fixture-base",
    runtimeId: "fixture-runtime",
    repositoryManifest: [],
  };
  await service.claimNextBuild(1);
  await service.markBuildStage(built.build.id, 1, "capture_confirmed", pins);
  await service.completeBuild(built.build.id, 1, {
    ...pins,
    template: {
      providerResourceId: null,
      accountScope: null,
      billingOrg: null,
      protectedContractDigest: "f".repeat(64),
      stoppedAt: new Date().toISOString(),
    },
  });
  await withSystemTx(pool, (tx) =>
    tx.query(
      `INSERT INTO cloud_workspace_computer_sources(workspace_id,generation,org_id,build_id,template_id,config_id)
    VALUES($1,1,$2,$3,$3,$4)`,
      [
        fixture.workspaceId,
        fixture.organizationId,
        built.build.id,
        built.build.configId,
      ],
    ),
  );
  return { service, configId: built.build.configId };
}

/** Replace only the disposable fixture's placeholder settings through real
 * persistence. Production never updates an immutable generation snapshot. */
export async function persistTestComputerSettings(
  pool: pg.Pool,
  fixture: Fixture,
  settings: DatabaseResolvedCloudWorkspaceSettings,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Only the disposable database owner can replace an immutable fixture.
    // Suppress cascades so its admitted engine/session fixture stays intact.
    await client.query("SET LOCAL session_replication_role=replica");
    const tx = client as Tx;
    const spec = (
      await tx.query(
        "SELECT * FROM cloud_workspace_setup_specs WHERE workspace_id=$1 AND generation=1",
        [fixture.workspaceId],
      )
    ).rows[0];
    await tx.query(
      "DELETE FROM cloud_workspace_setup_specs WHERE workspace_id=$1 AND generation=1",
      [fixture.workspaceId],
    );
    await tx.query(
      "DELETE FROM workspace_settings_versions WHERE workspace_id=$1 AND generation=1",
      [fixture.workspaceId],
    );
    await tx.query(
      "DELETE FROM cloud_workspace_setup_secrets WHERE workspace_id=$1 AND generation=1",
      [fixture.workspaceId],
    );
    const snapshot = await persistDatabaseCloudWorkspaceSettings(tx, {
      ...fixture,
      generation: 1,
      actorUserId: fixture.userId,
      settings,
    });
    await tx.query(
      `INSERT INTO cloud_workspace_setup_specs(workspace_id,generation,org_id,repository_forge,repository_owner,repository_name,repository_revision,
      github_installation_id,settings_snapshot,settings_snapshot_sha256,workspace_settings_version_id)
      VALUES($1,1,$2,$3,$4,$5,$6,$7,$8::jsonb,decode($9,'hex'),$10)`,
      [
        fixture.workspaceId,
        fixture.organizationId,
        spec.repository_forge,
        spec.repository_owner,
        spec.repository_name,
        spec.repository_revision,
        spec.github_installation_id,
        snapshot.document,
        snapshot.sha256,
        snapshot.id,
      ],
    );
    for (const secret of settings.setupSecrets)
      await tx.query(
        `INSERT INTO cloud_workspace_setup_secrets(id,workspace_id,generation,org_id,name,key_version,nonce,ciphertext,auth_tag)
      VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)`,
        [
          secret.id,
          fixture.workspaceId,
          fixture.organizationId,
          secret.name,
          secret.keyVersion,
          secret.nonce,
          secret.ciphertext,
          secret.authTag,
        ],
      );
    await client.query("COMMIT");
    return snapshot;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function consentTestPersonalEnvironment(
  pool: pg.Pool,
  organizationId: string,
  userId: string,
  values: Record<string, string>,
  allowedPaths = ["/values/env"],
) {
  const personalOrg = randomUUID(),
    profileId = randomUUID(),
    consentId = randomUUID();
  await withSystemTx(pool, async (tx) => {
    const existing = (
      await tx.query<{ id: string }>(
        "SELECT id FROM organizations WHERE created_by=$1 AND is_personal AND deleted_at IS NULL",
        [userId],
      )
    ).rows[0];
    const org = existing?.id ?? personalOrg;
    if (!existing)
      await tx.query(
        "INSERT INTO organizations(id,slug,name,is_personal,created_by,cloud_workspaces_allowed) VALUES($1,$2,'Personal fixture',true,$3,false)",
        [org, `personal-${org}`, userId],
      );
    await tx.query(
      `INSERT INTO environment_profiles(id,org_id,owner_kind,owner_user_id,name,placement,is_default,current_version)
      VALUES($1,$2,'user',$3,'Personal fixture','cloud',true,1)`,
      [profileId, org, userId],
    );
    await tx.query(
      `INSERT INTO environment_profile_versions(profile_id,org_id,version,document,created_by) VALUES($1,$2,1,$3::jsonb,$4)`,
      [
        profileId,
        org,
        JSON.stringify({
          values: { env: values, editor: { fontSize: 13 } },
          setupCommands: [
            { command: "never-personal-hook", timeoutSeconds: 1 },
          ],
        }),
        userId,
      ],
    );
    await tx.query(
      `INSERT INTO personal_profile_inheritance_consents(id,org_id,user_id,personal_profile_id,personal_profile_version,allowed_paths)
      VALUES($1,$2,$3,$4,1,$5::jsonb)`,
      [
        consentId,
        organizationId,
        userId,
        profileId,
        JSON.stringify(allowedPaths),
      ],
    );
  });
  return consentId;
}
