import { createHash, createHmac } from "node:crypto";
import { bootstrapFixtureOrganization, fixtureIssues } from "./hosted-fixtures.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fresh = value => Number.isFinite(value) && value <= Date.now() && Date.now() - value < 60_000;
const uuid = value => {
  const bytes = Buffer.from(value, "hex").subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export async function assertLocalDatabaseOwner(pool, request) {
  const { rows } = await pool.query("SELECT owner,instance_id FROM public.zeros_cloud_local_identity");
  if (rows.length !== 1 || rows[0].owner !== request.owner || rows[0].instance_id !== request.instanceId)
    throw new Error("The local database belongs to another instance; existing resources were preserved");
}

async function assertLocalStaffTarget(migration, request) {
  let target;
  try { target = new URL(request.migrationUrl); } catch { /* Refuse without echoing a connection string. */ }
  if (!target || !["postgres:", "postgresql:"].includes(target.protocol) || target.hostname !== "127.0.0.1")
    throw new Error("The local staff seed requires a loopback database");
  await assertLocalDatabaseOwner(migration, request);
  const { rows } = await migration.query("SELECT current_database() AS database,host(inet_server_addr()) AS address,inet_server_port() AS port");
  if (rows[0]?.database !== decodeURIComponent(target.pathname.slice(1)) || rows[0]?.address !== "127.0.0.1" ||
      rows[0]?.port !== Number(target.port || 5432)) throw new Error("The local staff seed database does not match its target");
}

async function grantLocalStaff(migration, request, userId, organizationId, staff) {
  const input = { databaseUrl: request.migrationUrl, channel: "development", execute: false,
    subjectUserId: userId, expectedEmail: request.fixture.expectedEmail, actorUserId: userId,
    nextRole: "developer", ownerOrganizationId: organizationId,
    reason: `Isolated electron:cloud fixture for instance ${request.instanceId}` };
  const plan = await staff.manageStaffRole(migration, staff.validateStaffRoleRequest(input));
  // Preserve a stronger role explicitly granted by this instance's operator.
  if (plan.previousRole === "platform_owner") return "platform_owner";
  if (plan.state !== "unchanged") await staff.manageStaffRole(migration,
    staff.validateStaffRoleRequest({ ...input, execute: true, approval: plan.approval }));
  return "developer";
}

/** Read-only proof that this Alpha App installation includes the selected
 * repository. The App key never leaves the caller or enters the local DB. */
export async function verifyLocalGithub({ installationId, repository, appId }, request) {
  if (!Number.isSafeInteger(installationId) || installationId < 1 || !Number.isSafeInteger(appId) || appId < 1 ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) throw new Error("Configure the local test GitHub installation and repository");
  const [owner, name] = repository.split("/");
  const row = await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`);
  if (row?.id !== installationId || row.app_id !== appId || row.suspended_at ||
      row.account?.login?.toLowerCase() !== owner.toLowerCase() || !["User", "Organization"].includes(row.account.type) ||
      !["User", "Organization"].includes(row.target_type) || !["all", "selected"].includes(row.repository_selection) ||
      !Number.isFinite(Date.parse(row.created_at))) throw new Error("Could not verify the local test GitHub installation");
  return { installationId, appId, repository, accountLogin: row.account.login, accountType: row.account.type,
    targetType: row.target_type, allRepositories: row.repository_selection === "all", createdAt: row.created_at, verifiedAt: Date.now() };
}

/** Dedicated test API keys/setup token only. Never duplicate a shared Codex
 * ChatGPT refresh token into a second database. Settings can import a login. */
export function localFixtureCredentials(env) {
  return [
    env.ANTHROPIC_API_KEY ? { provider: "claude", material: { kind: "claude-api-key", apiKey: env.ANTHROPIC_API_KEY } }
      : env.CLAUDE_CODE_OAUTH_TOKEN ? { provider: "claude", material: { kind: "claude-setup-token", accessToken: env.CLAUDE_CODE_OAUTH_TOKEN } } : null,
    env.OPENAI_API_KEY ? { provider: "codex", material: { kind: "codex-api-key", apiKey: env.OPENAI_API_KEY } } : null,
    env.CURSOR_API_KEY ? { provider: "cursor", material: { kind: "cursor-api-key", apiKey: env.CURSOR_API_KEY } } : null,
  ].filter(Boolean);
}

async function grantLocalPro(migration, { userId, fixture, source }) {
  const client = await migration.connect();
  try {
    await client.query("BEGIN; SELECT set_config('app.system','on',true)");
    const authority = await client.query("SELECT current_user=pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='public.account_entitlements'::regclass");
    if (authority.rows[0]?.owner !== true) throw new Error("Local fixture requires the database migration owner");
    // A bounded test entitlement in this isolated database, without a
    // billing/provider write. Repeated seed never extends its period.
    await client.query(`INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source,source_reference,valid_from,valid_until)
      VALUES($1,'pro','active',true,'operator',$2,$3,$4) ON CONFLICT(user_id) DO NOTHING`,
    [userId, source, fixture.startsAt, fixture.endsAt]);
    const result = await client.query("SELECT account_pro_user_live($1) AS live", [userId]);
    if (result.rows[0]?.live !== true) throw new Error("The local account has a conflicting or expired entitlement; existing authority was preserved");
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

/** Called only after database.mjs proves the local DB's owner/instance marker.
 * WorkOS identity must already exist from normal sign-in. Material enters the
 * same validated, encrypted vault API that Settings uses, never raw SQL. */
export async function seedLocalFixture({ runtime, migration, withSystemTx, request, vault, models, staff }) {
  await assertLocalStaffTarget(migration, request);
  await assertLocalDatabaseOwner(runtime, request);
  const { fixture, fixtureProof: proof, githubProof: github } = request;
  if (fixtureIssues(fixture).length || fixture?.bootstrapOrganization !== true || fixture.computeAllowance !== "pro-monthly" ||
      !/^[a-f0-9]{24}$/.test(request.owner ?? "") || !UUID.test(request.instanceId ?? "") ||
      !Number.isFinite(Date.parse(fixture.startsAt)) || !Number.isFinite(Date.parse(fixture.endsAt)) ||
      Date.parse(fixture.startsAt) > Date.now() || Date.parse(fixture.endsAt) <= Date.now() ||
      Date.parse(fixture.endsAt) - Date.parse(fixture.startsAt) > 7 * 86400_000 ||
      !fresh(github?.verifiedAt) || !Number.isSafeInteger(github.installationId) || github.installationId < 1 ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(github.repository ?? "") ||
      github.accountLogin?.toLowerCase() !== github.repository.split("/")[0].toLowerCase() ||
      !["User", "Organization"].includes(github.accountType) || !["User", "Organization"].includes(github.targetType) ||
      typeof github.allRepositories !== "boolean" || !Number.isFinite(Date.parse(github.createdAt))) throw new Error("Invalid local fixture authority");
  if (!await bootstrapFixtureOrganization({ runtime, withSystemTx, fixture, proof })) return { seeded: false, needsSignIn: true };
  const row = await withSystemTx(runtime, async tx => (await tx.query(`SELECT u.id AS user_id FROM users u
    JOIN user_identities i ON i.user_id=u.id AND i.provider='workos' AND i.provider_sub=$1 AND i.status='active' AND i.email_verified_at IS NOT NULL
    JOIN organization_members m ON m.user_id=u.id AND m.org_id=$2 AND m.role='owner'
    WHERE u.auth_status='active' AND u.deleted_at IS NULL AND lower(u.email::text)=$3`,
  [fixture.workosUserId, proof.externalId, fixture.expectedEmail.toLowerCase()])).rows[0]);
  if (!row) throw new Error("The local signed-in identity changed; seed stopped");
  const userId = row.user_id, organizationId = proof.externalId;
  const staffRole = await grantLocalStaff(migration, request, userId, organizationId, staff);
  await grantLocalPro(migration, { userId, fixture, source: `cloud-local:${request.owner}:${request.instanceId}` });
  await withSystemTx(runtime, async tx => {
    const installation = await tx.query(`INSERT INTO github_installations(github_installation_id,app_variant,owner_user_id,
      account_login,account_type,target_type,repository_count,all_repositories,github_created_at,last_verified_at)
      VALUES($1,'github.com',$2,$3,$4,$5,1,$6,$7,now())
      ON CONFLICT(app_variant,github_installation_id,owner_user_id) WHERE owner_user_id IS NOT NULL
      DO UPDATE SET account_login=EXCLUDED.account_login,account_type=EXCLUDED.account_type,target_type=EXCLUDED.target_type,
        all_repositories=EXCLUDED.all_repositories,suspended_at=NULL,last_verified_at=now(),updated_at=now() RETURNING id`,
    [github.installationId, userId, github.accountLogin, github.accountType, github.targetType, github.allRepositories, github.createdAt]);
    await tx.query(`INSERT INTO cloud_github_connections(org_id,owner_user_id,installation_id) VALUES($1,$2,$3)
      ON CONFLICT(org_id,owner_user_id,installation_id) DO UPDATE SET verified_at=now()`, [organizationId, userId, installation.rows[0].id]);
  });
  const providers = [];
  for (const { provider, material } of request.credentials ?? []) {
    if (!["claude", "codex", "cursor"].includes(provider) || providers.includes(provider) ||
        typeof material?.kind !== "string" || !material.kind.startsWith(`${provider}-`)) throw new Error("Invalid local provider selection");
    const credentialId = uuid(createHash("sha256").update(JSON.stringify([request.owner, request.instanceId, userId, provider])).digest("hex"));
    const operationId = uuid(createHmac("sha256", Buffer.from(request.encryptionKey, "base64url"))
      .update(JSON.stringify([credentialId, material])).digest("hex"));
    const previous = await withSystemTx(runtime, async tx => (await tx.query(
      "SELECT revision,last_operation_id FROM cloud_agent_credentials WHERE id=$1 AND owner_user_id=$2 AND revoked_at IS NULL", [credentialId, userId])).rows[0]);
    const credentialRevision = previous?.last_operation_id === operationId ? Number(previous.revision) :
      (await vault.put({ ownerUserId: userId, organizationId, credentialId, operationId, expectedRevision: Number(previous?.revision ?? 0),
        displayName: `Cloud local ${provider}`, material })).credential.revision;
    const connection = (await vault.organizationConnections(userId, organizationId)).connections.find(row => row.provider === provider);
    // A user's later Settings choice wins over the launcher's fixture.
    if (!connection || connection.credentialId === credentialId) {
      if (!connection?.connected || previous?.last_operation_id !== operationId) await vault.setOrganizationConnection(userId, organizationId, provider, {
        expectedRevision: connection?.revision ?? 0, credentialId, credentialRevision,
        models: [...models(provider)], allModels: true, consent: "zeros-managed",
      });
    }
    providers.push(provider);
  }
  return { seeded: true, userId, organizationId, providers, staffRole };
}
