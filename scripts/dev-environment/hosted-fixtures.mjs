import { sha256 } from "./state.mjs";

/** Explicit test authority, confined to one already authenticated WorkOS
 * member of a collaborative organization in this disposable database. */
export function fixtureIssues(fixture) {
  if (fixture === undefined) return [];
  // Keep the retired pilot field readable so its original profile can still
  // archive an existing generation. Never silently turn its budget into Pro.
  const funding = fixture?.computeAllowance === "pro-monthly" && fixture.computeCreditMicroUsd === undefined ||
    fixture?.computeAllowance === undefined && Number.isSafeInteger(fixture?.computeCreditMicroUsd) &&
      fixture.computeCreditMicroUsd >= 1 && fixture.computeCreditMicroUsd <= 10_000_000;
  return fixture && /^user_[A-Za-z0-9]+$/.test(fixture.workosUserId ?? "") &&
    /^org_[A-Za-z0-9]+$/.test(fixture.workosOrganizationId ?? "") &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fixture.expectedEmail ?? "") &&
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(fixture.expectedOrganizationSlug ?? "") &&
    (fixture.bootstrapOrganization === undefined || typeof fixture.bootstrapOrganization === "boolean") &&
    funding
    ? [] : ['fixture: select one WorkOS user/Organization, expected email/slug, and computeAllowance "pro-monthly"; retired computeCreditMicroUsd profiles remain readable only for cleanup'];
}

export function assertCurrentFixtureFunding(fixture) {
  if (fixture && fixture.computeAllowance !== "pro-monthly") throw new Error(
    'The retired organization compute credit conflicts with current Pro funding. Review the standard Pro monthly allowance, archive this generation, then replace computeCreditMicroUsd with computeAllowance: "pro-monthly" in the private profile. No budget was increased automatically.');
}

export function bindFixture(state, fixture) {
  if (!fixture || fixtureIssues(fixture).length) throw new Error("Configure an explicit test organization in the private profile's fixture section before dev:seed");
  const digest = sha256(JSON.stringify([fixture.workosUserId, fixture.workosOrganizationId,
    fixture.expectedEmail.toLowerCase(), fixture.expectedOrganizationSlug, fixture.computeAllowance ?? fixture.computeCreditMicroUsd,
    ...(fixture.bootstrapOrganization ? [true] : [])]));
  if (state.fixture && state.fixture.digest !== digest) throw new Error("The Dev fixture changed; archive before selecting a different test authority or credit budget");
  const now = Date.now();
  state.fixture ??= { digest, startsAt: new Date(now).toISOString(), endsAt: new Date(now + 7 * 86400_000).toISOString() };
  if (Date.parse(state.fixture.endsAt) <= Date.now()) throw new Error("Dev fixture expired; archive and launch a fresh generation to reset it");
  return { ...fixture, ...state.fixture };
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Only an explicitly selected, provider-owned Dev organization can be
 * imported into an empty disposable database. No user identity is fabricated. */
export async function verifyFixtureMembership(fixture, request) {
  if (fixtureIssues(fixture).length || fixture.bootstrapOrganization !== true) throw new Error("Invalid Dev organization verification request");
  const [user, org, memberships] = await Promise.all([
    request(`/user_management/users/${fixture.workosUserId}`),
    request(`/organizations/${fixture.workosOrganizationId}`),
    request(`/user_management/organization_memberships?user_id=${fixture.workosUserId}&organization_id=${fixture.workosOrganizationId}&limit=100`),
  ]);
  const member = memberships?.data?.[0];
  if (user?.id !== fixture.workosUserId || user.email?.toLowerCase() !== fixture.expectedEmail.toLowerCase() || user.email_verified !== true ||
      org?.id !== fixture.workosOrganizationId || !UUID.test(org.external_id ?? "") || org.metadata?.purpose !== "zeros-development" ||
      typeof org.name !== "string" || !org.name.trim() || org.name.length > 100 ||
      memberships?.data?.length !== 1 || memberships.list_metadata?.after || !/^om_[A-Za-z0-9]+$/.test(member?.id ?? "") ||
      member.user_id !== user.id || member.organization_id !== org.id || member.status !== "active" || member.role?.slug !== "owner" ||
      !Number.isFinite(Date.parse(member.updated_at))) throw new Error("Could not verify the selected Dev organization and active owner membership");
  return { userId: user.id, email: user.email.toLowerCase(), organizationId: org.id, externalId: org.external_id,
    name: org.name, membershipId: member.id, membershipUpdatedAt: member.updated_at, verifiedAt: Date.now() };
}

export async function bootstrapFixtureOrganization({ runtime, withSystemTx, fixture, proof }) {
  if (!proof || proof.userId !== fixture.workosUserId || proof.email !== fixture.expectedEmail.toLowerCase() ||
      proof.organizationId !== fixture.workosOrganizationId || !UUID.test(proof.externalId ?? "") ||
      !/^om_[A-Za-z0-9]+$/.test(proof.membershipId ?? "") || typeof proof.name !== "string" || !proof.name.trim() || proof.name.length > 100 ||
      !Number.isFinite(Date.parse(proof.membershipUpdatedAt)) || !Number.isFinite(proof.verifiedAt) ||
      proof.verifiedAt > Date.now() || Date.now() - proof.verifiedAt > 60_000) throw new Error("Invalid or expired Dev organization proof");
  return withSystemTx(runtime, async tx => {
    const users = await tx.query(`SELECT u.id AS user_id, u.email::text AS email FROM user_identities i JOIN users u ON u.id=i.user_id
      WHERE i.provider='workos' AND i.provider_sub=$1 AND i.status='active' AND u.auth_status='active' AND u.deleted_at IS NULL FOR UPDATE OF u`, [fixture.workosUserId]);
    if (!users.rows.length) return false;
    if (users.rows.length !== 1 || users.rows[0].email.toLowerCase() !== proof.email) throw new Error("The signed-in Dev account differs from the selected fixture");
    const userId = users.rows[0].user_id, orgId = proof.externalId;
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`dev-fixture:${orgId}`]);
    const existing = await tx.query(`SELECT o.id, o.slug, o.created_by, o.is_personal, o.cloud_workspaces_allowed, o.deleted_at, o.lifecycle_status,
      link.workos_organization_id, link.state AS link_state, member.role, member.workos_membership_id
      FROM organizations o LEFT JOIN workos_organization_links link ON link.organization_id=o.id
      LEFT JOIN organization_members member ON member.org_id=o.id AND member.user_id=$2
      WHERE o.id=$1 OR o.slug=$3 OR link.workos_organization_id=$4`, [orgId, userId, fixture.expectedOrganizationSlug, proof.organizationId]);
    if (existing.rows.length) {
      const row = existing.rows[0];
      if (existing.rows.length !== 1 || row.id !== orgId || row.slug !== fixture.expectedOrganizationSlug || row.created_by !== userId ||
          row.is_personal || !row.cloud_workspaces_allowed || row.deleted_at || row.lifecycle_status !== "active" ||
          row.workos_organization_id !== proof.organizationId || row.link_state !== "active" || row.role !== "owner" ||
          row.workos_membership_id !== proof.membershipId) throw new Error("The Dev organization conflicts with existing local ownership; no authority was replaced");
      return true;
    }
    await tx.query(`INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed)
      VALUES ($1,$2,$3,$4,false,true)`, [orgId, fixture.expectedOrganizationSlug, proof.name, userId]);
    await tx.query(`INSERT INTO organization_members(org_id,user_id,role,workos_membership_id,membership_source)
      VALUES ($1,$2,'owner',$3,'workos')`, [orgId, userId, proof.membershipId]);
    await tx.query("SELECT provision_cloud_workspace_pro_defaults($1)", [orgId]);
    const team = await tx.query(`INSERT INTO teams(org_id,slug,name,is_default,created_by)
      VALUES ($1,'default','Default',true,$2) RETURNING id`, [orgId, userId]);
    await tx.query(`INSERT INTO team_members(team_id,org_id,user_id,role) VALUES ($1,$2,$3,'maintainer')`, [team.rows[0].id, orgId, userId]);
    await tx.query(`INSERT INTO workos_organization_links(organization_id,workos_organization_id,external_id,state)
      VALUES ($1::uuid,$2,($1::uuid)::text,'active')`, [orgId, proof.organizationId]);
    await tx.query(`INSERT INTO workos_membership_projections(workos_membership_id,workos_organization_id,workos_user_id,
      organization_id,user_id,status,role,last_provider_event_at) VALUES ($1,$2,$3,$4,$5,'active','owner',$6)`,
    [proof.membershipId, proof.organizationId, proof.userId, orgId, userId, proof.membershipUpdatedAt]);
    return true;
  });
}

export async function seedHostedFixture({ runtime, migration, withSystemTx, module, request }) {
  const fixture = request.fixture;
  assertCurrentFixtureFunding(fixture);
  if (fixtureIssues(fixture).length || !fixture || !Number.isSafeInteger(request.worker?.storageMiB) || request.worker.storageMiB < 1 ||
      !Number.isSafeInteger(request.boat?.secondsPerDollar) || request.boat.secondsPerDollar < 1 || request.boat.secondsPerDollar > 1_000_000_000_000 ||
      !Number.isFinite(Date.parse(fixture.startsAt)) || !Number.isFinite(Date.parse(fixture.endsAt)) ||
      Date.parse(fixture.endsAt) <= Date.now() || Date.parse(fixture.endsAt) <= Date.parse(fixture.startsAt) ||
      Date.parse(fixture.endsAt) - Date.parse(fixture.startsAt) > 7 * 86400_000) throw new Error("Invalid Dev fixture authority");
  if (fixture.bootstrapOrganization && !await bootstrapFixtureOrganization({ runtime, withSystemTx, fixture, proof: request.fixtureProof })) {
    return { seeded: false, needsSignIn: true };
  }
  const rows = await withSystemTx(runtime, async tx => (await tx.query(`SELECT u.id AS user_id, u.email::text AS email,
      o.id AS organization_id, o.slug::text AS slug
    FROM user_identities i JOIN users u ON u.id=i.user_id
    JOIN organization_members member ON member.user_id=u.id
    JOIN organizations o ON o.id=member.org_id
    JOIN workos_organization_links link ON link.organization_id=o.id
    WHERE i.provider='workos' AND i.provider_sub=$1 AND i.status='active'
      AND u.auth_status='active' AND u.deleted_at IS NULL
      AND link.workos_organization_id=$2 AND link.state='active'
      AND o.is_personal=false AND o.lifecycle_status='active' AND o.deleted_at IS NULL
      AND o.cloud_workspaces_allowed=true`, [fixture.workosUserId, fixture.workosOrganizationId])).rows);
  if (!rows.length) return { seeded: false, needsSignIn: true };
  const row = rows[0];
  if (rows.length !== 1 || row.email.toLowerCase() !== fixture.expectedEmail.toLowerCase() || row.slug !== fixture.expectedOrganizationSlug) throw new Error("The Dev fixture identity or Organization differs from its explicit configuration");
  const common = { databaseUrl: request.roles.migration.url, channel: "development", execute: false,
    actorUserId: row.user_id, organizationId: row.organization_id, expectedOrganizationSlug: row.slug,
    reason: `Disposable development fixture ${request.owner}/${request.generation}` };
  const apply = async (name, validateName, manageName, fields) => {
    const api = await module(name), validate = api[validateName], manage = api[manageName];
    const input = { ...common, ...fields };
    const plan = await manage(migration, validate(input));
    if (plan.state !== "unchanged") await manage(migration, validate({ ...input, execute: true, approval: plan.approval }));
  };
  await apply("manage-staff.js", "validateStaffRoleRequest", "manageStaffRole", {
    subjectUserId: row.user_id, expectedEmail: row.email, nextRole: "platform_owner" });
  await apply("manage-cloud-workspace-quota.js", "validateCloudWorkspaceQuotaRequest", "manageCloudWorkspaceQuota", {
    maxWorkspaces: "1", maxRunningWorkspaces: "1", maxCpuMillicores: "4000", maxMemoryMiB: "8192", maxStorageMiB: String(request.worker.storageMiB) });
  // New workspaces always use the creator's individual Pro authority. Staff
  // activation above supplies the normal audited complimentary entitlement;
  // the release issuer owns its period, receipt, price and retry semantics.
  const { DatabaseProMonthlyAllowance } = await module("cloud-workspaces/pro-allowance.js");
  const allowance = await new DatabaseProMonthlyAllowance(runtime, {
    policyId: "hosted-dev", secondsPerDollar: request.boat.secondsPerDollar,
  }).ensure(row.user_id);
  if (allowance.state !== "ready") throw new Error(`Dev Pro allowance is ${allowance.state}; existing funding was preserved. Archive this generation before changing its funding model.`);
  return { seeded: true };
}
