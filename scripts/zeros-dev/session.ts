import { createHash, randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { devWorkOSConfigurationIssue } from "../../apps/desktop/electron/dev-workos-auth-policy";
import { authTokenVerifyOptions, validateAuthTokenClaims, type AuthTokenContractConfig, type AuthTokenClaims } from "../../apps/control-plane/src/auth-token-contract";
import { createCloudReplicaDeviceCredential, parseCloudReplicaDeviceCredential, type CloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { HttpCloudReplicaEnrollmentClient } from "../../apps/desktop/src/engine/cloud-replica-client";
import { AgentFileStore } from "./agent-file.mjs";
import { ALPHA_APP_ORIGIN, ALPHA_ORIGIN, assertSameFixture, assertSameIdentity, assertRepositoryPins, repositoryPins, parseFixture, parseIdentity, type AgentValues, type Fixture, type FixtureIdentity, type RepositorySelection } from "./config";
import { ZerosDevError } from "./errors";
import { AlphaTransport } from "./transport";

type LockedFile={readonly values:AgentValues;update(values:Record<string,string>):Promise<void>};
type Dependencies={now?:()=>number;verifyToken?:(token:string,config:AuthTokenContractConfig)=>Promise<AuthTokenClaims>};
const sessionSchema=z.object({accessToken:z.string().min(1).max(64*1024),refreshToken:z.string().min(1).max(64*1024),expiresAt:z.number().int().positive().safe(),
  providerSubject:z.string().min(1),sessionId:z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),clientKind:z.literal("web"),email:z.string().email(),
  name:z.string().nullable(),authenticationMethod:z.literal("Password")}).strict();
const meSchema=z.object({user:z.object({id:z.string().uuid(),email:z.string().email(),staffRole:z.null()}),
  organizations:z.array(z.object({id:z.string().uuid(),isPersonal:z.boolean()})).max(1000)});
const emptySession={ZEROS_DEV_ACCESS_TOKEN:"",ZEROS_DEV_REFRESH_TOKEN:"",ZEROS_DEV_SESSION_ID:"",ZEROS_DEV_TOKEN_EXPIRES_AT:""};

/** One CLI invocation binds one account/session. Confidential-client refresh
 * runs on Alpha, inside the canonical credential file's rotation lock. */
export class ZerosDevSession {
  private identityValue?:FixtureIdentity;
  private fixtureValue?:Fixture;
  private contract?:AuthTokenContractConfig;
  private keys?:ReturnType<typeof createRemoteJWKSet>;
  private sessionId:string|null=null;
  private readonly now:()=>number;
  constructor(readonly store:AgentFileStore,readonly transport:AlphaTransport,private readonly dependencies:Dependencies={}){this.now=dependencies.now??Date.now;}
  private bound(values:AgentValues):FixtureIdentity {
    const identity=parseIdentity(values);
    if(this.identityValue)assertSameIdentity(this.identityValue,identity);else this.identityValue=identity;
    // Once repository-dependent work binds the complete fixture, token use
    // still fences every pin just as before. Login itself needs no repository.
    if(this.fixtureValue)assertSameFixture(this.fixtureValue,parseFixture(values));
    return identity;
  }
  async identity():Promise<FixtureIdentity>{return this.bound((await this.store.read()).values);}
  async fixture():Promise<Fixture>{
    const {values}=await this.store.read();this.bound(values);
    const fixture=parseFixture(values);
    if(this.fixtureValue)assertSameFixture(this.fixtureValue,fixture);else this.fixtureValue=fixture;
    return fixture;
  }
  async checkRepositoryPins(repository:RepositorySelection&{installationId?:string}):Promise<void>{
    const {values}=await this.store.read();this.bound(values);assertRepositoryPins(values,repository);
  }
  async pinRepository(repository:Fixture["repository"]):Promise<void>{
    await this.store.locked(async(current:LockedFile&{pinRepository(values:Record<string,string>):Promise<void>})=>{
      this.bound(current.values);this.bindSession(current.values.ZEROS_DEV_SESSION_ID);
      if(!this.sessionId)throw new ZerosDevError("login_required");
      const changes=repositoryPins(repository),fixture=parseFixture({...current.values,...changes});
      assertRepositoryPins(current.values,fixture.repository);
      await current.pinRepository(changes);
      this.fixtureValue=fixture;
    });
  }
  accountSessionKey():string|null{return this.sessionId&&this.identityValue?`${this.identityValue.accountId}:${this.sessionId}`:null;}
  private bindSession(id:string):void{if(this.sessionId&&this.sessionId!==id)throw new ZerosDevError("identity_changed");this.sessionId=id;}
  private async authConfig():Promise<AuthTokenContractConfig>{
    if(this.contract)return this.contract;
    const result=z.object({version:z.literal(1),environment:z.literal("alpha"),env:z.object({AUTH_PROVIDER:z.literal("workos"),AUTH_DESKTOP_CLIENT_ID:z.string(),
      AUTH_ISSUER:z.string(),AUTH_JWKS_URL:z.string(),AUTH_AUDIENCE:z.string(),VITE_APP_BASE_URL:z.string(),VITE_CONTROL_PLANE_URL:z.string()})})
      .safeParse(await this.transport.json("/auth/desktop/dev-config"));
    if(!result.success)throw new ZerosDevError("auth_contract");
    const env=result.data.env;
    if(devWorkOSConfigurationIssue({auth:{provider:"workos",desktopClientId:env.AUTH_DESKTOP_CLIENT_ID,issuer:env.AUTH_ISSUER,jwksUrl:env.AUTH_JWKS_URL,audience:env.AUTH_AUDIENCE},
      appOrigin:env.VITE_APP_BASE_URL,controlPlaneOrigin:env.VITE_CONTROL_PLANE_URL})||env.VITE_APP_BASE_URL!==ALPHA_APP_ORIGIN)throw new ZerosDevError("auth_contract");
    // Alpha discovery already pins the issuer and JWKS to this exact WorkOS
    // environment. Its issuer carries the web client ID; do not reinterpret
    // that client as the public desktop application.
    const webClientId=/^https:\/\/api\.workos\.com\/user_management\/(client_[A-Za-z0-9_-]{1,240})$/.exec(env.AUTH_ISSUER)?.[1];
    if(!webClientId||webClientId===env.AUTH_DESKTOP_CLIENT_ID)throw new ZerosDevError("auth_contract");
    this.contract={webClientId,desktopClientId:env.AUTH_DESKTOP_CLIENT_ID,issuer:env.AUTH_ISSUER,audience:env.AUTH_AUDIENCE};
    this.keys??=createRemoteJWKSet(new URL(env.AUTH_JWKS_URL),{timeoutDuration:5_000,cooldownDuration:300_000});
    return this.contract;
  }
  private async verify(token:string,fixture:FixtureIdentity,sessionId:string):Promise<AuthTokenClaims>{
    const config=await this.authConfig();
    let claims:AuthTokenClaims;
    try{
      if(this.dependencies.verifyToken)claims=await this.dependencies.verifyToken(token,config);
      else {
        const {payload}=await jwtVerify(token,this.keys!,authTokenVerifyOptions(config));
        claims=validateAuthTokenClaims(payload,config);
      }
    }catch{throw new ZerosDevError("auth_contract");}
    if(claims.providerSubject!==fixture.subject||claims.sessionId!==sessionId||claims.email!==fixture.email||!claims.emailVerified||
      claims.clientId!==config.webClientId||claims.clientKind!=="web")throw new ZerosDevError("identity_changed");
    if(claims.expiresAt*1000<=this.now())throw new ZerosDevError("login_required");
    return claims;
  }
  private async checkAccount(accessToken:string,fixture:FixtureIdentity):Promise<void>{
    const parsed=meSchema.safeParse(await this.transport.json("/v1/me",{token:accessToken}));
    if(!parsed.success||parsed.data.user.id!==fixture.accountId||parsed.data.user.email!==fixture.email||
      !parsed.data.organizations.some(org=>org.id===fixture.organizationId&&!org.isPersonal))throw new ZerosDevError("identity_changed");
  }
  private credential(values:AgentValues,fixture:FixtureIdentity):CloudReplicaDeviceCredential|null{
    const raw=values.ZEROS_DEV_DEVICE_PRIVATE_KEY_B64;if(!raw)return null;
    try{
      if(raw.length>8192||Buffer.from(raw,"base64").toString("base64")!==raw)throw new Error();
      const key=parseCloudReplicaDeviceCredential(JSON.parse(Buffer.from(raw,"base64").toString("utf8")));
      if(key.accountUserId!==fixture.accountId)throw new Error();return key;
    }catch{throw new ZerosDevError("credentials_invalid");}
  }
  private async saveSession(current:LockedFile,session:z.infer<typeof sessionSchema>):Promise<void>{
    await current.update({ZEROS_DEV_ACCESS_TOKEN:session.accessToken,ZEROS_DEV_REFRESH_TOKEN:session.refreshToken,
      ZEROS_DEV_SESSION_ID:session.sessionId,ZEROS_DEV_TOKEN_EXPIRES_AT:String(session.expiresAt)});
  }
  private lifecycleRequest(current:LockedFile){
    const credential=this.credential(current.values,this.bound(current.values));
    if(!credential)throw new ZerosDevError("credentials_invalid");
    return {requestId:randomUUID(),device:{id:credential.deviceId??randomUUID(),intent:"reuse",platform:"linux"}};
  }
  private async revoke(current:LockedFile,token:string):Promise<void>{
    await this.transport.json("/auth/zeros-dev/revoke",{method:"POST",token,body:this.lifecycleRequest(current),timeoutMs:8_000});
  }
  private async enroll(current:LockedFile,accessToken:string,fixture:FixtureIdentity):Promise<void>{
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
        await this.revoke(current,session.accessToken).catch(()=>{});
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
      if(!sessionId||!values.ZEROS_DEV_REFRESH_TOKEN||!values.ZEROS_DEV_ACCESS_TOKEN)throw new ZerosDevError("login_required");
      this.bindSession(sessionId);
      if(values.ZEROS_DEV_ACCESS_TOKEN&&Number(values.ZEROS_DEV_TOKEN_EXPIRES_AT)>this.now()+30_000){
        await this.verify(values.ZEROS_DEV_ACCESS_TOKEN,fixture,sessionId);return values.ZEROS_DEV_ACCESS_TOKEN;
      }
      await this.authConfig();
      let raw:unknown;
      try{raw=await this.transport.json("/auth/zeros-dev/refresh",{method:"POST",token:values.ZEROS_DEV_ACCESS_TOKEN,timeoutMs:8_000,
        body:{...this.lifecycleRequest(current),refreshToken:values.ZEROS_DEV_REFRESH_TOKEN}});}
      catch(error){
        if(error instanceof ZerosDevError&&error.code==="auth_denied"){
          await current.update(emptySession);this.sessionId=null;throw new ZerosDevError("login_required");
        }
        throw new ZerosDevError("auth_unavailable");
      }
      const parsed=z.object({accountId:z.string().uuid(),organizationId:z.string().uuid(),session:sessionSchema}).strict().safeParse(raw);
      if(!parsed.success)throw new ZerosDevError("auth_contract");
      const {session}=parsed.data;
      if(parsed.data.accountId!==fixture.accountId||parsed.data.organizationId!==fixture.organizationId||session.email!==fixture.email||
        session.providerSubject!==fixture.subject||session.sessionId!==sessionId)throw new ZerosDevError("identity_changed");
      // WorkOS has already rotated this fixed-session token. Persist its
      // replacement before another verification/network operation can fail.
      // Keep the previous signed token solely as lifecycle proof if local
      // verification fails. Clearing expiry prevents its use as an API bearer.
      await current.update({ZEROS_DEV_REFRESH_TOKEN:session.refreshToken,ZEROS_DEV_TOKEN_EXPIRES_AT:""});
      const claims=await this.verify(session.accessToken,fixture,sessionId);
      if(session.expiresAt!==claims.expiresAt*1000)throw new ZerosDevError("auth_contract");
      await this.saveSession(current,session);return session.accessToken;
    });
  }
  async whoami():Promise<FixtureIdentity>{const token=await this.accessToken(),identity=await this.identity();await this.checkAccount(token,identity);return identity;}
  async device():Promise<CloudReplicaDeviceCredential>{
    const token=await this.accessToken();
    return this.store.locked(async(current:LockedFile)=>{
      const fixture=this.bound(current.values);this.bindSession(current.values.ZEROS_DEV_SESSION_ID);
      await this.enroll(current,token,fixture);const credential=this.credential(current.values,fixture);
      if(!credential?.deviceId)throw new ZerosDevError("credentials_invalid");return credential;
    });
  }
  async logout():Promise<void>{
    await this.store.locked(async(current:LockedFile)=>{
      this.bound(current.values);this.bindSession(current.values.ZEROS_DEV_SESSION_ID);
      const token=current.values.ZEROS_DEV_ACCESS_TOKEN;
      if(!this.sessionId||!token)throw new ZerosDevError("login_required");
      // Expired proof can retire this recorded fixture session without first
      // rotating it. It is never used on an ordinary product route.
      await this.revoke(current,token);
      await current.update(emptySession);this.sessionId=null;
    });
  }
}
