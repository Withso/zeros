import {randomBytes,randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {openCloudAgentCredential,parseCloudAgentCredential,sealCloudAgentCredential} from "./agent-credential-envelope.js";

describe("personal agent credential envelope",()=>{
  it("binds every ciphertext to its exact owner, credential, version and authentication mode",()=>{
    const key=randomBytes(32).toString("base64url"),binding={credentialId:randomUUID(),ownerUserId:randomUUID(),version:1,keyVersion:1,kind:"cursor-api-key" as const};
    const material={kind:"cursor-api-key" as const,apiKey:"synthetic-credential-for-test"};
    const envelope=sealCloudAgentCredential(material,binding,key);
    expect(openCloudAgentCredential(envelope,binding,{1:key})).toEqual(material);
    for(const change of [{credentialId:randomUUID()},{ownerUserId:randomUUID()},{version:2},{kind:"claude-api-key" as const}])
      expect(()=>openCloudAgentCredential(envelope,{...binding,...change},{1:key})).toThrow();
    expect(()=>openCloudAgentCredential(envelope,binding,{1:randomBytes(32).toString("base64url")})).toThrow();
    envelope.ciphertext[0]^=1;expect(()=>openCloudAgentCredential(envelope,binding,{1:key})).toThrow();
  });
  it("rejects malformed, excessive and unknown credential fields without reflecting their values",()=>{
    for(const value of [null,{kind:"cursor-api-key",apiKey:"secret\nmalformed"},{kind:"cursor-api-key",apiKey:"x".repeat(16_385)},
      {kind:"codex-chatgpt",accessToken:"synthetic-test-access-token",accountId:"account",expiresAt:NaN},
      {kind:"codex-chatgpt",accessToken:"synthetic-test-access-token",accountId:"account",expiresAt:Date.now()+3600_000},
      {kind:"cursor-api-key",apiKey:"界".repeat(16384)},
      {kind:"cursor-api-key",apiKey:"synthetic-test-access-token",upstream:"https://untrusted.test"}])
      expect(()=>parseCloudAgentCredential(value)).toThrow("Invalid agent credential material");
  });
  it("round-trips mixed-case UUID input after database UUID canonicalization",()=>{
    const key=randomBytes(32).toString("base64url"),binding={credentialId:randomUUID().toUpperCase(),ownerUserId:randomUUID().toUpperCase(),version:1,keyVersion:1,kind:"cursor-api-key" as const};
    const material={kind:"cursor-api-key" as const,apiKey:"synthetic-credential-for-test"};
    const envelope=sealCloudAgentCredential(material,binding,key);
    expect(openCloudAgentCredential(envelope,{...binding,credentialId:binding.credentialId.toLowerCase(),ownerUserId:binding.ownerUserId.toLowerCase()},{1:key})).toEqual(material);
  });
});
