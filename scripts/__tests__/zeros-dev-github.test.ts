import { mkdtemp, open, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentFileStore } from "../zeros-dev/agent-file.mjs";
import { ZerosDevSession } from "../zeros-dev/session";
import { ProductApi } from "../zeros-dev/product";
import { AlphaTransport } from "../zeros-dev/transport";
import { ALPHA_ORIGIN } from "../zeros-dev/config";
import { connectGithub } from "../zeros-dev/github";
import { executeCommand, parseCommand, type Services } from "../zeros-dev/commands";

/** Check the mode and read the bytes through one descriptor, not a path check-then-read. */
async function expectPrivate(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    expect((await handle.stat()).mode & 0o777).toBe(0o600);
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

const account="11111111-1111-4111-8111-111111111111",org="22222222-2222-4222-8222-222222222222";
const installation="33333333-3333-4333-8333-333333333333",other="44444444-4444-4444-8444-444444444444";
const selection={owner:"fixture-owner",name:"fixture-repo",id:"1234"};
const now=1_800_000_000_000;
const values={ZEROS_DEV_WORKOS_SUBJECT:"user_fixture",ZEROS_DEV_ACCOUNT_ID:account,ZEROS_DEV_EMAIL:"fixture@example.test",ZEROS_DEV_ORGANIZATION_ID:org,
  ZEROS_DEV_PASSWORD:"synthetic-password",ZEROS_DEV_ACCESS_TOKEN:"synthetic-account-access",ZEROS_DEV_REFRESH_TOKEN:"synthetic-account-refresh",
  ZEROS_DEV_SESSION_ID:"session_fixture",ZEROS_DEV_TOKEN_EXPIRES_AT:String(now+3600_000),BOAT_API_KEY:"synthetic-infrastructure"};
const pins={ZEROS_DEV_REPOSITORY:`${selection.owner}/${selection.name}`,ZEROS_DEV_REPOSITORY_ID:selection.id,ZEROS_DEV_GITHUB_INSTALLATION_ID:installation};
const authorizeUrl=`https://github.com/login/oauth/authorize?${new URLSearchParams({client_id:"fixture-client",redirect_uri:`${ALPHA_ORIGIN}/v1/github/oauth/callback`,
  state:"s".repeat(43),code_challenge:"c".repeat(43),code_challenge_method:"S256"})}`;
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

async function fixture(initial:Record<string,string>={}) {
  const root=await mkdtemp(path.join(tmpdir(),"zeros-dev-github-"));roots.push(root);
  const file=path.join(root,".env.agent");
  await writeFile(file,Object.entries({...values,...initial}).map(([key,value])=>`${key}=${value}`).join("\n")+"\n",{mode:0o600});
  let clock=now,exchanges=0;
  const fetcher=vi.fn<typeof fetch>(async(url,init)=>{
    const pathname=new URL(String(url)).pathname;
    if(pathname==="/auth/desktop/dev-config")return Response.json({version:1,environment:"alpha",env:{AUTH_PROVIDER:"workos",AUTH_DESKTOP_CLIENT_ID:"client_desktop_fixture",
      AUTH_ISSUER:"https://api.workos.com/user_management/client_web_fixture",AUTH_JWKS_URL:"https://api.workos.com/sso/jwks/client_web_fixture",AUTH_AUDIENCE:ALPHA_ORIGIN,
      VITE_APP_BASE_URL:"https://app-alpha.zeros.build",VITE_CONTROL_PLANE_URL:ALPHA_ORIGIN}});
    if(pathname==="/v1/me")return Response.json({user:{id:account,email:values.ZEROS_DEV_EMAIL,staffRole:null},organizations:[{id:org,isPersonal:false}]});
    if(pathname==="/v1/github/oauth/start")return Response.json({authorizeUrl,expiresAt:new Date(now+600_000).toISOString(),flowKind:"oauth"});
    if(pathname==="/v1/github/oauth/exchange"){
      if(exchanges++===0)return Response.json({error:{code:"handoff_not_found",message:"synthetic-private-diagnostic"}},{status:404});
      return Response.json({accessToken:"synthetic-github-access",refreshToken:"synthetic-github-refresh",refreshBinding:"zghrb_v1.synthetic.signature",
        expiresAtMs:now+3600_000,refreshTokenExpiresAtMs:now+86400_000,login:"fixture-login",variantKey:"github.com",installationsComplete:true,
        installations:[{suspendedAt:null,repositoryCount:1,allRepositories:false}]});
    }
    if(pathname==="/v1/github/cloud"){
      const body=JSON.parse(String(init?.body));
      if(body.action==="catalog")return Response.json({login:"fixture-login",complete:true,installUrl:"https://github.com/apps/fixture-alpha/installations/new",installations:[
        {id:other,accountLogin:"another-owner",accountType:"Organization",connected:true,suspendedAt:null},
        {id:installation,accountLogin:selection.owner,accountType:"Organization",connected:false,suspendedAt:null},
      ]});
      if(body.action==="source")return Response.json({installationId:installation,repository:{...selection,defaultBranch:"main",private:true}});
      if(body.action==="connect")return Response.json({connected:true,installationId:installation});
    }
    throw new Error("unexpected synthetic request");
  });
  const store=new AgentFileStore(file),transport=new AlphaTransport(fetcher);
  const session=new ZerosDevSession(store,transport,{now:()=>clock,verifyToken:async()=>({providerSubject:values.ZEROS_DEV_WORKOS_SUBJECT,sessionId:values.ZEROS_DEV_SESSION_ID,
    tokenId:"fixture",clientId:"client_desktop_fixture",clientKind:"desktop",email:values.ZEROS_DEV_EMAIL,emailVerified:true,displayName:null,authTime:null,issuedAt:now/1000,expiresAt:now/1000+3600})});
  const api=new ProductApi(session,transport),output:string[]=[];
  const sleep=vi.fn(async(ms:number)=>{clock+=ms;});
  const connect=(signal=AbortSignal.timeout(2000))=>connectGithub(session,api,selection,url=>{output.push(url);},signal,{now:()=>clock,sleep});
  return {file,store,session,api,fetcher,output,connect,sleep};
}

describe("headless GitHub consent uses the fixture member's normal product connection",()=>{
  it("works without repository pins, polls the desktop handoff, and saves only the confirmed member UUID",async()=>{
    const f=await fixture();await f.connect();
    expect(f.output).toEqual([authorizeUrl]);
    const start=f.fetcher.mock.calls.find(([url])=>String(url).endsWith("/oauth/start"))!;
    expect(JSON.parse(String(start[1]?.body))).toEqual({nonce:expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),variantKey:"github.com",scheme:"zeros-alpha",installFlow:false});
    const nonce=JSON.parse(String(start[1]?.body)).nonce;
    const exchanges=f.fetcher.mock.calls.filter(([url])=>String(url).endsWith("/oauth/exchange"));
    expect(exchanges).toHaveLength(2);
    for(const [,init] of exchanges)expect(JSON.parse(String(init?.body))).toEqual({nonce});
    expect(f.sleep.mock.calls[0]?.[0]).toBe(25_000);
    for(const [url,init] of f.fetcher.mock.calls){
      expect(new URL(String(url)).origin).toBe(ALPHA_ORIGIN);
      expect(init).toMatchObject({redirect:"error",credentials:"omit"});
      if(String(url).includes("/v1/"))expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${values.ZEROS_DEV_ACCESS_TOKEN}`);
    }
    const cloud=f.fetcher.mock.calls.filter(([url])=>String(url).endsWith("/github/cloud")).map(([,init])=>JSON.parse(String(init?.body)));
    expect(cloud.map(body=>body.action)).toEqual(["catalog","source","connect"]);
    expect(cloud).toEqual([
      {organizationId:org,accessToken:"synthetic-github-access",action:"catalog"},
      {organizationId:org,accessToken:"synthetic-github-access",action:"source",installationId:installation,owner:selection.owner,repository:selection.name},
      {organizationId:org,accessToken:"synthetic-github-access",action:"connect",installationId:installation},
    ]);
    expect((await f.store.read()).values).toMatchObject({...values,...pins});
    const saved=await expectPrivate(f.file);
    for(const forbidden of [nonce,"synthetic-github-access","synthetic-github-refresh","zghrb_v1.synthetic.signature"])expect(saved).not.toContain(forbidden);
  });

  it("emits only a validated authorization URL and closed completion metadata through the CLI",async()=>{
    const f=await fixture(),rows:unknown[]=[];
    const services={session:f.session,api:f.api,write:(row:unknown)=>rows.push(row),
      githubConnect:(repository:typeof selection,signal:AbortSignal,show:(url:string)=>void)=>connectGithub(f.session,f.api,repository,show,signal,{now:()=>now,sleep:f.sleep}),
    } as unknown as Services;
    const command=parseCommand(["github","connect","--repository",pins.ZEROS_DEV_REPOSITORY,"--repository-id",selection.id])!;
    expect(await executeCommand(command,services,AbortSignal.timeout(2000))).toBe(0);
    expect(rows).toContainEqual({schema:"zeros.dev-github-authorization/v1",authorizeUrl});
    expect(rows).toContainEqual(expect.objectContaining({schema:"zeros.dev-result/v1",data:{connected:true,fixture:"confirmed"}}));
    for(const secret of [...Object.values(values).filter(value=>value.startsWith("synthetic-")),"synthetic-github-access","synthetic-github-refresh","zghrb_v1.synthetic.signature"])
      expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it.each(["foreign-host","userinfo","port","foreign-callback","secret-query","duplicate-query","missing-pkce","install"])("refuses %s before displaying any URL",async kind=>{
    const f=await fixture(),original=f.fetcher.getMockImplementation()!;
    const url=new URL(authorizeUrl);
    if(kind==="foreign-host")url.hostname="foreign.example";
    if(kind==="userinfo")url.username="synthetic-user";
    if(kind==="port")url.port="8443";
    if(kind==="foreign-callback")url.searchParams.set("redirect_uri","https://foreign.example/callback");
    if(kind==="secret-query")url.searchParams.set("access_token","synthetic-github-access");
    if(kind==="duplicate-query")url.searchParams.append("state","synthetic-state");
    if(kind==="missing-pkce")url.searchParams.delete("code_challenge");
    f.fetcher.mockImplementation(async(input,init)=>String(input).endsWith("/oauth/start")?
      Response.json({authorizeUrl:url.href,expiresAt:new Date(now+600_000).toISOString(),flowKind:kind==="install"?"install":"oauth"}):original(input,init));
    await expect(f.connect()).rejects.toThrow("zeros_dev_bad_response");
    expect(f.output).toEqual([]);
    expect(f.fetcher.mock.calls.some(([input])=>String(input).endsWith("/oauth/exchange"))).toBe(false);
    expect((await f.store.read()).values.ZEROS_DEV_GITHUB_INSTALLATION_ID).toBeUndefined();
  });

  it.each(["incomplete","duplicate","suspended","user","foreign-source","foreign-id","public","foreign-connect"])("does not pin a %s catalog/source/connection",async kind=>{
    const f=await fixture(),original=f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async(input,init)=>{
      const response=await original(input,init);
      if(!String(input).endsWith("/github/cloud"))return response;
      const action=JSON.parse(String(init?.body)).action,body=await response.json();
      if(action==="catalog"){
        if(kind==="incomplete")body.complete=false;
        if(kind==="duplicate")body.installations.push({...body.installations[1],id:other});
        if(kind==="suspended")body.installations[1].suspendedAt=new Date(now).toISOString();
        if(kind==="user")body.installations[1].accountType="User";
      }
      if(action==="source"){
        if(kind==="foreign-source")body.installationId=other;
        if(kind==="foreign-id")body.repository.id="9876";
        if(kind==="public")body.repository.private=false;
      }
      if(action==="connect"&&kind==="foreign-connect")body.installationId=other;
      return Response.json(body);
    });
    await expect(f.connect()).rejects.toThrow(/^zeros_dev_(?:repository_required|identity_changed)$/);
    expect((await f.store.read()).values.ZEROS_DEV_GITHUB_INSTALLATION_ID).toBeUndefined();
  });

  it("refuses changed identity at the final locked write and preserves existing pins",async()=>{
    const f=await fixture(),pin=f.session.pinRepository.bind(f.session);
    vi.spyOn(f.session,"pinRepository").mockImplementation(async repository=>{
      await writeFile(f.file,(await readFile(f.file,"utf8")).replace(org,other));
      await pin(repository);
    });
    await expect(f.connect()).rejects.toThrow("zeros_dev_identity_changed");
    expect((await f.store.read()).values.ZEROS_DEV_GITHUB_INSTALLATION_ID).toBeUndefined();
  });

  it.each(["name","id","installation"])("refuses a conflicting saved repository %s",async kind=>{
    const f=await fixture({...pins,...(kind==="name"?{ZEROS_DEV_REPOSITORY:"another-owner/other"}:kind==="id"?{ZEROS_DEV_REPOSITORY_ID:"9876"}:{ZEROS_DEV_GITHUB_INSTALLATION_ID:other})});
    await expect(f.connect()).rejects.toThrow("zeros_dev_identity_changed");
    expect((await f.store.read()).values.ZEROS_DEV_GITHUB_INSTALLATION_ID).toBe(kind==="installation"?other:installation);
    if(kind!=="installation")expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("allows retry of the exact confirmed pins",async()=>{
    const f=await fixture(pins);await f.connect();expect((await f.store.read()).values).toMatchObject(pins);
  });

  it("bounds pending handoffs below the exchange rate limit and never pins on expiry",async()=>{
    const f=await fixture(),original=f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async(input,init)=>String(input).endsWith("/oauth/exchange")?Response.json({error:{code:"handoff_not_found"}},{status:404}):original(input,init));
    await expect(f.connect()).rejects.toThrow("zeros_dev_deadline");
    expect(f.fetcher.mock.calls.filter(([url])=>String(url).endsWith("/oauth/exchange")).length).toBeLessThan(30);
    expect((await f.store.read()).values.ZEROS_DEV_GITHUB_INSTALLATION_ID).toBeUndefined();
  });

  it("honors cancellation and closes upstream errors without retrying rejected authorization",async()=>{
    const f=await fixture(),original=f.fetcher.getMockImplementation()!;
    await expect(f.connect(AbortSignal.abort())).rejects.toThrow("zeros_dev_deadline");
    expect(f.fetcher).not.toHaveBeenCalled();
    f.fetcher.mockImplementation(async(input,init)=>String(input).endsWith("/oauth/exchange")?Response.json({error:{code:"synthetic-private-code",message:"synthetic-private-message"}},{status:401}):original(input,init));
    await expect(f.connect()).rejects.toThrow(/^zeros_dev_auth_denied$/);
    expect(f.fetcher.mock.calls.filter(([url])=>String(url).endsWith("/oauth/exchange"))).toHaveLength(1);
    expect((await f.store.read()).values.ZEROS_DEV_GITHUB_INSTALLATION_ID).toBeUndefined();
  });
});
