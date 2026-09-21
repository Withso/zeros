import {randomBytes,randomUUID} from "node:crypto";
import http from "node:http";
import {exportJWK,generateKeyPair,SignJWT} from "jose";
import {Hono} from "hono";
import pg from "pg";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {createAuthMiddleware,ensureUser,type AuthedUser} from "../auth.js";
import {loadConfig} from "../config.js";
import {HttpError} from "../authz.js";
import {runMigrations} from "../migrate.js";
import {createCloudWorkspaceCollaborationRoutes} from "./collaboration-routes.js";
import {openWorkspaceInvitation} from "./invitation-envelope.js";
import {seedReadyCloudWorkspace} from "./test-fixtures.js";

const d=process.env.TEST_DATABASE_URL?describe:describe.skip;
d("cloud workspace collaboration HTTP",()=>{
  let pool:pg.Pool,app:Hono,actor:AuthedUser,owner:AuthedUser,guest:AuthedUser;
  let fixture:Awaited<ReturnType<typeof seedReadyCloudWorkspace>>,secret:string;
  const current=(id:string)=>ensureUser(pool,{provider:"workos",providerSubject:`workos|${id}`,email:`durable-${id}@example.test`,displayName:"HTTP actor"});
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});});
  afterAll(async()=>{await pool.end();});
  beforeEach(async()=>{
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");await runMigrations(pool);
    fixture=await seedReadyCloudWorkspace(pool);owner=await current(fixture.userId);
    const guestFixture=await seedReadyCloudWorkspace(pool);guest=await current(guestFixture.userId);actor=owner;
    secret=randomBytes(32).toString("base64url");app=new Hono();
    app.use("*",async(c,next)=>{c.set("user",actor);await next();});
    app.onError((error,c)=>{if(error instanceof HttpError)return c.json({error:{code:error.code}},error.status as 403);throw error;});
    app.route("/",createCloudWorkspaceCollaborationRoutes(pool,{keys:{1:secret},currentKeyVersion:1,webOrigin:"https://app.example.test"}));
  });
  const base=()=>`/v1/cloud-workspaces/${fixture.workspaceId}`;
  const request=(path:string,method:string,body?:unknown,key?:string)=>app.request(path,{method,
    headers:{"content-type":"application/json",...(key?{"idempotency-key":key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const share=()=>request(`${base()}/sharing`,"PATCH",{sharingMode:"organization",expectedRevision:1});
  const invite=(key=`http-${randomUUID()}`)=>request(`${base()}/invitations`,"POST",{email:guest.email,role:"developer"},key);
  async function token(id:string) {
    const row=(await pool.query("SELECT * FROM cloud_workspace_invitation_deliveries WHERE invitation_id=$1",[id])).rows[0];
    return openWorkspaceInvitation({nonce:row.nonce,ciphertext:row.ciphertext,authTag:row.auth_tag},
      {invitationId:id,workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,keyVersion:row.key_version},{1:secret}).token;
  }
  it("accepts only the verified recipient and exact workspace, without returning or logging its bearer",async()=>{
    expect((await share()).status).toBe(200);
    const key=`http-${randomUUID()}`,created=await invite(key);expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const metadata=await created.json();expect(metadata).not.toHaveProperty("token");expect(metadata.invitation).not.toHaveProperty("token");
    const capability=await token(metadata.invitation.id);
    const replay=await invite(key);expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({replayed:true,invitation:{id:metadata.invitation.id}});
    expect((await request("/v1/cloud-workspace-invitations/accept","POST",{token:capability,workspaceId:fixture.workspaceId})).status).toBe(404);
    actor=guest;
    expect((await request("/v1/cloud-workspace-invitations/accept","POST",{token:capability,workspaceId:randomUUID()})).status).toBe(404);
    expect((await pool.query("SELECT accepted_at FROM cloud_workspace_invitations WHERE id=$1",[metadata.invitation.id])).rows[0].accepted_at).toBeNull();
    const accepted=await request("/v1/cloud-workspace-invitations/accept","POST",{token:capability,workspaceId:fixture.workspaceId});
    expect(accepted.status).toBe(200);expect(await accepted.json()).toMatchObject({workspaceId:fixture.workspaceId,path:`/workspace/${fixture.workspaceId}`});
    expect((await pool.query("SELECT 1 FROM organization_members WHERE org_id=$1 AND user_id=$2",[fixture.organizationId,guest.id])).rowCount).toBe(0);
    expect((await app.request(`${base()}/collaborators`)).status).toBe(403);
    actor=owner;
    const listing=await app.request(`${base()}/collaborators`);expect(await listing.json()).toMatchObject({guests:[{userId:guest.id,role:"developer"}]});
    expect((await request(`${base()}/collaborators/${guest.id}`,"DELETE")).status).toBe(200);
    actor=guest;expect((await request("/v1/cloud-workspace-invitations/accept","POST",{token:capability,workspaceId:fixture.workspaceId})).status).toBe(404);
  });
  it("rejects unprivileged changes, unversioned sharing, and invitations without request identity",async()=>{
    expect((await share()).status).toBe(200);
    expect((await request(`${base()}/sharing`,"PATCH",{sharingMode:"private",expectedRevision:1})).status).toBe(409);
    expect((await request(`${base()}/invitations`,"POST",{email:guest.email,role:"developer"})).status).toBe(422);
    actor=guest;expect((await invite()).status).toBe(404);
    expect((await request(`${base()}/sharing`,"PATCH",{sharingMode:"private",expectedRevision:2})).status).toBe(404);
    expect((await pool.query("SELECT count(*) FROM cloud_workspace_invitations")).rows[0].count).toBe("0");
  });
  it("accepts a returning guest through JWT middleware using its current verified email",async()=>{
    expect((await share()).status).toBe(200);
    // The stable profile may legitimately retain an earlier address. The
    // signed current claim, exact identity link and invitation must still agree.
    const subject=`user_${randomUUID()}`;
    await pool.query("UPDATE user_identities SET provider_sub=$2 WHERE user_id=$1 AND provider='workos'",[guest.id,subject]);
    await pool.query("UPDATE users SET email=$2 WHERE id=$1",[guest.id,`profile-${randomUUID()}@example.test`]);
    const created=await invite();expect(created.status).toBe(201);
    const capability=await token((await created.json()).invitation.id);
    const keys=await generateKeyPair('RS256'),jwk={...await exportJWK(keys.publicKey),kid:'collaboration-fixture'};
    const server=http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({keys:[jwk]}));});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{
      const address=server.address();if(!address||typeof address==='string')throw Error('JWKS listener unavailable');
      const issuer='https://identity.example.test/user_management/client_web';
      const config=loadConfig({DATABASE_URL:process.env.TEST_DATABASE_URL,AUTH_PROVIDER:'workos',APP_ORIGIN:'https://app.example.test',
        AUTH_ISSUER:issuer,AUTH_JWKS_URL:`http://127.0.0.1:${address.port}/jwks`,AUTH_AUDIENCE:'https://api.example.test',
        AUTH_WEB_CLIENT_ID:'client_web',AUTH_DESKTOP_CLIENT_ID:'client_desktop',WORKOS_API_KEY:'fixture',
        WORKOS_COOKIE_PASSWORD:'qualification-cookie-password'.repeat(2),WORKOS_WEBHOOK_SECRET:'qualification-webhook-secret'});
      const authenticated=new Hono();authenticated.use('*',createAuthMiddleware(config,pool));
      authenticated.onError((error,c)=>{if(error instanceof HttpError)return c.json({error:{code:error.code}},error.status as 403);throw error;});
      authenticated.route('/',createCloudWorkspaceCollaborationRoutes(pool,null));
      const jwt=await new SignJWT({sid:`session_${randomUUID()}`,client_id:'client_web',
        'https://zeros.build/email':guest.email,'https://zeros.build/email_verified':true})
        .setProtectedHeader({alg:'RS256',kid:'collaboration-fixture'}).setIssuer(issuer).setAudience('https://api.example.test')
        .setSubject(subject).setJti(randomUUID()).setIssuedAt().setExpirationTime('15m').sign(keys.privateKey);
      const accepted=await authenticated.request('/v1/cloud-workspace-invitations/accept',{method:'POST',
        headers:{'content-type':'application/json',authorization:`Bearer ${jwt}`},body:JSON.stringify({token:capability,workspaceId:fixture.workspaceId})});
      expect(accepted.status).toBe(200);expect(await accepted.json()).toMatchObject({workspaceId:fixture.workspaceId});
      expect((await pool.query('SELECT 1 FROM organization_members WHERE org_id=$1 AND user_id=$2',[fixture.organizationId,guest.id])).rowCount).toBe(0);
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
});
