import {randomBytes,randomUUID} from "node:crypto";
import pg from "pg";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {withSystemTx} from "../db.js";
import {resetMigratedTestDatabase} from "../test-database.js";
import {seedReadyCloudWorkspace,ensureCloudPilotUser,withCloudFixtureOwnerTx} from "./test-fixtures.js";
import {DatabaseCloudAgentExecutionService} from "./agent-executions.js";
import {DatabaseCloudWorkspaceCollaborationService,authorizeCloudWorkspaceActor} from "./actors.js";
import {CloudAgentBootScopeSchema,CloudAgentBootCredentialResponseSchema} from "./agent-boot-contract.js";
import {recordCloudAgentFundingConsents,readCloudAgentFundingConsent} from "./agent-funding-consent.js";
const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("real workspace-role funding provenance",()=>{
 let pool:pg.Pool,fixture:Awaited<ReturnType<typeof seedReadyCloudWorkspace>>,memberId:string,scope:ReturnType<typeof CloudAgentBootScopeSchema.parse>;
 beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:8});});afterAll(async()=>{await pool.end();});
 beforeEach(async()=>{
  await resetMigratedTestDatabase(pool);fixture=await seedReadyCloudWorkspace(pool);
  memberId=(await ensureCloudPilotUser(pool,{provider:"workos",providerSubject:`user_${randomUUID()}`,email:`fund-${randomUUID()}@example.test`,displayName:"Member"})).id;
  await withCloudFixtureOwnerTx(pool,async tx=>{await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')",[fixture.organizationId,memberId]);await tx.query("INSERT INTO organization_seat_assignments(org_id,user_id,state) VALUES($1,$2,'active')",[fixture.organizationId,memberId]);await tx.query("INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source) VALUES($1,'pro','active',true,'operator')",[memberId]);});
  await new DatabaseCloudWorkspaceCollaborationService(pool).setSharing({organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,actorUserId:fixture.userId,sharingMode:"organization",expectedRevision:1});
  await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1 WHERE id=$1",[fixture.engineInstanceId]);
  const boot=CloudAgentBootCredentialResponseSchema.parse(await new DatabaseCloudAgentExecutionService(pool,{currentKeyVersion:1,keys:{1:randomBytes(32).toString('base64url')}},false).boot({organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,generation:1,engineInstanceId:fixture.engineInstanceId,heartbeatToken:fixture.heartbeatToken},"bootstrap",{version:1,mode:"boot-owner-v1",organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,generation:1,engineInstanceId:fixture.engineInstanceId}));
  scope=CloudAgentBootScopeSchema.parse(Object.fromEntries(Object.keys(CloudAgentBootScopeSchema.shape).map(key=>[key,boot[key as keyof typeof boot]])));
 });
 const read=(userId:string)=>withSystemTx(pool,async tx=>{const actor=await authorizeCloudWorkspaceActor(tx,{...scope,actorUserId:userId,capability:"read"});return readCloudAgentFundingConsent(tx,scope,{userId,role:actor.role});});
 it("records real General access consent at owner-bound bootstrap and preserves its issuer",async()=>{
  const grant=await read(memberId);expect(grant).toMatchObject({kind:"general-access",grantId:expect.any(String),grantRevision:1});
  const row=(await pool.query("SELECT issuer_user_id,owner_epoch FROM cloud_agent_funding_consents WHERE id=$1",[grant!.kind==='owner'?null:grant!.grantId])).rows[0]!;
  expect(row).toEqual({issuer_user_id:fixture.userId,owner_epoch:"1"});
 });
 it("refuses a role written without its real recorded consent and never funds a Viewer",async()=>{
  await pool.query("INSERT INTO cloud_workspace_members(workspace_id,org_id,user_id,role) VALUES($1,$2,$3,'developer')",[scope.workspaceId,scope.organizationId,memberId]);
  await expect(read(memberId)).rejects.toMatchObject({status:403});
  await pool.query("UPDATE cloud_workspace_members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[scope.workspaceId,memberId]);
  expect(await read(memberId)).toBeNull();
 });
 it("does not relabel an earlier consent issuer after owner transfer; a new grant keeps the frozen funder",async()=>{
  const first=await read(memberId);
  await withSystemTx(pool,async tx=>{
   await tx.query("UPDATE cloud_workspace_members SET role='developer' WHERE workspace_id=$1 AND user_id=$2",[scope.workspaceId,fixture.userId]);
   await tx.query("INSERT INTO cloud_workspace_members(workspace_id,org_id,user_id,role) VALUES($1,$2,$3,'owner') ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='owner'",[scope.workspaceId,scope.organizationId,memberId]);
   await tx.query("INSERT INTO team_members(team_id,org_id,user_id,role) SELECT team_id,org_id,$2,'member' FROM cloud_workspaces WHERE id=$1 ON CONFLICT DO NOTHING",[scope.workspaceId,memberId]);
   await tx.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1",[scope.workspaceId,memberId]);
  });
  await expect(read(fixture.userId)).rejects.toThrow();
  await withSystemTx(pool,tx=>recordCloudAgentFundingConsents(tx,{workspaceId:scope.workspaceId,organizationId:scope.organizationId,issuerUserId:memberId}));
  const next=await read(memberId);expect(next).toMatchObject({kind:"share",grantId:expect.any(String)});expect(scope.fundingOwnerUserId).toBe(fixture.userId);
  const row=(await pool.query("SELECT issuer_user_id,owner_epoch FROM cloud_agent_funding_consents WHERE id=$1",[next!.kind==='owner'?null:next!.grantId])).rows[0]!;
  expect(row).toEqual({issuer_user_id:memberId,owner_epoch:"2"});expect(next).not.toEqual(first);
 });
});
