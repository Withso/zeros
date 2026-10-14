import { createHash, randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { devWorkOSConfigurationIssue } from "../../apps/desktop/electron/dev-workos-auth-policy";
import { WorkOSDesktopClient, validateWorkOSDesktopTokenClaims, type WorkOSDesktopClientConfig, type WorkOSDesktopTokenClaims, type WorkOSDesktopSession } from "../../apps/desktop/electron/workos-desktop-client";
import { createCloudReplicaDeviceCredential, parseCloudReplicaDeviceCredential, type CloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { HttpCloudReplicaEnrollmentClient } from "../../apps/desktop/src/engine/cloud-replica-client";
import { AgentFileStore } from "./agent-file.mjs";
import { ALPHA_APP_ORIGIN, ALPHA_ORIGIN, assertSameFixture, parseFixture, type AgentValues, type Fixture } from "./config";
import { ZerosDevError } from "./errors";
import { AlphaTransport } from "./transport";

type LockedFile={readonly values:AgentValues;update(values:Record<string,string>):Promise<void>};
type Dependencies={now?:()=>number;verifyToken?:(token:string,config:WorkOSDesktopClientConfig)=>Promise<WorkOSDesktopTokenClaims>;
  desktopClient?:(config:WorkOSDesktopClientConfig)=>Pick<WorkOSDesktopClient,"refresh">};
const sessionSchema=z.object({accessToken:z.string().min(1).max(64*1024),refreshToken:z.string().min(1).max(64*1024),expiresAt:z.number().int().positive().safe(),
  providerSubject:z.string().min(1),sessionId:z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),clientKind:z.literal("desktop"),email:z.string().email(),
  name:z.string().nullable(),authenticationMethod:z.literal("Password")}).strict();
const meSchema=z.object({user:z.object({id:z.string().uuid(),email:z.string().email(),staffRole:z.null()}),
  organizations:z.array(z.object({id:z.string().uuid(),isPersonal:z.boolean()})).max(1000)});
const emptySession={ZEROS_DEV_ACCESS_TOKEN:"",ZEROS_DEV_REFRESH_TOKEN:"",ZEROS_DEV_SESSION_ID:"",ZEROS_DEV_TOKEN_EXPIRES_AT:""};

/** One CLI invocation binds one account/session. Refresh uses the desktop's
 * exact rotation semantics, inside the canonical credential file's lock. */
export class ZerosDevSession {
  private fixtureValue?:Fixture;
  private contract?:WorkOSDesktopClientConfig;
  private keys?:ReturnType<typeof createRemoteJWKSet>;
  private sessionId:string|null=null;
  private readonly now:()=>number;
  constructor(readonly store:AgentFileStore,readonly transport:AlphaTransport,private readonly dependencies:Dependencies={}){this.now=dependencies.now??Date.now;}
  private bound(values:AgentValues):Fixture {
    const fixture=parseFixture(values);
    if(this.fixtureValue)assertSameFixture(this.fixtureValue,fixture);else this.fixtureValue=fixture;
    return fixture;
  }
  async fixture():Promise<Fixture>{return this.bound((await this.store.read()).values);}
  accountSessionKey():string|null{return this.sessionId&&this.fixtureValue?`${this.fixtureValue.accountId}:${this.sessionId}`:null;}
  private bindSession(id:string):void{if(this.sessionId&&this.sessionId!==id)throw new ZerosDevError("identity_changed");this.sessionId=id;}
  private async authConfig():Promise<WorkOSDesktopClientConfig>{
    if(this.contract)return this.contract;
    const result=z.object({version:z.literal(1),environment:z.literal("alpha"),env:z.object({AUTH_PROVIDER:z.literal("workos"),AUTH_DESKTOP_CLIENT_ID:z.string(),
      AUTH_ISSUER:z.string(),AUTH_JWKS_URL:z.string(),AUTH_AUDIENCE:z.string(),VITE_APP_BASE_URL:z.string(),VITE_CONTROL_PLANE_URL:z.string()})})
      .safeParse(await this.transport.json("/auth/desktop/dev-config"));
    if(!result.success)throw new ZerosDevError("auth_contract");
    const env=result.data.env;
    if(devWorkOSConfigurationIssue({auth:{provider:"workos",desktopClientId:env.AUTH_DESKTOP_CLIENT_ID,issuer:env.AUTH_ISSUER,jwksUrl:env.AUTH_JWKS_URL,audience:env.AUTH_AUDIENCE},
      appOrigin:env.VITE_APP_BASE_URL,controlPlaneOrigin:env.VITE_CONTROL_PLANE_URL})||env.VITE_APP_BASE_URL!==ALPHA_APP_ORIGIN)throw new ZerosDevError("auth_contract");
    this.contract={clientId:env.AUTH_DESKTOP_CLIENT_ID,issuer:env.AUTH_ISSUER,jwksUrl:env.AUTH_JWKS_URL,audience:env.AUTH_AUDIENCE};
    return this.contract;
  }
  private async verify(token:string,fixture:Fixture,sessionId:string):Promise<WorkOSDesktopTokenClaims>{
    const config=await this.authConfig();
    let claims:WorkOSDesktopTokenClaims;
    try{
      if(this.dependencies.verifyToken)claims=await this.dependencies.verifyToken(token,config);
      else {
        this.keys??=createRemoteJWKSet(new URL(config.jwksUrl),{timeoutDuration:5_000,cooldownDuration:300_000});
        const {payload}=await jwtVerify(token,this.keys,{issuer:config.issuer,audience:config.audience,algorithms:["RS256"],requiredClaims:["exp","iat","sub","sid","jti","client_id"]});
        claims=validateWorkOSDesktopTokenClaims(payload,config);
      }
    }catch{throw new ZerosDevError("auth_contract");}
    if(claims.providerSubject!==fixture.subject||claims.sessionId!==sessionId||claims.email!==fixture.email||!claims.emailVerified||
      claims.clientId!==config.clientId||claims.clientKind!=="desktop")throw new ZerosDevError("identity_changed");
    if(claims.expiresAt*1000<=this.now())throw new ZerosDevError("login_required");
    return claims;
  }
  private async checkAccount(accessToken:string,fixture:Fixture):Promise<void>{
    const parsed=meSchema.safeParse(await this.transport.json("/v1/me",{token:accessToken}));
    if(!parsed.success||parsed.data.user.id!==fixture.accountId||parsed.data.user.email!==fixture.email||
      !parsed.data.organizations.some(org=>org.id===fixture.organizationId&&!org.isPersonal))throw new ZerosDevError("identity_changed");
  }
  private credential(values:AgentValues,fixture:Fixture):CloudReplicaDeviceCredential|null{
    const raw=values.ZEROS_DEV_DEVICE_PRIVATE_KEY_B64;if(!raw)return null;
    try{
      if(raw.length>8192||Buffer.from(raw,"base64").toString("base64")!==raw)throw new Error();
      const key=parseCloudReplicaDeviceCredential(JSON.parse(Buffer.from(raw,"base64").toString("utf8")));
      if(key.accountUserId!==fixture.accountId)throw new Error();return key;
    }catch{throw new ZerosDevError("credentials_invalid");}
  }
  private async saveSession(current:LockedFile,session:WorkOSDesktopSession):Promise<void>{
    await current.update({ZEROS_DEV_ACCESS_TOKEN:session.accessToken,ZEROS_DEV_REFRESH_TOKEN:session.refreshToken,
      ZEROS_DEV_SESSION_ID:session.sessionId,ZEROS_DEV_TOKEN_EXPIRES_AT:String(session.expiresAt)});
  }
  private async enroll(current:LockedFile,accessToken:string,fixture:Fixture):Promise<void>{
    const credential=this.credential(current.values,fixture);
    if(!credential)throw new ZerosDevError("credentials_invalid");
    if(credential.deviceId)return;
    const fingerprint=createHash("sha256").update(Buffer.from(credential.publicKey,"base64url")).digest("hex");
    const client=new HttpCloudReplicaEnrollmentClient({baseUrl:ALPHA_ORIGIN,getAccessToken:async()=>accessToken,
      fetch:(url,init)=>this.transport.fetchImpl(url,{...init,credentials:"omit",redirect:"error"})});
    const {device}=await client.registerDevice({label:"zd-linux",platform:"linux",publicKey:credential.publicKey,idempotencyKey:`zd-device:${fingerprint}`});
    if(device.platform!=="linux"||device.keyVersion!==credential.keyVersion||device.keyFingerprint!==fingerprint||device.trustState!=="trusted")
      throw new ZerosDevError("identity_changed");
    await current.update({ZEROS_DEV_DEVICE_PRIVATE_KEY_B64:Buffer.from(JSON.stringify({...credential,deviceId:device.id})).toString("base64")});
  }
  async login():Promise<void>{
    await this.store.locked(async(current:LockedFile)=>{
      const fixture=this.bound(current.values);
      await this.authConfig(); // prove Alpha's public contract before sending secrets
      if(current.values.ZEROS_DEV_REFRESH_TOKEN)throw new ZerosDevError("operation_conflict");
      const password=current.values.ZEROS_DEV_PASSWORD;
      if(!password||password.length>1024)throw new ZerosDevError("credentials_invalid");
      let credential=this.credential(current.values,fixture);
      if(!credential){credential=createCloudReplicaDeviceCredential(fixture.accountId);
        await current.update({ZEROS_DEV_DEVICE_PRIVATE_KEY_B64:Buffer.from(JSON.stringify(credential)).toString("base64")});}
      const raw=await this.transport.json("/auth/zeros-dev/session",{method:"POST",timeoutMs:8_000,
        body:{password,requestId:randomUUID(),device:{id:credential.deviceId??randomUUID(),intent:credential.deviceId?"reuse":"register",platform:"linux"}}});
      // Recover only enough of the trusted Alpha response to attempt normal
      // current-session cleanup. An invalid envelope must not discard a grant.
      const received=z.object({session:sessionSchema.pick({accessToken:true,sessionId:true}).strip()}).safeParse(raw);
      if(!received.success)throw new ZerosDevError("auth_unknown_issuance");
      try{
        const parsed=z.object({accountId:z.string().uuid(),organizationId:z.string().uuid(),session:sessionSchema}).strict().safeParse(raw);
        if(!parsed.success)throw new ZerosDevError("auth_contract");
        const {session}=parsed.data;
        if(parsed.data.accountId!==fixture.accountId||parsed.data.organizationId!==fixture.organizationId||session.providerSubject!==fixture.subject||session.email!==fixture.email||
          (this.sessionId&&this.sessionId!==session.sessionId))throw new ZerosDevError("identity_changed");
        const claims=await this.verify(session.accessToken,fixture,session.sessionId);
        if(session.expiresAt!==claims.expiresAt*1000)throw new ZerosDevError("auth_contract");
        await this.checkAccount(session.accessToken,fixture);
        await this.saveSession(current,session);this.bindSession(session.sessionId);
      }catch(error){
        const {session}=received.data;
        await this.transport.json("/auth/desktop-revoke",{method:"POST",token:session.accessToken,body:{scope:"current"},timeoutMs:5_000}).catch(()=>{});
        // A save can complete before its confirmation fails. Clear only this
        // grant through the still-owned transaction; never bypass inode checks
        // or remove a different session. Neither cleanup attempt proves revoke.
        if(current.values.ZEROS_DEV_SESSION_ID===session.sessionId&&current.values.ZEROS_DEV_ACCESS_TOKEN===session.accessToken)
          await current.update(emptySession).catch(()=>{});
        throw error;
      }
      await this.enroll(current,received.data.session.accessToken,fixture);
    });
  }
  async accessToken():Promise<string>{
    return this.store.locked(async(current:LockedFile)=>{
      const fixture=this.bound(current.values), values=current.values;
      const sessionId=values.ZEROS_DEV_SESSION_ID;
      if(!sessionId||!values.ZEROS_DEV_REFRESH_TOKEN)throw new ZerosDevError("login_required");
      this.bindSession(sessionId);
      if(values.ZEROS_DEV_ACCESS_TOKEN&&Number(values.ZEROS_DEV_TOKEN_EXPIRES_AT)>this.now()+30_000){
        await this.verify(values.ZEROS_DEV_ACCESS_TOKEN,fixture,sessionId);return values.ZEROS_DEV_ACCESS_TOKEN;
      }
      const config=await this.authConfig();
      const desktop=this.dependencies.desktopClient?.(config)??new WorkOSDesktopClient({config,timeoutMs:5_000,
        fetch:(url,init)=>this.transport.fetchImpl(url,{...init,credentials:"omit",redirect:"error"})});
      const result=await desktop.refresh({refreshToken:values.ZEROS_DEV_REFRESH_TOKEN,expectedSubject:fixture.subject,expectedSessionId:sessionId});
      if(result.status==="terminal"){await current.update(emptySession);this.sessionId=null;throw new ZerosDevError("login_required");}
      if(result.status==="transient"){
        if(result.replacementRefreshToken)await current.update({ZEROS_DEV_REFRESH_TOKEN:result.replacementRefreshToken,ZEROS_DEV_ACCESS_TOKEN:"",ZEROS_DEV_TOKEN_EXPIRES_AT:""});
        throw new ZerosDevError("auth_unavailable");
      }
      if(result.session.email!==fixture.email||result.session.providerSubject!==fixture.subject||result.session.sessionId!==sessionId)throw new ZerosDevError("identity_changed");
      // WorkOS has already rotated this fixed-session token. Persist its
      // replacement before another verification/network operation can fail.
      await current.update({ZEROS_DEV_REFRESH_TOKEN:result.session.refreshToken,ZEROS_DEV_ACCESS_TOKEN:"",ZEROS_DEV_TOKEN_EXPIRES_AT:""});
      await this.verify(result.session.accessToken,fixture,sessionId);
      await this.saveSession(current,result.session);return result.session.accessToken;
    });
  }
  async whoami():Promise<Fixture>{const token=await this.accessToken(),fixture=await this.fixture();await this.checkAccount(token,fixture);return fixture;}
  async device():Promise<CloudReplicaDeviceCredential>{
    const token=await this.accessToken();
    return this.store.locked(async(current:LockedFile)=>{
      const fixture=this.bound(current.values);this.bindSession(current.values.ZEROS_DEV_SESSION_ID);
      await this.enroll(current,token,fixture);const credential=this.credential(current.values,fixture);
      if(!credential?.deviceId)throw new ZerosDevError("credentials_invalid");return credential;
    });
  }
  async logout():Promise<void>{
    const token=await this.accessToken();
    await this.store.locked(async(current:LockedFile)=>{
      this.bound(current.values);this.bindSession(current.values.ZEROS_DEV_SESSION_ID);
      await this.transport.json("/auth/desktop-revoke",{method:"POST",token,body:{scope:"current"}});
      await current.update(emptySession);this.sessionId=null;
    });
  }
}
