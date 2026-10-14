import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentFileStore } from "../zeros-dev/agent-file.mjs";
import { ZerosDevSession } from "../zeros-dev/session";
import { parseFixture } from "../zeros-dev/config";
import { AlphaTransport } from "../zeros-dev/transport";
import { parseCloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";

const account="11111111-1111-4111-8111-111111111111", org="22222222-2222-4222-8222-222222222222", device="33333333-3333-4333-8333-333333333333";
const values={ZEROS_DEV_WORKOS_SUBJECT:"user_fixture",ZEROS_DEV_ACCOUNT_ID:account,ZEROS_DEV_EMAIL:"fixture@example.test",
  ZEROS_DEV_ORGANIZATION_ID:org,ZEROS_DEV_REPOSITORY:"test-owner/test-repo",ZEROS_DEV_REPOSITORY_ID:"1234",
  ZEROS_DEV_GITHUB_INSTALLATION_ID:"44444444-4444-4444-8444-444444444444",ZEROS_DEV_PASSWORD:"synthetic-password"};
const now=1_800_000_000_000;
const claims={providerSubject:values.ZEROS_DEV_WORKOS_SUBJECT,sessionId:"session_fixture",tokenId:"token_fixture",clientId:"client_web_fixture",clientKind:"web" as const,
  email:values.ZEROS_DEV_EMAIL,emailVerified:true as const,displayName:null,avatarUrl:null,authTime:null,issuedAt:now/1000,expiresAt:now/1000+300};
const grant={accessToken:"synthetic-access",refreshToken:"synthetic-refresh",expiresAt:now+300_000,providerSubject:claims.providerSubject,sessionId:claims.sessionId,
  clientKind:"web",email:claims.email,name:null,authenticationMethod:"Password"};
const config={version:1,environment:"alpha",env:{AUTH_PROVIDER:"workos",AUTH_DESKTOP_CLIENT_ID:"client_desktop_fixture",
  AUTH_ISSUER:"https://api.workos.com/user_management/client_web_fixture",AUTH_JWKS_URL:"https://api.workos.com/sso/jwks/client_web_fixture",
  AUTH_AUDIENCE:"https://api-alpha.zeros.build",VITE_APP_BASE_URL:"https://app-alpha.zeros.build",VITE_CONTROL_PLANE_URL:"https://api-alpha.zeros.build"}};
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

async function fixture(initial:Record<string,string>=values) {
  const root=await mkdtemp(path.join(tmpdir(),"zeros-dev-session-"));directories.push(root);
  const file=path.join(root,".env.agent");
  await writeFile(file,Object.entries({...initial,BOAT_API_KEY:"synthetic-infra-never-send"}).map(([k,v])=>`${k}=${v}`).join("\n")+"\n",{mode:0o600});
  const store=new AgentFileStore(file);
  const fetcher=vi.fn<typeof fetch>(async(url,init)=>{
    const pathname=new URL(String(url)).pathname;
    if(pathname==="/auth/desktop/dev-config")return Response.json(config);
    if(pathname==="/auth/zeros-dev/session")return Response.json({accountId:account,organizationId:org,session:grant});
    if(pathname==="/v1/me")return Response.json({user:{id:account,email:claims.email,staffRole:null},organizations:[{id:org,isPersonal:false}]});
    if(pathname==="/v1/devices")return Response.json({replayed:false,device:{id:device,label:"zd-linux",platform:"linux",trustState:"trusted",keyAlgorithm:"ed25519",keyVersion:1,
      keyFingerprint:createHash("sha256").update(Buffer.from(JSON.parse(String(init?.body)).publicKey,"base64url")).digest("hex")}});
    if(pathname==="/auth/zeros-dev/revoke")return Response.json({ok:true});
    throw new Error("unexpected synthetic request");
  });
  const verify=vi.fn(async()=>({...claims}));
  const transport=new AlphaTransport(fetcher);
  const session=new ZerosDevSession(store,transport,{now:()=>now,verifyToken:verify});
  return {store,file,fetcher,session,verify,transport};
}

describe("Alpha zeros-dev session keeps the verified web contract",()=>{
  it("accepts the pinned web grant without weakening or impersonating the desktop contract",async()=>{
    const f=await fixture(),original=f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/auth/zeros-dev/session")?
      Response.json({accountId:account,organizationId:org,session:{...grant,clientKind:"web"}}):original(url,init));
    f.verify.mockResolvedValue({...claims,clientKind:"web",clientId:"client_web_fixture"} as never);
    await expect(f.session.login()).resolves.toBeUndefined();
    expect(await f.session.accessToken()).toBe(grant.accessToken);
    expect(f.verify).toHaveBeenCalledWith(grant.accessToken,expect.objectContaining({webClientId:"client_web_fixture",desktopClientId:"client_desktop_fixture"}));
  });

  it.each(["missing","blank","partial"])("logs in with %s repository pins before GitHub can connect",async kind=>{
    const initial:Record<string,string>={...values};
    for(const key of ["ZEROS_DEV_REPOSITORY","ZEROS_DEV_REPOSITORY_ID","ZEROS_DEV_GITHUB_INSTALLATION_ID"])delete initial[key];
    if(kind==="blank")Object.assign(initial,{ZEROS_DEV_REPOSITORY:"",ZEROS_DEV_REPOSITORY_ID:"",ZEROS_DEV_GITHUB_INSTALLATION_ID:""});
    if(kind==="partial")initial.ZEROS_DEV_REPOSITORY=values.ZEROS_DEV_REPOSITORY;
    const f=await fixture(initial);
    await expect(f.session.login()).resolves.toBeUndefined();
    expect(await f.session.whoami()).toEqual({subject:claims.providerSubject,accountId:account,email:claims.email,organizationId:org});
    expect((await f.session.device()).deviceId).toBe(device);
    await expect(f.session.fixture()).rejects.toThrow("zeros_dev_fixture_invalid");
    expect(f.fetcher.mock.calls.some(([url])=>String(url).endsWith("/auth/zeros-dev/session"))).toBe(true);
  });

  it("keeps identity-only whoami independent of removed repository pins",async()=>{
    const f=await fixture();await f.session.login();
    const contents=(await readFile(f.file,"utf8")).split("\n").filter(line=>!/^ZEROS_DEV_(REPOSITORY|REPOSITORY_ID|GITHUB_INSTALLATION_ID)=/.test(line)).join("\n");
    await writeFile(f.file,contents);
    expect(await f.session.whoami()).toEqual({subject:claims.providerSubject,accountId:account,email:claims.email,organizationId:org});
    await expect(f.session.fixture()).rejects.toThrow("zeros_dev_fixture_invalid");
    await expect(f.session.logout()).resolves.toBeUndefined();
  });

  it("keeps a complete fixture bound for repository-dependent work",async()=>{
    const f=await fixture();await f.session.fixture();await f.session.login();
    await writeFile(f.file,(await readFile(f.file,"utf8")).replace(values.ZEROS_DEV_REPOSITORY_ID,"9876"));
    const before=f.fetcher.mock.calls.length;
    await expect(f.session.accessToken()).rejects.toThrow("zeros_dev_identity_changed");
    expect(f.fetcher.mock.calls).toHaveLength(before);
  });

  it("strictly pins account, organization, repository and WorkOS identity",()=>{
    expect(parseFixture(values)).toMatchObject({accountId:account,organizationId:org,repository:{owner:"test-owner",name:"test-repo",id:"1234"}});
    for(const [key,value] of [["ACCOUNT_ID","other"],["EMAIL","wrong"],["WORKOS_SUBJECT","other"],["REPOSITORY","../foreign"],["REPOSITORY_ID","0"],["GITHUB_INSTALLATION_ID","other"]])
      expect(()=>parseFixture({...values,[`ZEROS_DEV_${key}`]:value})).toThrow("zeros_dev_fixture_invalid");
  });

  it("verifies login and enrolls the persisted Linux device through normal product APIs",async()=>{
    const f=await fixture();await f.session.login();
    const current=await f.store.read();
    expect(current.values.ZEROS_DEV_ACCESS_TOKEN).toBe(grant.accessToken);
    expect(current.values.ZEROS_DEV_REFRESH_TOKEN).toBe(grant.refreshToken);
    const credential=parseCloudReplicaDeviceCredential(JSON.parse(Buffer.from(current.values.ZEROS_DEV_DEVICE_PRIVATE_KEY_B64,"base64").toString("utf8")));
    expect(credential).toMatchObject({accountUserId:account,deviceId:device,keyVersion:1});
    const login=f.fetcher.mock.calls.find(([url])=>String(url).endsWith("/auth/zeros-dev/session"));
    expect(JSON.parse(String(login?.[1]?.body))).toEqual({password:values.ZEROS_DEV_PASSWORD,requestId:expect.any(String),device:{id:expect.any(String),intent:"register",platform:"linux"}});
    expect(f.verify).toHaveBeenCalledWith(grant.accessToken,expect.objectContaining({webClientId:claims.clientId}));
    expect(await f.session.accessToken()).toBe(grant.accessToken);
    expect(JSON.stringify(f.fetcher.mock.calls)).not.toContain("synthetic-infra-never-send");
    for(const [,init] of f.fetcher.mock.calls)expect(init).toMatchObject({redirect:"error",credentials:"omit"});
  });

  it.each(["subject","account","organization","staff"])("refuses a foreign %s and never enrolls its device",async kind=>{
    const f=await fixture(), original=f.fetcher.getMockImplementation()!;
    if(kind==="subject")f.verify.mockResolvedValue({...claims,providerSubject:"user_foreign"});
    else f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/v1/me")?Response.json({user:{id:kind==="account"?device:account,email:claims.email,staffRole:kind==="staff"?"developer":null},organizations:[{id:kind==="organization"?device:org,isPersonal:false}]}):original(url,init));
    await expect(f.session.login()).rejects.toThrow("zeros_dev_identity_changed");
    expect(f.fetcher.mock.calls.some(([url])=>String(url).endsWith("/v1/devices"))).toBe(false);
    expect((await f.store.read()).values.ZEROS_DEV_ACCESS_TOKEN??"").toBe("");
  });

  it("refuses foreign public auth configuration before sending a password",async()=>{
    const f=await fixture();f.fetcher.mockResolvedValue(Response.json({...config,env:{...config.env,VITE_CONTROL_PLANE_URL:"https://api.zeros.build"}}));
    await expect(f.session.login()).rejects.toThrow("zeros_dev_auth_contract");
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("attempts normal current-session revocation if local verification fails after a grant",async()=>{
    const f=await fixture();f.verify.mockRejectedValue(new Error("synthetic JWKS failure"));
    await expect(f.session.login()).rejects.toThrow("zeros_dev_auth_contract");
    expect(f.fetcher.mock.calls.some(([url,init])=>String(url).endsWith("/auth/zeros-dev/revoke")&&init?.method==="POST")).toBe(true);
    expect((await f.store.read()).values.ZEROS_DEV_REFRESH_TOKEN??"").toBe("");
    expect(f.fetcher.mock.calls.some(([url])=>String(url).endsWith("/v1/devices"))).toBe(false);
  });

  it.each(["envelope","malformed-envelope","save","save-confirmation"])("revokes a received grant after %s failure before canonical persistence",async kind=>{
    const f=await fixture(),originalFetch=f.fetcher.getMockImplementation()!;
    if(kind==="envelope"||kind==="malformed-envelope")f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/auth/zeros-dev/session")?
      Response.json({accountId:kind==="envelope"?device:"invalid",organizationId:org,session:grant}):originalFetch(url,init));
    else{
      const locked=f.store.locked.bind(f.store);
      f.store.locked=work=>locked(current=>work({
        get values(){return current.values;},
        update:async(changes:Record<string,string>)=>{
          if(changes.ZEROS_DEV_ACCESS_TOKEN){
            if(kind==="save-confirmation")await current.update(changes);
            throw new Error("synthetic canonical save failure");
          }
          return current.update(changes);
        },
      }));
    }
    await expect(f.session.login()).rejects.toThrow();
    expect(f.fetcher.mock.calls.filter(([url,init])=>String(url).endsWith("/auth/zeros-dev/revoke")&&init?.method==="POST")).toHaveLength(1);
    expect((await f.store.read()).values.ZEROS_DEV_REFRESH_TOKEN??"").toBe("");
    expect(f.session.accountSessionKey()).toBeNull();
    expect(f.fetcher.mock.calls.some(([url])=>String(url).endsWith("/v1/devices"))).toBe(false);
  });

  it("keeps an unparseable received issuance explicitly unknown",async()=>{
    const f=await fixture(),original=f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/auth/zeros-dev/session")?Response.json({accountId:account,organizationId:org,session:null}):original(url,init));
    await expect(f.session.login()).rejects.toThrow("zeros_dev_auth_unknown_issuance");
    expect(f.fetcher.mock.calls.some(([url])=>String(url).endsWith("/auth/zeros-dev/revoke"))).toBe(false);
  });

  it("sends refresh only to Alpha and preserves rotation if local verification is unavailable",async()=>{
    const f=await fixture();await f.session.login();
    await f.store.locked(current=>current.update({ZEROS_DEV_TOKEN_EXPIRES_AT:String(now-1)}));
    const original=f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/auth/zeros-dev/refresh")?
      Response.json({accountId:account,organizationId:org,session:{...grant,refreshToken:"synthetic-rotated"}}):original(url,init));
    f.verify.mockRejectedValueOnce(new Error("synthetic JWKS unavailable"));
    await expect(f.session.accessToken()).rejects.toThrow("zeros_dev_auth_contract");
    expect((await f.store.read()).values.ZEROS_DEV_REFRESH_TOKEN).toBe("synthetic-rotated");
    expect((await f.store.read()).values.ZEROS_DEV_ACCESS_TOKEN).toBe(grant.accessToken);
    expect((await f.store.read()).values.ZEROS_DEV_TOKEN_EXPIRES_AT).toBe("");
    const refresh=f.fetcher.mock.calls.find(([url])=>String(url).endsWith("/auth/zeros-dev/refresh"))!;
    expect(refresh[0]).toBe("https://api-alpha.zeros.build/auth/zeros-dev/refresh");
    expect(new Headers(refresh[1]?.headers).get("authorization")).toBe(`Bearer ${grant.accessToken}`);
    expect(JSON.parse(String(refresh[1]?.body))).toEqual({requestId:expect.any(String),device:{id:device,intent:"reuse",platform:"linux"},refreshToken:grant.refreshToken});
    expect(JSON.stringify(f.fetcher.mock.calls)).not.toContain("client_secret");
  });

  it("clears a terminal refresh, never silently falling back to a password grant",async()=>{
    const f=await fixture();await f.session.login();
    await f.store.locked(current=>current.update({ZEROS_DEV_TOKEN_EXPIRES_AT:"1"}));
    const original=f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/auth/zeros-dev/refresh")?
      Response.json({error:{code:"zeros_dev_auth_denied"}},{status:401}):original(url,init));
    const before=f.fetcher.mock.calls.length;
    await expect(f.session.accessToken()).rejects.toThrow("zeros_dev_login_required");
    expect((await f.store.read()).values.ZEROS_DEV_REFRESH_TOKEN).toBe("");
    expect(f.fetcher.mock.calls.slice(before).some(([url])=>String(url).endsWith("/auth/zeros-dev/session"))).toBe(false);
  });

  it("fences a file identity switch before using any retained access token",async()=>{
    const f=await fixture();await f.session.login();
    await writeFile(f.file,(await readFile(f.file,"utf8")).replace(values.ZEROS_DEV_ORGANIZATION_ID,device));
    const before=f.fetcher.mock.calls.length;
    await expect(f.session.accessToken()).rejects.toThrow("zeros_dev_identity_changed");
    expect(f.fetcher.mock.calls).toHaveLength(before);
  });

  it("keeps an already-rotated token if a subsequent verification becomes unavailable",async()=>{
    const f=await fixture();await f.session.login();
    await f.store.locked(current=>current.update({ZEROS_DEV_TOKEN_EXPIRES_AT:"1"}));
    const original=f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/auth/zeros-dev/refresh")?
      Response.json({accountId:account,organizationId:org,session:{...grant,refreshToken:"synthetic-rotated-verified"}}):original(url,init));
    const session=new ZerosDevSession(f.store,f.transport,{now:()=>now,verifyToken:async()=>{throw new Error("synthetic JWKS outage");}});
    await expect(session.accessToken()).rejects.toThrow("zeros_dev_auth_contract");
    expect((await f.store.read()).values.ZEROS_DEV_REFRESH_TOKEN).toBe("synthetic-rotated-verified");
    expect((await f.store.read()).values.ZEROS_DEV_ACCESS_TOKEN).toBe(grant.accessToken);
    expect((await f.store.read()).values.ZEROS_DEV_TOKEN_EXPIRES_AT).toBe("");
  });

  it("allows concurrent invocations to refresh once and consume the serialized result",async()=>{
    const f=await fixture();await f.session.login();
    await f.store.locked(current=>current.update({ZEROS_DEV_TOKEN_EXPIRES_AT:"1"}));
    const original=f.fetcher.getMockImplementation()!;
    const refresh=vi.fn(async()=>Response.json({accountId:account,organizationId:org,session:{...grant,refreshToken:"synthetic-rotated-once"}}));
    f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/auth/zeros-dev/refresh")?refresh():original(url,init));
    const options={now:()=>now,verifyToken:f.verify};
    const one=new ZerosDevSession(f.store,f.transport,options),two=new ZerosDevSession(new AgentFileStore(f.file),f.transport,options);
    expect(await Promise.all([one.accessToken(),two.accessToken()])).toEqual([grant.accessToken,grant.accessToken]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("retires an expired web session through its scoped route without refreshing or using desktop revocation",async()=>{
    const f=await fixture();await f.session.login();
    await f.store.locked(current=>current.update({ZEROS_DEV_TOKEN_EXPIRES_AT:"1"}));
    const before=f.fetcher.mock.calls.length;
    await f.session.logout();
    const calls=f.fetcher.mock.calls.slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("https://api-alpha.zeros.build/auth/zeros-dev/revoke");
    expect((await f.store.read()).values.ZEROS_DEV_ACCESS_TOKEN).toBe("");
    expect(f.session.accountSessionKey()).toBeNull();
  });

  it("bounds and closes transport errors without printing private response bodies",async()=>{
    const f=await fixture();
    f.fetcher.mockResolvedValueOnce(new Response("private-provider-diagnostic",{status:503}));
    await expect(f.transport.json("/healthz")).rejects.toThrow(/^zeros_dev_service_unavailable$/);
    await expect(f.transport.json("https://foreign.example/path")).rejects.toThrow("zeros_dev_invalid_request");
    await expect(f.transport.json("//foreign.example/path")).rejects.toThrow("zeros_dev_invalid_request");
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
});
