import {randomUUID} from "node:crypto";
import pg from "pg";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {ensureUser} from "../auth.js";
import {runMigrations} from "../migrate.js";
import {getSecuritySnapshot,listSecurityEvents,publishPendingSecurityEvents,PostgresSecurityEventBroker,startSecurityEventPublisher} from "../security-events.js";
import {seedReadyCloudWorkspace,seedReadyProCloudWorkspace} from "./test-fixtures.js";
import {DatabaseCloudWorkspaceCollaborationService} from "./actors.js";
import {eraseCloudWorkspaceCollaborationIdentity} from "./actors.js";
import {withSystemTx} from "../db.js";
import {publishCloudWorkspaceDirectoryChanges} from "./directory-events.js";

const d=process.env.TEST_DATABASE_URL?describe:describe.skip;
d("cloud workspace directory live updates",()=>{
  let pool:pg.Pool;
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});});
  afterAll(async()=>{await pool.end();});
  beforeEach(async()=>{await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");await runMigrations(pool);});
  const user=(id:string)=>ensureUser(pool,{provider:"workos",providerSubject:`workos|${id}`,email:`durable-${id}@example.test`,displayName:"Directory actor"});
  it("delivers deletion refreshes to more than 100 Pro viewers in bounded pages",async()=>{
    const fixture=await seedReadyProCloudWorkspace(pool);
    await pool.query(`WITH recipients AS (INSERT INTO users(email,display_name)
      SELECT 'viewer-'||gen_random_uuid()||'@example.test','Viewer' FROM generate_series(1,101) RETURNING id)
      INSERT INTO cloud_workspace_guest_grants(id,workspace_id,org_id,user_id,role,expires_at)
      SELECT gen_random_uuid(),$1,$2,id,'viewer',now()+interval '1 day' FROM recipients`,[fixture.workspaceId,fixture.organizationId]);
    await pool.query("UPDATE cloud_workspaces SET status='deleted',desired_state='deleted',deleted_at=now(),version=version+1 WHERE id=$1",[fixture.workspaceId]);
    await pool.query("DELETE FROM cloud_workspace_guest_grants WHERE workspace_id=$1",[fixture.workspaceId]);
    await pool.query("DELETE FROM cloud_workspaces WHERE id=$1",[fixture.workspaceId]);
    await publishCloudWorkspaceDirectoryChanges(pool);
    expect((await pool.query("SELECT count(*)::int AS n FROM security_events WHERE user_id IS NOT NULL")).rows[0].n).toBeLessThanOrEqual(100);
    await publishCloudWorkspaceDirectoryChanges(pool);
    expect((await pool.query("SELECT count(DISTINCT user_id)::int AS n FROM security_events WHERE user_id IS NOT NULL")).rows[0].n).toBe(101);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_directory_outbox WHERE workspace_id=$1",[fixture.workspaceId])).rowCount).toBe(0);
  });
  it.each(["organization","workspace"])("skips a busy %s without delaying another tenant",async(kind)=>{
    const busy=await seedReadyCloudWorkspace(pool),free=await seedReadyCloudWorkspace(pool);
    const lock=await pool.connect();let publication:Promise<void>|undefined;
    try{
      await lock.query("BEGIN");
      await lock.query(kind==="organization"?"SELECT id FROM organizations WHERE id=$1 FOR UPDATE":"SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE",[kind==="organization"?busy.organizationId:busy.workspaceId]);
      publication=publishCloudWorkspaceDirectoryChanges(pool);
      expect(await Promise.race([publication.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),500))])).toBe(true);
      expect((await pool.query("SELECT workspace_id FROM cloud_workspace_directory_outbox")).rows).toEqual([{workspace_id:busy.workspaceId}]);
      expect((await pool.query("SELECT workspace_id FROM security_events WHERE workspace_id=$1",[free.workspaceId])).rowCount).toBe(1);
    }finally{await lock.query("ROLLBACK");lock.release();await publication;}
    await publishCloudWorkspaceDirectoryChanges(pool);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_directory_outbox")).rowCount).toBe(0);
  });
  it("retains removal recipients across hard deletion of their host organization",async()=>{
    const fixture=await seedReadyCloudWorkspace(pool),other=await seedReadyCloudWorkspace(pool),guest=await user(other.userId);
    const service=new DatabaseCloudWorkspaceCollaborationService(pool),scope={workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId};
    await service.setSharing({...scope,sharingMode:"organization",expectedRevision:1});
    const invitation=await service.invite({...scope,email:guest.email,role:"viewer"});
    await service.accept({actorUserId:guest.id,identity:guest.identity,token:invitation.token!});
    const snapshot=await getSecuritySnapshot(pool,guest);
    await pool.query("UPDATE cloud_workspaces SET status='deleted',desired_state='deleted',deleted_at=now(),version=version+1 WHERE id=$1",[fixture.workspaceId]);
    await pool.query("DELETE FROM cloud_workspace_guest_grants WHERE workspace_id=$1",[fixture.workspaceId]);
    await pool.query("DELETE FROM cloud_workspaces WHERE id=$1",[fixture.workspaceId]);
    expect((await pool.query("SELECT guest_user_ids FROM cloud_workspace_directory_outbox WHERE workspace_id=$1",[fixture.workspaceId])).rows[0]!.guest_user_ids).toEqual([guest.id]);
    await pool.query("DELETE FROM repositories WHERE org_id=$1",[fixture.organizationId]);
    await pool.query("UPDATE organizations SET lifecycle_status='purging' WHERE id=$1",[fixture.organizationId]);
    await withSystemTx(pool,tx=>tx.query("SELECT public.purge_cloud_workspace_operator_configuration($1)",[fixture.organizationId]));
    await pool.query("DELETE FROM audit_log WHERE org_id=$1",[fixture.organizationId]);
    await pool.query("DELETE FROM organizations WHERE id=$1",[fixture.organizationId]);
    expect(await listSecurityEvents(pool,guest,snapshot.cursor)).toEqual([expect.objectContaining({organizationId:null,workspaceId:null,payload:{reason:"workspace_directory_changed"}})]);
  });
  it("scrubs purged identities from an undrained directory row",async()=>{
    const fixture=await seedReadyCloudWorkspace(pool),first=randomUUID(),second=randomUUID();
    await pool.query("UPDATE cloud_workspace_directory_outbox SET guest_user_ids=$2::uuid[] WHERE workspace_id=$1",[fixture.workspaceId,[first,second]]);
    await withSystemTx(pool,tx=>eraseCloudWorkspaceCollaborationIdentity(tx,first));
    await withSystemTx(pool,tx=>eraseCloudWorkspaceCollaborationIdentity(tx,fixture.userId));
    expect((await pool.query("SELECT owner_user_id,guest_user_ids FROM cloud_workspace_directory_outbox WHERE workspace_id=$1",[fixture.workspaceId])).rows).toEqual([{owner_user_id:null,guest_user_ids:[second]}]);
  });
  it("retains a removal notice while its recipient is being purged",async()=>{
    const fixture=await seedReadyCloudWorkspace(pool);
    await pool.query("UPDATE cloud_workspaces SET status='deleted',desired_state='deleted',deleted_at=now(),version=version+1 WHERE id=$1",[fixture.workspaceId]);
    await pool.query("DELETE FROM organization_members WHERE org_id=$1",[fixture.organizationId]);
    const lock=await pool.connect();let publication:Promise<void>|undefined;
    try{
      await lock.query("BEGIN");await lock.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[fixture.userId]);
      publication=publishCloudWorkspaceDirectoryChanges(pool);
      expect(await Promise.race([publication.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),500))])).toBe(true);
      expect((await pool.query("SELECT 1 FROM cloud_workspace_directory_outbox WHERE workspace_id=$1",[fixture.workspaceId])).rowCount).toBe(1);
    }finally{await lock.query("ROLLBACK");lock.release();await publication;}
    await publishCloudWorkspaceDirectoryChanges(pool);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_directory_outbox WHERE workspace_id=$1",[fixture.workspaceId])).rowCount).toBe(0);
  });
  it("publishes and removes queued metadata without a stream or snapshot request",async()=>{
    const fixture=await seedReadyCloudWorkspace(pool),stop=startSecurityEventPublisher(pool);
    try{
      await vi.waitFor(async()=>expect((await pool.query("SELECT 1 FROM cloud_workspace_directory_outbox")).rowCount).toBe(0));
      await vi.waitFor(async()=>expect((await pool.query("SELECT 1 FROM security_events WHERE workspace_id=$1 AND delivery_sequence IS NOT NULL",[fixture.workspaceId])).rowCount).toBe(1));
    }finally{await stop();}
  });
  it("wakes a healthy stream promptly when metadata is queued, without waiting for its heartbeat",async()=>{
    const fixture=await seedReadyCloudWorkspace(pool);await publishPendingSecurityEvents(pool);
    const broker=new PostgresSecurityEventBroker(pool);await broker.start();
    try{
      const before=broker.revision();
      await pool.query("UPDATE cloud_workspaces SET status='busy',version=version+1 WHERE id=$1",[fixture.workspaceId]);
      await vi.waitFor(()=>expect(broker.revision()).toBeGreaterThan(before),{timeout:1000});
    }finally{await broker.stop();}
  });
  it("discovers creation and replays a coalesced state change on a second device",async()=>{
    const fixture=await seedReadyCloudWorkspace(pool),owner=await user(fixture.userId);
    expect(await listSecurityEvents(pool,owner,0)).toEqual(expect.arrayContaining([
      expect.objectContaining({kind:"workspace.authorization_changed",workspaceId:fixture.workspaceId,payload:{reason:"workspace_changed"}}),
    ]));
    const snapshot=await getSecuritySnapshot(pool,owner);
    await pool.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped',version=version+1 WHERE id=$1",[fixture.workspaceId]);
    const events=await listSecurityEvents(pool,owner,snapshot.cursor);
    expect(events).toEqual([expect.objectContaining({workspaceId:fixture.workspaceId,payload:{reason:"workspace_changed"}})]);
    expect(await listSecurityEvents(pool,owner,snapshot.cursor)).toEqual(events);
    const next=await getSecuritySnapshot(pool,owner);
    expect(next.workspaces[0]!.dataRevision).toBeGreaterThan(snapshot.workspaces[0]!.dataRevision);
  });
  it("notifies a removed guest after tombstoning without exposing other host workspaces",async()=>{
    const fixture=await seedReadyCloudWorkspace(pool),other=await seedReadyCloudWorkspace(pool),guest=await user(other.userId);
    const service=new DatabaseCloudWorkspaceCollaborationService(pool),scope={workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId};
    await service.setSharing({...scope,sharingMode:"organization",expectedRevision:1});
    const invitation=await service.invite({...scope,email:guest.email,role:"viewer"});
    await service.accept({actorUserId:guest.id,identity:guest.identity,token:invitation.token!});
    const snapshot=await getSecuritySnapshot(pool,guest);
    await pool.query("UPDATE cloud_workspaces SET status='deleted',desired_state='deleted',deleted_at=now(),version=version+1 WHERE id=$1",[fixture.workspaceId]);
    const events=await listSecurityEvents(pool,guest,snapshot.cursor);
    expect(events).toEqual([expect.objectContaining({kind:"organization.data_changed",workspaceId:null,payload:{reason:"workspace_directory_changed"}})]);
    expect((await getSecuritySnapshot(pool,guest)).workspaces.map(workspace=>workspace.id)).not.toContain(fixture.workspaceId);
    const unrelated=await seedReadyCloudWorkspace(pool,{ownerUserId:fixture.userId});
    await publishPendingSecurityEvents(pool);
    expect(JSON.stringify(await listSecurityEvents(pool,guest,snapshot.cursor))).not.toContain(unrelated.workspaceId);
  });
});
