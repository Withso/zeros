import {randomBytes} from "node:crypto";
import {describe,it,expect} from "vitest";
import {loadCodexFingerprintKeys} from "./codex-fingerprint-keys.js";
describe("dedicated Codex fingerprint keyring",()=>{
  const key=randomBytes(32).toString("base64url"),env={CLOUD_CODEX_REFRESH_FINGERPRINT_KEYS_JSON:JSON.stringify({1:key}),CLOUD_CODEX_REFRESH_FINGERPRINT_CURRENT_KEY_VERSION:"1"};
  it("keeps optional native refresh independent from access-only credentials",()=>{expect(loadCodexFingerprintKeys({})).toBeUndefined();expect(loadCodexFingerprintKeys(env)).toEqual({keys:{1:key},currentKeyVersion:1});});
  it("rejects malformed, missing and noncanonical keys without reflecting secret input",()=>{
    for(const bad of [{...env,CLOUD_CODEX_REFRESH_FINGERPRINT_CURRENT_KEY_VERSION:"2"},{...env,CLOUD_CODEX_REFRESH_FINGERPRINT_KEYS_JSON:'["private-sentinel"]'},
      {...env,CLOUD_CODEX_REFRESH_FINGERPRINT_KEYS_JSON:JSON.stringify({1:"private-key-sentinel"})},{...env,CLOUD_CODEX_REFRESH_FINGERPRINT_CURRENT_KEY_VERSION:undefined}])
      expect(()=>loadCodexFingerprintKeys(bad)).toThrow("Invalid cloud Codex refresh fingerprint keyring");
  });
});
