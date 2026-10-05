import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "./migrate.js";
import { seedReadyCloudWorkspace } from "./cloud-workspaces/test-fixtures.js";
import { DatabaseCloudAgentCredentialService } from "./cloud-workspaces/agent-credentials.js";
import { inspectDevAgents } from "./dev-agent-qualification.js";
import { DatabaseCloudComputerService } from "./cloud-workspaces/computer.js";
import type { CloudWorkspaceBackendConfig } from "./config.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("connected Dev agent qualification discovery", () => {
  let pool: pg.Pool, service: DatabaseCloudAgentCredentialService;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  const owner = "a".repeat(24), generation = randomUUID();
  const request = { owner, generation, fixture: { workosUserId: "user_fixture", workosOrganizationId: "org_fixture",
    expectedEmail: "dev@example.test", expectedOrganizationSlug: "dev-test" },
  image: { snapshotId: "dev-test-image", sourceCommit: "b".repeat(40), buildSha256: "c".repeat(64) } };
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  afterEach(()=>vi.unstubAllEnvs());
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public"); await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    await pool.query("CREATE TABLE zeros_development_identity(owner text, generation uuid)");
    await pool.query("INSERT INTO zeros_development_identity VALUES ($1,$2)", [owner, generation]);
    await pool.query("UPDATE users SET staff_role='platform_owner',email=$2 WHERE id=$1", [fixture.userId, request.fixture.expectedEmail]);
    await pool.query("UPDATE user_identities SET provider_sub=$2 WHERE user_id=$1 AND provider='workos'", [fixture.userId, request.fixture.workosUserId]);
    await pool.query("UPDATE organizations SET slug=$2 WHERE id=$1", [fixture.organizationId, request.fixture.expectedOrganizationSlug]);
    await pool.query("INSERT INTO workos_organization_links(organization_id,workos_organization_id,external_id,state) VALUES ($1::uuid,$2,($1::uuid)::text,'active')",
      [fixture.organizationId, request.fixture.workosOrganizationId]);
    service = new DatabaseCloudAgentCredentialService(pool, { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 });
  });
  async function connect() {
    const credential = (await service.put({ ownerUserId: fixture.userId, organizationId: fixture.organizationId,
      credentialId: randomUUID(), operationId: randomUUID(), expectedRevision: 0, displayName: "Test account",
      material: { kind: "claude-setup-token", accessToken: "synthetic-private-credential" } })).credential;
    await service.setOrganizationConnection(fixture.userId, fixture.organizationId, "claude", { expectedRevision: 0,
      credentialId: credential.id, credentialRevision: credential.revision, models: ["claude-haiku-4-5"], consent: "zeros-managed" });
    return credential;
  }
  it("discovers only the selected, consented account and never returns credential material", async () => {
    expect(await inspectDevAgents(pool, request)).toMatchObject({ connections: [] });
    const credential = await connect(); const status = await inspectDevAgents(pool, request);
    expect(status).toMatchObject({ actorUserId: fixture.userId, connections: [{ credentialId: credential.id, enabled: false, kind: "claude-setup-token" }] });
    expect(JSON.stringify(status)).not.toContain("synthetic-private-credential");
    await pool.query("UPDATE organization_members SET authorization_revision=authorization_revision+1 WHERE org_id=$1", [fixture.organizationId]);
    expect(await inspectDevAgents(pool, request)).toMatchObject({ connections: [] });
  });
  it('freezes legacy Dev qualification when reference mode is enabled',async()=>{
    await connect();vi.stubEnv('ZEROS_DEPLOY_ENV','dev');vi.stubEnv('ZEROS_DEV_CONNECTIONS_ENABLED','true');
    expect(await inspectDevAgents(pool,request)).toMatchObject({connections:[]});
  });
  it('honors the launcher reference flag without relying on its process environment',async()=>{
    await connect();
    expect(await inspectDevAgents(pool,{...request,referenceMode:true} as any)).toMatchObject({connections:[]});
  });
  it('discovers only attested images of the fixture organization, current base and provider account',async()=>{
    await connect();
    const computers = new DatabaseCloudComputerService(pool, {} as CloudWorkspaceBackendConfig);
    await computers.save(fixture.organizationId,fixture.userId,{expectedRevision:0,operationId:randomUUID(),
      document:{repositories:[],installScript:'mkdir -p $PREFIX/bin',timeoutSeconds:30},sources:[]});
    const id=randomUUID(),snapshotId=`zeros-org-${id.replaceAll('-','')}`,buildSha256='e'.repeat(64),contractSha256='d'.repeat(64);
    await pool.query(`INSERT INTO cloud_computer_builds(id,org_id,profile_id,version,repository_owner,repository_name,state)
      SELECT $1,org_id,profile_id,draft_version,'fixture','repository','succeeded' FROM cloud_computers WHERE org_id=$2`,[id,fixture.organizationId]);
    await pool.query(`INSERT INTO cloud_computer_images(id,org_id,account_scope,snapshot_name,snapshot_id,image_ref,base_image_ref,
      base_source_commit,recipe_sha256,build_sha256,source_contract,image_contract,profile,state,attested_at,attestation_sha256)
      VALUES($1,$2,'fixture',$3,'immutable-provider-id',$4,$5,$6,$7,$8,$7,$7,'{}','attested',now(),$7)`,
    [id,fixture.organizationId,snapshotId,`boat:${snapshotId}@sha256:${buildSha256}`,
      `boat:${request.image.snapshotId}@sha256:${request.image.buildSha256}`,request.image.sourceCommit,contractSha256,buildSha256]);
    const input={...request,accountScope:'fixture'};
    expect(await inspectDevAgents(pool,input)).toMatchObject({organizationImages:[{id,snapshotId,buildSha256,connections:[{enabled:false}]}]});
    expect(await inspectDevAgents(pool,request)).not.toHaveProperty('organizationImages');
    expect(await inspectDevAgents(pool,{...input,accountScope:'foreign'})).toMatchObject({organizationImages:[]});
    expect(await inspectDevAgents(pool,{...input,image:{...request.image,buildSha256:'f'.repeat(64)}})).toMatchObject({organizationImages:[]});
    const organizationImage={id,snapshotId,buildSha256,sourceCommit:request.image.sourceCommit};
    await expect(inspectDevAgents(pool,{...input,organizationImage:{...organizationImage,id:randomUUID()}} as any)).rejects.toThrow(/image/);
    await pool.query(`INSERT INTO cloud_agent_runtime_qualifications(provider,image_ref,runtime_contract_sha256,credential_kind,profile,enabled,qualified_at)
      VALUES('boat',$1,$2,'claude-setup-token','zeros-cloud-worker-v3',true,now()-interval '1 hour')`,
    [`boat:${snapshotId}@sha256:${buildSha256}`,contractSha256]);
    expect(await inspectDevAgents(pool,{...input,organizationImage} as any)).toMatchObject({connections:[{enabled:false}]});
    await pool.query("UPDATE cloud_agent_runtime_qualifications SET qualified_at=clock_timestamp()");
    expect(await inspectDevAgents(pool,{...input,organizationImage} as any)).toMatchObject({connections:[{enabled:true}]});
    await pool.query("UPDATE cloud_computers SET active_image_id=$1 WHERE org_id=$2",[id,fixture.organizationId]);
    expect(await inspectDevAgents(pool,input)).toMatchObject({organizationImages:[{id}]});
    await pool.query("UPDATE cloud_computer_images SET state='retiring' WHERE id=$1",[id]);
    expect(await inspectDevAgents(pool,input)).toMatchObject({organizationImages:[]});
    await expect(inspectDevAgents(pool,{...input,organizationImage} as any)).rejects.toThrow(/image/);
  });
  it.each(["image", "source"] as const)("enables organization-image credentials only for the image contract (%s approval)", async qualifiedContract => {
    const credential = await connect();
    const computers = new DatabaseCloudComputerService(pool, {} as CloudWorkspaceBackendConfig);
    await computers.save(fixture.organizationId, fixture.userId, { expectedRevision: 0, operationId: randomUUID(),
      document: { repositories: [], installScript: "mkdir -p $PREFIX/bin", timeoutSeconds: 30 }, sources: [] });
    const id = randomUUID(), snapshotId = `zeros-org-${id.replaceAll("-", "")}`, buildSha256 = "e".repeat(64);
    const sourceContractSha256 = "d".repeat(64), imageContractSha256 = "f".repeat(64), imageRef = `boat:${snapshotId}@sha256:${buildSha256}`;
    await pool.query(`INSERT INTO cloud_computer_builds(id,org_id,profile_id,version,repository_owner,repository_name,state)
      SELECT $1,org_id,profile_id,draft_version,'fixture','repository','succeeded' FROM cloud_computers WHERE org_id=$2`, [id, fixture.organizationId]);
    await pool.query(`INSERT INTO cloud_computer_images(id,org_id,account_scope,snapshot_name,snapshot_id,image_ref,base_image_ref,
      base_source_commit,recipe_sha256,build_sha256,source_contract,image_contract,profile,state,attested_at,attestation_sha256)
      VALUES($1,$2,'fixture',$3,'immutable-provider-id',$4,$5,$6,$7,$8,$7,$9,'{}','attested',now(),$7)`,
    [id, fixture.organizationId, snapshotId, imageRef, `boat:${request.image.snapshotId}@sha256:${request.image.buildSha256}`,
      request.image.sourceCommit, sourceContractSha256, buildSha256, imageContractSha256]);
    await pool.query(`INSERT INTO cloud_agent_runtime_qualifications(provider,image_ref,runtime_contract_sha256,credential_kind,profile,enabled,qualified_at)
      VALUES('boat',$1,$2,'claude-setup-token','zeros-cloud-worker-v3',true,clock_timestamp())`,
    [imageRef, qualifiedContract === "image" ? imageContractSha256 : sourceContractSha256]);
    const status = await inspectDevAgents(pool, { ...request, accountScope: "fixture",
      organizationImage: { id, snapshotId, buildSha256, sourceCommit: request.image.sourceCommit } });
    const enabled = qualifiedContract === "image";
    expect.soft(status).toMatchObject({ connections: [{ credentialId: credential.id, enabled }] });
    expect(status).toMatchObject({ organizationImages: [{ id, snapshotId, buildSha256, contractSha256: imageContractSha256,
      connections: [{ credentialId: credential.id, enabled }] }] });
  });
  it("never borrows another organization or revoked credential", async () => {
    const credential = await connect();
    expect(await inspectDevAgents(pool, { ...request, fixture: { ...request.fixture, workosOrganizationId: "org_other" } })).toEqual({ needsSeed: true });
    await service.revoke(fixture.userId, credential.id);
    expect(await inspectDevAgents(pool, request)).toMatchObject({ connections: [] });
  });
  it("waits for a real verified login and refuses foreign database generations", async () => {
    await expect(inspectDevAgents(pool, { ...request, generation: randomUUID() })).rejects.toThrow(/identity mismatch/);
    await pool.query("UPDATE user_identities SET email_verified_at=NULL WHERE user_id=$1", [fixture.userId]);
    expect(await inspectDevAgents(pool, request)).toEqual({ needsSignIn: true });
  });
  it("requires qualification of the exact deployed image and kind", async () => {
    await connect();
    await pool.query(`INSERT INTO cloud_agent_runtime_qualifications(provider,image_ref,runtime_contract_sha256,credential_kind,profile,enabled,qualified_at)
      VALUES('boat',$1,$2,'claude-setup-token','zeros-cloud-worker-v3',true,now())`,
    [`boat:another-image@sha256:${request.image.buildSha256}`, "d".repeat(64)]);
    expect(await inspectDevAgents(pool, request)).toMatchObject({ connections: [{ enabled: false }] });
    await pool.query("UPDATE cloud_agent_runtime_qualifications SET image_ref=$1", [`boat:${request.image.snapshotId}@sha256:${request.image.buildSha256}`]);
    expect(await inspectDevAgents(pool, request)).toMatchObject({ connections: [{ enabled: true }] });
  });
});
