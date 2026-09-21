import {randomBytes,randomUUID} from "node:crypto";
import pg from "pg";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {runMigrations} from "../migrate.js";
import {EmailDeliveryError} from "../email.js";
import {DatabaseCloudWorkspaceCollaborationService,type WorkspaceInvitationDeliveryConfig} from "./actors.js";
import {CloudWorkspaceInvitationDeliveryWorker,type WorkspaceInvitationSender} from "./invitation-delivery.js";
import {seedReadyCloudWorkspace} from "./test-fixtures.js";

const d=process.env.TEST_DATABASE_URL?describe:describe.skip;
d("durable encrypted workspace invitations",()=>{
  let pool:pg.Pool,fixture:Awaited<ReturnType<typeof seedReadyCloudWorkspace>>,config:WorkspaceInvitationDeliveryConfig,service:DatabaseCloudWorkspaceCollaborationService;
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6});});
  afterAll(async()=>{await pool.end();});
  beforeEach(async()=>{
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");await runMigrations(pool);
    fixture=await seedReadyCloudWorkspace(pool);
    config={keys:{1:randomBytes(32).toString("base64url")},currentKeyVersion:1,webOrigin:"https://app.example.test"};
    service=new DatabaseCloudWorkspaceCollaborationService(pool,config);
    await service.setSharing({...scope(),sharingMode:"organization",expectedRevision:1});
  });
  const scope=()=>({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId});
  const invite=(idempotencyKey=`request-${randomUUID()}`)=>service.invite({...scope(),email:"invitee@example.test",role:"developer",idempotencyKey});
  const row=async(id:string)=>(await pool.query("SELECT * FROM cloud_workspace_invitation_deliveries WHERE invitation_id=$1",[id])).rows[0];

  it("atomically queues one encrypted delivery for concurrent identical requests and erases plaintext after sending",async()=>{
    const key=`request-${randomUUID()}`;
    const [first,second]=await Promise.all([invite(key),invite(key)]);
    expect(first.id).toBe(second.id);expect([first.replayed,second.replayed].sort()).toEqual([false,true]);
    expect((await pool.query("SELECT count(*) FROM cloud_workspace_invitation_deliveries")).rows[0].count).toBe("1");
    const queued=await row(first.id);
    expect(queued.ciphertext.toString()).not.toContain("invitee@example.test");
    expect(queued.ciphertext.includes(Buffer.from(first.token??second.token!))).toBe(false);
    const sent:Parameters<WorkspaceInvitationSender>[0][]=[];
    const sender:WorkspaceInvitationSender=async message=>{sent.push(message);return {messageId:randomUUID()};};
    const workers=[new CloudWorkspaceInvitationDeliveryWorker(pool,config,sender),new CloudWorkspaceInvitationDeliveryWorker(pool,config,sender)];
    expect((await Promise.all(workers.map(worker=>worker.runOnce()))).filter(Boolean)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain(`/workspace/${fixture.workspaceId}/invite#token=zwi_`);
    expect(await row(first.id)).toMatchObject({state:"sent",ciphertext:null,nonce:null,auth_tag:null,lease_id:null});
    await expect(invite(key)).resolves.toMatchObject({id:first.id,replayed:true,token:null});
    await expect(service.invite({...scope(),email:"different@example.test",role:"developer",idempotencyKey:key})).rejects.toMatchObject({status:409});
  });

  it("retries an ambiguous acknowledgement with the same provider key and immutable message",async()=>{
    const invitation=await invite();const calls:Parameters<WorkspaceInvitationSender>[0][]=[];
    const worker=new CloudWorkspaceInvitationDeliveryWorker(pool,config,async message=>{
      calls.push(message);if(calls.length===1)throw new EmailDeliveryError("email_timeout",true);return {messageId:"stable-provider-receipt"};
    });
    await worker.runOnce();expect(await row(invitation.id)).toMatchObject({state:"queued",attempt_count:1});
    await pool.query("UPDATE cloud_workspace_invitation_deliveries SET next_attempt_at=now() WHERE invitation_id=$1",[invitation.id]);
    await worker.runOnce();expect(calls[1]).toEqual(calls[0]);
    expect(await row(invitation.id)).toMatchObject({state:"sent",attempt_count:2,provider_message_id:"stable-provider-receipt"});
  });

  it("does not send after inviter authority changes or a request is replaced",async()=>{
    const first=await invite();const second=await invite();
    expect(await row(first.id)).toMatchObject({state:"cancelled",ciphertext:null});
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1",[fixture.userId]);
    let sends=0;const worker=new CloudWorkspaceInvitationDeliveryWorker(pool,config,async()=>{sends++;return {messageId:"unexpected"};});
    await worker.runOnce();expect(sends).toBe(0);expect(await row(second.id)).toMatchObject({state:"cancelled",ciphertext:null});
  });

  it("fences stale completion and stops retrying before provider idempotency expires",async()=>{
    const invitation=await invite();let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const worker=new CloudWorkspaceInvitationDeliveryWorker(pool,config,async()=>{entered();await gate;return {messageId:"stale"};});
    const running=worker.runOnce();await started;
    const replacement=randomUUID();
    await pool.query("UPDATE cloud_workspace_invitation_deliveries SET lease_id=$2 WHERE invitation_id=$1",[invitation.id,replacement]);
    release();await running;
    expect(await row(invitation.id)).toMatchObject({state:"sending",lease_id:replacement,provider_message_id:null});
    await pool.query("UPDATE cloud_workspace_invitation_deliveries SET lease_expires_at=now()-interval '1 second',first_attempt_at=now()-interval '23 hours' WHERE invitation_id=$1",[invitation.id]);
    expect(await worker.runOnce()).toBe(false);expect(await row(invitation.id)).toMatchObject({state:"dead",ciphertext:null,last_error_code:"delivery_window_closed"});
  });

  it("rejects a tampered envelope and erases it without attempting delivery",async()=>{
    const invitation=await invite();
    await pool.query("UPDATE cloud_workspace_invitation_deliveries SET auth_tag=decode(repeat('00',16),'hex') WHERE invitation_id=$1",[invitation.id]);
    let sends=0;const worker=new CloudWorkspaceInvitationDeliveryWorker(pool,config,async()=>{sends++;return {messageId:"unexpected"};});
    await worker.runOnce();expect(sends).toBe(0);expect(await row(invitation.id)).toMatchObject({state:"dead",ciphertext:null,last_error_code:"invitation_envelope_invalid"});
  });

  it("does not pin a database connection during an email request and cancels a revoked invitation",async()=>{
    const invitation=await invite();let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const single=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:1,connectionTimeoutMillis:500});
    const worker=new CloudWorkspaceInvitationDeliveryWorker(single,config,async()=>{entered();await gate;return {messageId:"late-receipt"};});
    const running=worker.runOnce();
    try {await started;await expect(single.query("SELECT 1 AS ready")).resolves.toMatchObject({rows:[{ready:1}]});
      await service.revokeInvitation({...scope(),invitationId:invitation.id});}
    finally {release();await running;await single.end();}
    expect(await row(invitation.id)).toMatchObject({state:"cancelled",ciphertext:null,provider_message_id:null});
  });
});
