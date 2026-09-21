import {randomBytes,randomUUID} from "node:crypto";
import pg from "pg";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {runMigrations} from "../migrate.js";
import {withSystemTx} from "../db.js";
import {seedReadyCloudWorkspace} from "./test-fixtures.js";
import {DatabaseCloudAgentCredentialService} from "./agent-credentials.js";
import {DatabaseCodexAuthRenewal,type CodexCredentialVersion} from "./codex-auth-renewal.js";
import {syntheticCodexCache} from "./codex-auth-test-fixture.js";
import {eraseCloudWorkspaceCollaborationIdentity} from "./actors.js";
const d=process.env.TEST_DATABASE_URL?describe:describe.skip;
d("durable native Codex authentication renewal",()=>{
  let pool:pg.Pool,credentials:DatabaseCloudAgentCredentialService,input:Parameters<DatabaseCloudAgentCredentialService["importCodex"]>[0];
  const keys={keys:{1:randomBytes(32).toString("base64url")},currentKeyVersion:1,refreshFingerprints:{keys:{1:randomBytes(32).toString("base64url")},currentKeyVersion:1}};
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6});});afterAll(async()=>{await pool.end();});
  beforeEach(async()=>{
    await pool.query("DROP SCHEMA public CASCADE;CREATE SCHEMA public");await runMigrations(pool);
    const f=await seedReadyCloudWorkspace(pool);credentials=new DatabaseCloudAgentCredentialService(pool,keys);
    input={ownerUserId:f.userId,credentialId:randomUUID(),operationId:randomUUID(),expectedRevision:0,displayName:"Codex",nativeCache:syntheticCodexCache()};
    await credentials.importCodex(input);
  });
  async function reserve(service:DatabaseCodexAuthRenewal){return withSystemTx(pool,async tx=>{
    const c=(await tx.query<CodexCredentialVersion>("SELECT id,owner_user_id,revision,current_version FROM cloud_agent_credentials WHERE id=$1 FOR UPDATE",[input.credentialId])).rows[0]!;
    return (await service.reserve(tx,c,true))!;
  });}
  const rotated=()=>syntheticCodexCache({refresh:`synthetic-rotated-${randomUUID()}`});
  it("retains an opaque seed fence when account erasure races native dispatch",async()=>{
    const service=new DatabaseCodexAuthRenewal(pool,keys,async(_,dispatch)=>{
      await dispatch();await withSystemTx(pool,tx=>eraseCloudWorkspaceCollaborationIdentity(tx,input.ownerUserId));
      await expect(credentials.importCodex({...input,credentialId:randomUUID(),operationId:randomUUID()})).rejects.toMatchObject({status:409});
      return rotated();
    });
    await expect(service.complete(await reserve(service))).rejects.toMatchObject({status:409});
    expect((await pool.query("SELECT credential_id FROM cloud_codex_refresh_fingerprints")).rows).toEqual([{credential_id:null}]);
  });
  it("rejects the same native seed across credentials and retains old seed rejection after rotation",async()=>{
    await expect(credentials.importCodex({...input,credentialId:randomUUID(),operationId:randomUUID()})).rejects.toMatchObject({status:409});
    const service=new DatabaseCodexAuthRenewal(pool,keys,async(_,dispatch)=>{await dispatch();return rotated();});
    await service.complete(await reserve(service));
    await expect(credentials.importCodex({...input,expectedRevision:1,operationId:randomUUID()})).rejects.toMatchObject({status:409});
    expect(await credentials.importCodex(input)).toMatchObject({replayed:true});
    expect((await pool.query("SELECT current_version FROM cloud_agent_credentials WHERE id=$1",[input.credentialId])).rows[0]!.current_version).toBe(2);
  });
  it("keeps seed tombstones enforceable across encryption rotation and detects missing or replaced fingerprint keys",async()=>{
    await withSystemTx(pool,tx=>eraseCloudWorkspaceCollaborationIdentity(tx,input.ownerUserId));
    const changed={keys:{2:randomBytes(32).toString("base64url")},currentKeyVersion:2,refreshFingerprints:{keys:{...keys.refreshFingerprints.keys,2:randomBytes(32).toString("base64url")},currentKeyVersion:2}};
    const rotatedStore=new DatabaseCloudAgentCredentialService(pool,changed);
    await expect(rotatedStore.importCodex({...input,credentialId:randomUUID(),operationId:randomUUID()})).rejects.toMatchObject({status:409});
    await rotatedStore.importCodex({...input,credentialId:randomUUID(),operationId:randomUUID(),nativeCache:rotated()});
    for(const fingerprintKeys of [{2:changed.refreshFingerprints.keys[2]},{1:randomBytes(32).toString("base64url"),2:changed.refreshFingerprints.keys[2]}]){
      const broken=new DatabaseCloudAgentCredentialService(pool,{...changed,refreshFingerprints:{keys:fingerprintKeys,currentKeyVersion:2}});
      await expect(broken.importCodex({...input,credentialId:randomUUID(),operationId:randomUUID(),nativeCache:rotated()})).rejects.toThrow("Codex refresh fingerprint keys are unavailable");
    }
    expect((await pool.query("SELECT credential_id FROM cloud_codex_refresh_fingerprints WHERE credential_id IS NULL")).rows).toEqual([{credential_id:null}]);
  });
  it("never retries a dispatched ambiguous token but may retry a reservation before native dispatch",async()=>{
    const renew=vi.fn(async(_cache,dispatch)=>{await dispatch();throw new Error("private-provider-response");});
    const service=new DatabaseCodexAuthRenewal(pool,keys,renew);
    await expect(service.complete(await reserve(service))).rejects.toMatchObject({status:409});
    await expect(reserve(service)).rejects.toMatchObject({status:409});expect(renew).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT state FROM cloud_codex_auth_caches")).rows[0]!.state).toBe("uncertain");
    await credentials.importCodex({...input,expectedRevision:1,operationId:randomUUID(),nativeCache:rotated()});
    const before=new DatabaseCodexAuthRenewal(pool,keys,async()=>{throw new Error("not spawned");});
    await expect(before.complete(await reserve(before))).rejects.toMatchObject({status:409});
    expect((await pool.query("SELECT state FROM cloud_codex_auth_caches")).rows[0]!.state).toBe("ready");
    expect(await reserve(before)).toHaveProperty("cache");
  });
  it("allows the exact uncertain attempt to publish a proven late result without reusing its seed",async()=>{
    let release!:()=>void,started!:()=>void;
    const wait=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{started=resolve;});
    const renew=vi.fn(async(_cache,dispatch)=>{await dispatch();started();await wait;return rotated();});
    const service=new DatabaseCodexAuthRenewal(pool,keys,renew),reservation=await reserve(service);
    const completion=service.complete(reservation);await ready;
    await pool.query("UPDATE cloud_codex_auth_caches SET attempt_started_at=now()-interval '20 seconds'");
    const observer=await reserve(service);expect(observer.cache).toBeUndefined();
    expect((await pool.query("SELECT state FROM cloud_codex_auth_caches")).rows[0]!.state).toBe("uncertain");
    release();await completion;
    expect((await pool.query("SELECT state,material_version FROM cloud_codex_auth_caches")).rows[0]).toEqual({state:"ready",material_version:2});
    expect(renew).toHaveBeenCalledTimes(1);
  });
  it.each(["revoke","replace","purge"])("lets %s win over a late native refresh",async action=>{
    const service=new DatabaseCodexAuthRenewal(pool,keys,async(_cache,dispatch)=>{
      await dispatch();
      if(action==="revoke")await credentials.revoke(input.ownerUserId,input.credentialId);
      else if(action==="replace")await credentials.importCodex({...input,expectedRevision:1,operationId:randomUUID(),nativeCache:rotated()});
      else await withSystemTx(pool,tx=>eraseCloudWorkspaceCollaborationIdentity(tx,input.ownerUserId));
      return rotated();
    });
    await expect(service.complete(await reserve(service))).rejects.toMatchObject({status:409});
    const cache=(await pool.query("SELECT credential_revision,material_version FROM cloud_codex_auth_caches")).rows;
    expect(cache).toEqual(action==="replace"?[{credential_revision:"2",material_version:2}]:[]);
    if(action==="purge")expect((await pool.query("SELECT credential_id FROM cloud_codex_refresh_fingerprints")).rows).toEqual([{credential_id:null}]);
  });
  it("recognizes a committed rotation after losing its acknowledgement without another native call",async()=>{
    let publication=false,lost=false;
    const wrapped={connect:async()=>{
      const client=await pool.connect();
      return new Proxy(client,{get(target,key){
        if(key==="query")return async(...args:unknown[])=>{
          const text=typeof args[0]==="string"?args[0]:"";
          if(text.startsWith("UPDATE cloud_agent_credentials SET current_version"))publication=true;
          const result=await (target.query as (...args:unknown[])=>Promise<unknown>).apply(target,args);
          if(text==="COMMIT"&&publication&&!lost){lost=true;throw new Error("synthetic-lost-commit-acknowledgement");}
          return result;
        };
        const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
      }});
    }} as unknown as pg.Pool;
    const renew=vi.fn(async(_cache,dispatch)=>{await dispatch();return rotated();}),service=new DatabaseCodexAuthRenewal(wrapped,keys,renew);
    await service.complete(await reserve(service));expect(lost).toBe(true);expect(renew).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT state,material_version FROM cloud_codex_auth_caches")).rows[0]).toEqual({state:"ready",material_version:2});
  });
  it("coalesces concurrent replicas onto one owned refresh",async()=>{
    let release!:()=>void,started!:()=>void;
    const wait=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{started=resolve;});
    const renew=vi.fn(async(_cache,dispatch)=>{await dispatch();started();await wait;return rotated();});
    const service=new DatabaseCodexAuthRenewal(pool,keys,renew),one=service.complete(await reserve(service));await ready;
    const second=await reserve(service);expect(second.cache).toBeUndefined();const two=service.complete(second);
    release();await Promise.all([one,two]);expect(renew).toHaveBeenCalledTimes(1);
  });
  it("retries only publication after a rolled-back transaction, retaining the rotated seed",async()=>{
    let failed=false;
    const wrapped={connect:async()=>{
      const client=await pool.connect();
      return new Proxy(client,{get(target,key){
        if(key==="query")return async(...args:unknown[])=>{
          const text=typeof args[0]==="string"?args[0]:"";
          if(text.startsWith("UPDATE cloud_agent_credentials SET current_version")&&!failed){
            failed=true;throw Object.assign(new Error("synthetic-publication-rollback"),{code:"40001"});
          }
          return (target.query as (...args:unknown[])=>Promise<unknown>).apply(target,args);
        };
        const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
      }});
    }} as unknown as pg.Pool;
    const fresh=rotated(),renew=vi.fn(async(_cache,dispatch)=>{await dispatch();return fresh;});
    const service=new DatabaseCodexAuthRenewal(wrapped,keys,renew);
    await service.complete(await reserve(service));expect(failed).toBe(true);expect(renew).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT state,material_version FROM cloud_codex_auth_caches")).rows[0]).toEqual({state:"ready",material_version:2});
    await expect(credentials.importCodex({...input,credentialId:randomUUID(),operationId:randomUUID(),nativeCache:fresh})).rejects.toMatchObject({status:409});
  });
  it("rejects disjoint fingerprint keyrings racing their first registry entries",async()=>{
    const secondOwner=await seedReadyCloudWorkspace(pool);
    await pool.query("TRUNCATE cloud_codex_refresh_fingerprints,cloud_codex_refresh_key_versions");
    let arrived=0,release!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve;});
    const wrapped={connect:async()=>{
      const client=await pool.connect();
      return new Proxy(client,{get(target,key){
        if(key==="query")return async(...args:unknown[])=>{
          const text=typeof args[0]==="string"?args[0]:"";
          if(text.includes("pg_advisory_xact_lock(hashtextextended($1,461205))")){
            if(++arrived===2)release();
            let timer:ReturnType<typeof setTimeout>|undefined;
            try{await Promise.race([barrier,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Fixture barrier timed out")),1500);})]);}
            finally{clearTimeout(timer);}
          }
          return (target.query as (...args:unknown[])=>Promise<unknown>).apply(target,args);
        };
        const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
      }});
    }} as unknown as pg.Pool;
    const secondKeys={...keys,refreshFingerprints:{keys:{2:randomBytes(32).toString("base64url")},currentKeyVersion:2}};
    const imports=await Promise.allSettled([keys,secondKeys].map((keyring,index)=>new DatabaseCloudAgentCredentialService(wrapped,keyring)
      .importCodex({...input,ownerUserId:index===0?input.ownerUserId:secondOwner.userId,credentialId:randomUUID(),operationId:randomUUID()})));
    expect(arrived).toBe(2);
    expect(imports.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect((await pool.query("SELECT * FROM cloud_codex_refresh_fingerprints")).rowCount).toBe(1);
  });
  it("rejects account-changing output and preserves a refresh-only rotation without claiming fresh access",async()=>{
    const changed=new DatabaseCodexAuthRenewal(pool,keys,async(_,dispatch)=>{await dispatch();return syntheticCodexCache({account:"other-account"});});
    await expect(changed.complete(await reserve(changed))).rejects.toMatchObject({status:409});
    await credentials.importCodex({...input,expectedRevision:1,operationId:randomUUID(),nativeCache:rotated()});
    const partial=new DatabaseCodexAuthRenewal(pool,keys,async(cache,dispatch)=>{await dispatch();return {...cache,tokens:{...cache.tokens,refresh_token:`synthetic-partial-${randomUUID()}`}};});
    await partial.complete(await reserve(partial));expect((await pool.query("SELECT state,material_version FROM cloud_codex_auth_caches")).rows[0]).toEqual({state:"ready",material_version:3});
  });
});
