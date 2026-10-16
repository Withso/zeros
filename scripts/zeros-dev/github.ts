import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { GithubAppClient, type GithubAppTokenResult } from "../../apps/desktop/electron/github-app-client";
import { cloudGithubCatalogSchema, cloudGithubConnectedSchema, cloudGithubSourceSchema } from "../../packages/protocol/src/github-auth";
import { ALPHA_ORIGIN, parseRepositorySelection, type RepositorySelection } from "./config";
import { assertNoCredentials } from "./evidence";
import { ZerosDevError } from "./errors";
import type { ProductApi } from "./product";
import type { ZerosDevSession } from "./session";
import { beforeDeadline } from "./transport";

/** This is the only unredacted URL the harness displays. Accept exactly the
 * product's public OAuth/PKCE request, never an arbitrary response URL. */
function authorizationUrl(raw:string):string {
  let url:URL;
  try {url=new URL(raw);}catch{throw new ZerosDevError("bad_response");}
  const fields=["client_id","redirect_uri","state","code_challenge","code_challenge_method"];
  if(raw.length>4096||url.origin!=="https://github.com"||url.username||url.password||url.hash||url.pathname!=="/login/oauth/authorize"||
    [...url.searchParams.keys()].length!==fields.length||fields.some(key=>url.searchParams.getAll(key).length!==1)||
    !/^[A-Za-z0-9_.-]{1,200}$/.test(url.searchParams.get("client_id")??"")||
    url.searchParams.get("redirect_uri")!==`${ALPHA_ORIGIN}/v1/github/oauth/callback`||
    !/^[A-Za-z0-9_-]{32,128}$/.test(url.searchParams.get("state")??"")||
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code_challenge")??"")||url.searchParams.get("code_challenge_method")!=="S256")
    throw new ZerosDevError("bad_response");
  return url.href;
}

/** Reuse the desktop's owner-bound OAuth handoff. The browser needs only its
 * GitHub session; the fixture's password and all tokens remain in Linux memory.
 * GitHub material is used for the normal product connection, never persisted. */
export async function connectGithub(session:ZerosDevSession,api:ProductApi,selection:RepositorySelection,show:(url:string)=>void,external:AbortSignal,
  options:{now?:()=>number;sleep?:(ms:number,signal:AbortSignal)=>Promise<void>}={}):Promise<void> {
  const now=options.now??Date.now,sleep=options.sleep??(async(ms,signal)=>{await delay(ms,undefined,{signal});});
  const signal=AbortSignal.any([external,AbortSignal.timeout(690_000)]);
  if(signal.aborted)throw new ZerosDevError("deadline");
  const repository=parseRepositorySelection(`${selection.owner}/${selection.name}`,selection.id);
  await session.checkRepositoryPins(repository);
  const identity=await session.whoami();
  let transportFailure:unknown;
  const client=new GithubAppClient({baseUrl:ALPHA_ORIGIN,now,fetch:async(input,init)=>{
    try {
      const url=new URL(String(input)),headers=new Headers(init?.headers);
      if(url.origin!==ALPHA_ORIGIN||url.search||url.hash||![/^\/v1\/github\/oauth\/start$/,/^\/v1\/github\/oauth\/exchange$/].some(path=>path.test(url.pathname))||
        init?.method!=="POST"||!headers.get("authorization")?.startsWith("Bearer "))throw new ZerosDevError("invalid_request");
      // Adapt the desktop serializer to the harness's bounded, redirect-free
      // transport. Closed failures survive the desktop client's own wrapping.
      const body=await api.transport.json(url.pathname,{method:"POST",body:JSON.parse(String(init.body)),token:headers.get("authorization")!.slice(7),
        signal:init.signal?AbortSignal.any([signal,init.signal]):signal,timeoutMs:15_000});
      return Response.json(body);
    }catch(error){transportFailure=error;throw error;}
  }});
  async function desktop<T>(work:()=>Promise<T>):Promise<T> {
    transportFailure=undefined;
    try{return await beforeDeadline(work(),signal);}
    catch(error){
      if(signal.aborted)throw new ZerosDevError("deadline");
      if(transportFailure instanceof ZerosDevError)throw transportFailure;
      if(error instanceof ZerosDevError)throw error;
      throw new ZerosDevError("bad_response");
    }
  }
  const nonce=randomBytes(32).toString("base64url");
  const start=await desktop(async()=>client.start(await session.accessToken(),{nonce,variantKey:"github.com",scheme:"zeros-alpha",installFlow:false}));
  // The control plane issues a ten-minute state from its own clock. Allow the
  // desktop client's fifteen-minute bound so ordinary skew cannot refuse it.
  if(start.flowKind!=="oauth"||start.expiresAtMs-now()>15*60_000)throw new ZerosDevError("bad_response");
  const url=authorizationUrl(start.authorizeUrl);
  assertNoCredentials(url,(await session.store.read()).values);
  show(url);

  // The handoff lasts 90 seconds after browser completion. Poll every 25 s
  // (below the product's 30 requests / 10 min limit), including that grace.
  const end=start.expiresAtMs+90_000;
  let credential:GithubAppTokenResult|undefined;
  for(let attempt=0;attempt<29&&now()<end;attempt++){
    try{credential=await desktop(async()=>client.exchange(await session.accessToken(),nonce));break;}
    catch(error){if(!(error instanceof ZerosDevError)||error.code!=="not_found")throw error;}
    try{await beforeDeadline(sleep(Math.min(25_000,Math.max(1,end-now())),signal),signal);}
    catch{throw new ZerosDevError("deadline");}
  }
  if(!credential)throw new ZerosDevError("deadline");
  if(credential.variantKey!=="github.com")throw new ZerosDevError("identity_changed");
  const scope={organizationId:identity.organizationId,accessToken:credential.accessToken};
  const catalog=await api.request("/v1/github/cloud",cloudGithubCatalogSchema,{method:"POST",body:{...scope,action:"catalog"},signal});
  if(!catalog.complete||catalog.login!==credential.login)throw new ZerosDevError("repository_required");
  const candidates=catalog.installations.filter(row=>row.accountLogin.toLowerCase()===repository.owner.toLowerCase());
  if(candidates.length!==1||candidates[0]!.accountType!=="Organization"||candidates[0]!.suspendedAt!==null)throw new ZerosDevError("repository_required");
  const installationId=candidates[0]!.id;
  await session.checkRepositoryPins({...repository,installationId});
  const source=await api.request("/v1/github/cloud",cloudGithubSourceSchema,{method:"POST",signal,
    body:{...scope,action:"source",installationId,owner:repository.owner,repository:repository.name}});
  if(source.installationId!==installationId||source.repository.id!==repository.id||source.repository.owner!==repository.owner||
    source.repository.name!==repository.name||!source.repository.private)throw new ZerosDevError("identity_changed");
  const connected=await api.request("/v1/github/cloud",cloudGithubConnectedSchema,{method:"POST",body:{...scope,action:"connect",installationId},signal});
  if(connected.installationId!==installationId)throw new ZerosDevError("identity_changed");
  await session.whoami();
  if(signal.aborted)throw new ZerosDevError("deadline");
  await session.pinRepository({...repository,installationId});
}
