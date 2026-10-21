import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { cloudAgentCredentialKeys } from "./agent-credentials.js";
import { openCloudAgentCredential, sealCloudAgentCredential } from "./agent-credential-envelope.js";

const env = { DATABASE_URL: "postgres://fixture@localhost/credential-config", AUTH0_DOMAIN: "tenant.example.test", AUTH_AUDIENCE: "test" };
describe("persisted credential encryption configuration", () => {
  it("loads Dev's V1 and Alpha's versioned keyring without a legacy cloud runtime", () => {
    const first = randomBytes(32).toString("base64url"), second = randomBytes(32).toString("base64url");
    const old = cloudAgentCredentialKeys(loadConfig({ ...env, CLOUD_WORKSPACE_SECRET_KEY_V1: first }).cloudAgentCredentials!);
    const current = cloudAgentCredentialKeys(loadConfig({ ...env, CLOUD_WORKSPACE_SECRET_KEY_V1: first,
      CLOUD_WORKSPACE_SECRET_KEYS_JSON: JSON.stringify({ 2: second }), CLOUD_WORKSPACE_SECRET_CURRENT_KEY_VERSION: "2" }).cloudAgentCredentials!);
    expect(old?.currentKeyVersion).toBe(1); expect(current?.currentKeyVersion).toBe(2);
    const context = { credentialId: "00000000-0000-4000-8000-000000000001", ownerUserId: "00000000-0000-4000-8000-000000000002", kind: "cursor-api-key" as const, version: 1, keyVersion: 1 };
    const material = { kind: "cursor-api-key" as const, apiKey: "synthetic-retained-key" };
    const encrypted = sealCloudAgentCredential(material, context, first);
    expect(openCloudAgentCredential(encrypted, context, current!.keys).kind).toBe("cursor-api-key");
    expect(loadConfig(env).cloudV2).toBeNull();
  });
  it("refuses incomplete or conflicting keyrings without reflecting their values", () => {
    const first=randomBytes(32).toString("base64url"),second=randomBytes(32).toString("base64url");
    for (const extra of [
      { CLOUD_WORKSPACE_SECRET_KEY_V1: "invalid-secret-sentinel" },
      { CLOUD_WORKSPACE_SECRET_KEYS_JSON: JSON.stringify({1:first,2:second}) },
      { CLOUD_WORKSPACE_SECRET_KEY_V1:first,CLOUD_WORKSPACE_SECRET_KEYS_JSON:JSON.stringify({1:second}) },
      { CLOUD_WORKSPACE_SECRET_CURRENT_KEY_VERSION:"2",CLOUD_WORKSPACE_SECRET_KEY_V1:first },
    ]) {
      expect(()=>loadConfig({...env,...extra})).toThrow(/Invalid cloud workspace environment/);
      try {loadConfig({...env,...extra});} catch(error) { expect(String(error).includes(first)||String(error).includes(second)||String(error).includes("invalid-secret-sentinel")).toBe(false); }
    }
  });
});
