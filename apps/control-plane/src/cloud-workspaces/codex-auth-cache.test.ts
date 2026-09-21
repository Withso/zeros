import {randomBytes,randomUUID} from "node:crypto";
import {describe,it,expect} from "vitest";
import {parseCodexNativeCache,sealCodexNativeCache,openCodexNativeCache,codexRefreshFingerprint} from "./codex-auth-cache.js";
import {syntheticCodexCache} from "./codex-auth-test-fixture.js";
describe("private native Codex cache",()=>{
  it("projects access only and requires consistent account, subject and provider identity",()=>{
    const cache=syntheticCodexCache(),parsed=parseCodexNativeCache(cache);
    expect(parsed.material).toEqual({kind:"codex-chatgpt",accessToken:cache.tokens.access_token,accountId:"synthetic-account",expiresAt:expect.any(Number)});
    expect(JSON.stringify(parsed.material)).not.toContain("refresh");
    for(const value of [{...cache,auth_mode:"chatgptAuthTokens"},{...cache,OPENAI_API_KEY:"private-sentinel"},{...cache,config:{endpoint:"untrusted"}},
      {...cache,tokens:{...cache.tokens,account_id:"other"}},{...cache,tokens:{...cache.tokens,id_token:syntheticCodexCache({subject:"other"}).tokens.id_token}}])
      expect(()=>parseCodexNativeCache(value)).toThrow("Invalid Codex native authentication cache");
  });
  it("separately authenticates owner, consent, material epoch and encryption key",()=>{
    const key=randomBytes(32).toString("base64url"),binding={credentialId:randomUUID(),ownerUserId:randomUUID(),revision:1,version:2,keyVersion:1},cache=syntheticCodexCache();
    const envelope=sealCodexNativeCache(cache,binding,key);
    expect(openCodexNativeCache(envelope,binding,{1:key}).cache).toEqual(cache);
    for(const changed of [{revision:2},{version:3},{ownerUserId:randomUUID()},{credentialId:randomUUID()}])
      expect(()=>openCodexNativeCache(envelope,{...binding,...changed},{1:key})).toThrow();
    expect(()=>openCodexNativeCache({...envelope,ciphertext:Buffer.alloc(65537)},binding,{1:key})).toThrow();
  });
  it("uses purpose-separated keyed fingerprints without exposing the seed",()=>{
    const key=randomBytes(32).toString("base64url"),other=randomBytes(32).toString("base64url"),seed=syntheticCodexCache().tokens.refresh_token;
    expect(codexRefreshFingerprint(seed,key)).toEqual(codexRefreshFingerprint(seed,key));expect(codexRefreshFingerprint(seed,key)).not.toEqual(codexRefreshFingerprint(seed,other));
  });
});
