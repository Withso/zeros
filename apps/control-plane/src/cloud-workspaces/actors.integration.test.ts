import {withCloudFixtureOwnerTx} from "./test-fixtures.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthedUser } from "../auth.js";
import { withSystemTx, withUserTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import {ensureUser} from "../auth.js";
import {getSecuritySnapshot,listSecurityEvents} from "../security-events.js";
import { ensureCloudPilotUser, seedReadyCloudWorkspace } from "./test-fixtures.js";
import { authorizeCloudWorkspaceActor, eraseCloudWorkspaceCollaborationIdentity, DatabaseCloudWorkspaceCollaborationService } from "./actors.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("workspace-scoped multiplayer authority", () => {
  let pool: pg.Pool;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let memberId: string;
  let guestId: string;
  let guestEmail: string;
  let service: DatabaseCloudWorkspaceCollaborationService;
  let identities: Map<string,AuthedUser["identity"]>;
  const accept = (input:{actorUserId:string;token:string}) => service.accept({...input,identity:identities.get(input.actorUserId)!});
  beforeAll(() => { pool = new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5}); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    const member = await ensureCloudPilotUser(pool, {provider:"workos",providerSubject:`user_${randomUUID()}`,email:`member-${randomUUID()}@example.test`,displayName:"Member"});
    guestEmail = `guest-${randomUUID()}@example.test`;
    const guest = await ensureCloudPilotUser(pool, {provider:"workos",providerSubject:`user_${randomUUID()}`,email:guestEmail,displayName:"Guest"});
    memberId = member.id; guestId = guest.id;
    identities = new Map([[member.id,member.identity],[guest.id,guest.identity]]);
    await withCloudFixtureOwnerTx(pool, async tx => {
      await tx.query(`INSERT INTO organization_members(org_id,user_id,role) VALUES ($1,$2,'member')`,[fixture.organizationId,memberId]);
      await tx.query(`INSERT INTO organization_seat_assignments(org_id,user_id,state) VALUES ($1,$2,'active')`,[fixture.organizationId,memberId]);
      await tx.query(`INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source)
        VALUES ($1,'pro','active',true,'operator')`,[guestId]);
    });
    service = new DatabaseCloudWorkspaceCollaborationService(pool);
  });
  const access = (actorUserId:string,capability:"read"|"edit"|"run"|"manage"="read") => withSystemTx(pool,tx => authorizeCloudWorkspaceActor(tx,{workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId,capability}));
  const sharing = () => service.setSharing({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId,sharingMode:"organization",expectedRevision:1});

  const currentUser = async (userId:string) => {
    const identity=identities.get(userId)!;
    return ensureUser(pool,{provider:identity.provider,providerSubject:identity.subject,email:identity.verifiedEmail!,displayName:"Collaboration test"});
  };

  it("replays exact-workspace changes to guests on every device without leaking tenant data",async()=>{
    await sharing();
    const scope={workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId};
    const guest=await currentUser(guestId);
    const invite=await service.invite({...scope,email:guestEmail,role:"viewer"});
    await accept({actorUserId:guestId,token:invite.token});
    const snapshot=await getSecuritySnapshot(pool,guest);
    expect(snapshot.organizations.some(org=>org.id===fixture.organizationId)).toBe(false);
    expect(snapshot).toMatchObject({workspaces:[{id:fixture.workspaceId,role:"viewer"}],workspacesTruncated:false});
    await pool.query("INSERT INTO security_events(kind,org_id,payload) VALUES ('organization.data_changed',$1,'{\"privateTenantData\":true}')",[fixture.organizationId]);
    await service.revokeGuest({...scope,guestUserId:guestId});
    const first=await listSecurityEvents(pool,guest,snapshot.cursor);
    const sibling=await listSecurityEvents(pool,guest,snapshot.cursor);
    expect(first).toEqual(sibling);
    expect(first).toEqual([expect.objectContaining({kind:"workspace.authorization_changed",workspaceId:fixture.workspaceId,payload:{reason:"access_revoked"}})]);
    expect((await getSecuritySnapshot(pool,guest)).workspaces).toEqual([]);
  });

  it("invalidates organization discovery without exposing private workspace events to former members",async()=>{
    await sharing();
    const member=await currentUser(memberId);
    const snapshot=await getSecuritySnapshot(pool,member);
    await service.setSharing({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,
      actorUserId:fixture.userId,sharingMode:"private",expectedRevision:2});
    const events=await listSecurityEvents(pool,member,snapshot.cursor);
    expect(events).toEqual([expect.objectContaining({kind:"organization.data_changed",workspaceId:null,payload:{reason:"workspace_access_changed"}})]);
    expect(JSON.stringify(events)).not.toContain(fixture.workspaceId);
    expect((await getSecuritySnapshot(pool,member)).workspaces).toEqual([]);
  });

  it("replaces an existing invitation when the pending invitation cap has been reached",async()=>{
    await sharing();
    const scope={workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId};
    const original=await service.invite({...scope,email:guestEmail,role:"viewer"});
    await pool.query(`INSERT INTO cloud_workspace_invitations(id,workspace_id,org_id,recipient_email_sha256,token_hash,role,invited_by,expires_at,inviter_fingerprint)
      SELECT gen_random_uuid(),workspace_id,org_id,digest(index::text,'sha256'),digest(gen_random_uuid()::text,'sha256'),role,invited_by,expires_at,inviter_fingerprint
      FROM cloud_workspace_invitations CROSS JOIN generate_series(1,99) index WHERE id=$1`,[original.id]);
    await expect(service.invite({...scope,email:guestEmail,role:"developer"})).resolves.toMatchObject({id:expect.any(String)});
    expect((await pool.query("SELECT count(*) FROM cloud_workspace_invitations WHERE revoked_at IS NULL AND accepted_at IS NULL")).rows[0].count).toBe("100");
  });

  it("rejects unknown and prototype-named capabilities at the authority boundary", async () => {
    await sharing();
    for (const capability of ["unknown","constructor","__proto__"]) {
      await expect(withSystemTx(pool,tx=>authorizeCloudWorkspaceActor(tx,{workspaceId:fixture.workspaceId,
        organizationId:fixture.organizationId,actorUserId:memberId,capability:capability as "read"})))
        .rejects.toMatchObject({status:422});
    }
  });

  it("preserves old private workspaces and shares explicitly with all org members, including outside its team", async () => {
    await expect(access(memberId)).rejects.toMatchObject({status:404});
    await sharing();
    await expect(access(memberId,"edit")).resolves.toMatchObject({role:"developer",actorUserId:memberId,sponsorUserId:fixture.userId});
    await expect(access(memberId,"manage")).rejects.toMatchObject({status:403});
    await expect(access(guestId)).rejects.toMatchObject({status:404});
  });

  it("accepts a verified invited Pro guest without adding organization or team membership", async () => {
    await sharing();
    const invite = await service.invite({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId,email:guestEmail,role:"developer"});
    await expect(accept({actorUserId:memberId,token:invite.token})).rejects.toMatchObject({status:404});
    await accept({actorUserId:guestId,token:invite.token});
    await expect(access(guestId,"run")).resolves.toMatchObject({role:"developer",sponsorUserId:fixture.userId});
    const membership = await pool.query("SELECT 1 FROM organization_members WHERE org_id=$1 AND user_id=$2",[fixture.organizationId,guestId]);
    expect(membership.rowCount).toBe(0);
    const tenantRows = await withUserTx(pool,guestId,tx => tx.query("SELECT id FROM organizations WHERE id=$1",[fixture.organizationId]));
    expect(tenantRows.rowCount).toBe(0);
    await expect(access(guestId,"manage")).rejects.toMatchObject({status:403});
  });

  it("rejects expired, revoked, unverified, and non-staff invitations without consuming them", async () => {
    await sharing();
    const invite = await service.invite({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId,email:guestEmail,role:"viewer"});
    await pool.query("UPDATE user_identities SET email_verified_at=NULL WHERE user_id=$1",[guestId]);
    await expect(accept({actorUserId:guestId,token:invite.token})).rejects.toMatchObject({status:404});
    await pool.query("UPDATE user_identities SET email_verified_at=now() WHERE user_id=$1",[guestId]);
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1",[guestId]);
    await expect(accept({actorUserId:guestId,token:invite.token})).rejects.toMatchObject({status:404});
    await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1",[guestId]);
    await service.revokeInvitation({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId,invitationId:invite.id});
    await expect(accept({actorUserId:guestId,token:invite.token})).rejects.toMatchObject({status:404});
    const expired = await service.invite({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId,email:guestEmail,role:"viewer"});
    await pool.query("UPDATE cloud_workspace_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);
    await expect(accept({actorUserId:guestId,token:expired.token})).rejects.toMatchObject({status:404});
  });

  it("revokes only the removed guest and prevents consumed invitation replay from restoring access", async () => {
    await sharing();
    const invite = await service.invite({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId,email:guestEmail,role:"viewer"});
    await Promise.all([accept({actorUserId:guestId,token:invite.token}),accept({actorUserId:guestId,token:invite.token})]);
    await expect(access(guestId,"edit")).rejects.toMatchObject({status:403});
    await service.revokeGuest({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId,guestUserId:guestId});
    await expect(access(guestId)).rejects.toMatchObject({status:404});
    await expect(accept({actorUserId:guestId,token:invite.token})).rejects.toMatchObject({status:404});
    await expect(access(memberId,"edit")).resolves.toMatchObject({role:"developer"});
    expect((await pool.query("SELECT cloud_workspace_paid_authority_live($1,$2,false) AS live",[fixture.workspaceId,fixture.userId])).rows[0].live).toBe(true);
  });

  it("does not accept an invitation using a retired verified identity", async () => {
    await sharing();
    const invite = await service.invite({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId,email:guestEmail,role:"developer"});
    await pool.query("UPDATE user_identities SET status='superseded' WHERE user_id=$1",[guestId]);
    await pool.query(`INSERT INTO user_identities(user_id,provider,provider_sub,email_at_link,email_verified_at)
      VALUES ($1,'workos',$2,$3,now())`,[guestId,`current-${randomUUID()}`,`replacement-${randomUUID()}@example.test`]);
    await expect(accept({actorUserId:guestId,token:invite.token})).rejects.toMatchObject({status:404});
  });

  it("removes owner management authority when the owner leaves the organization", async () => {
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2",[fixture.organizationId,fixture.userId]);
    await expect(access(fixture.userId,"manage")).rejects.toMatchObject({status:404});
    await expect(sharing()).rejects.toMatchObject({status:404});
  });

  it("revokes a guest's pending re-invitation as well as the accepted grant", async () => {
    await sharing();
    const scope = {workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId};
    const first = await service.invite({...scope,email:guestEmail,role:"developer"});
    await accept({actorUserId:guestId,token:first.token});
    const pending = await service.invite({...scope,email:guestEmail,role:"developer"});
    await service.revokeGuest({...scope,guestUserId:guestId});
    await expect(accept({actorUserId:guestId,token:pending.token})).rejects.toMatchObject({status:404});
    const renewed = await service.invite({...scope,email:guestEmail,role:"viewer"});
    await expect(accept({actorUserId:guestId,token:renewed.token})).resolves.toMatchObject({replayed:false});
  });

  it("uses the current verified sign-in email after a legitimate address change", async () => {
    await sharing();
    const scope = {workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId};
    const old = await service.invite({...scope,email:guestEmail,role:"developer"});
    const email = `changed-${randomUUID()}@example.test`;
    const original = identities.get(guestId)!;
    const changed = await ensureCloudPilotUser(pool,{provider:original.provider,providerSubject:original.subject,email,displayName:"Changed"});
    identities.set(guestId,changed.identity);
    await expect(accept({actorUserId:guestId,token:old.token})).rejects.toMatchObject({status:404});
    const current = await service.invite({...scope,email,role:"developer"});
    await expect(accept({actorUserId:guestId,token:current.token})).resolves.toMatchObject({replayed:false});
  });

  it("does not reopen a consumed invitation when its accepted principal has been erased", async () => {
    await sharing();
    const invite = await service.invite({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId,email:guestEmail,role:"viewer"});
    await accept({actorUserId:guestId,token:invite.token});
    await pool.query("UPDATE cloud_workspace_invitations SET accepted_by=NULL,guest_grant_id=NULL WHERE id=$1",[invite.id]);
    await expect(accept({actorUserId:guestId,token:invite.token})).rejects.toMatchObject({status:404});
  });

  it("does not revive an old invitation after its inviter loses and regains staff authority", async () => {
    await sharing();
    const invite = await service.invite({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId,email:guestEmail,role:"developer"});
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1",[fixture.userId]);
    await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1",[fixture.userId]);
    await expect(accept({actorUserId:guestId,token:invite.token})).rejects.toMatchObject({status:404});
  });

  it("erases guest and recipient records while retaining unrelated invitations", async () => {
    await sharing();
    const scope={workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId};
    const invite=await service.invite({...scope,email:guestEmail,role:"viewer"});
    await accept({actorUserId:guestId,token:invite.token});
    await service.invite({...scope,email:guestEmail,role:"developer"});
    const unrelated=await service.invite({...scope,email:`unrelated-${randomUUID()}@example.test`,role:"viewer"});
    await withSystemTx(pool,tx=>eraseCloudWorkspaceCollaborationIdentity(tx,guestId));
    expect((await pool.query("SELECT id FROM cloud_workspace_invitations")).rows).toEqual([{id:unrelated.id}]);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_guest_grants WHERE user_id=$1",[guestId])).rowCount).toBe(0);
  });
});
