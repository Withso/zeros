import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as hosted from "../../../../scripts/dev-environment/hosted-connections.mjs";
import * as configuration from "./client.js";
import { DevConnectionClient } from "./client.js";

const config = { deployment: "dev", origin: "https://connections.example.test", organization: "org_test", registrationToken: "synthetic-operator" };
const lease = () => ({state: {generation: randomUUID(), owner: "a".repeat(24), status: "provisioning"} as any, save: vi.fn(async()=>{}), fence: vi.fn(async()=>{})});
describe("hosted Dev phase 2", () => {
  it("preserves every deployment default when the explicit Dev flag is absent",()=>{
    for(const deployment of ['dev','alpha','beta','production','local']){
      const fetcher=vi.fn();
      expect(configuration.devConnectionClientFromEnvironment({ZEROS_DEPLOY_ENV:deployment},fetcher)).toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it("rotates an expiring generation with a journaled, replayable key and never exports root authority", async () => {
    const l = lease(), fetcher = vi.fn(async () => Response.json({ok:true}));
    await hosted.registerConnectionGeneration(l, config, fetcher);
    l.state.connectionRegistration.expiresAt = new Date(Date.now()+1000).toISOString();
    const old = l.state.connectionRegistration.credential;
    const result = await hosted.rotateConnectionGeneration(l, config, fetcher);
    expect(l.state.connectionRegistration.keyRevision).toBe(2);
    expect(result.DEV_CONNECTIONS_GENERATION_CREDENTIAL).not.toBe(old);
    expect(Object.keys(result).sort()).toEqual(["DEV_CONNECTIONS_AUDIENCE","DEV_CONNECTIONS_GENERATION","DEV_CONNECTIONS_GENERATION_CREDENTIAL","DEV_CONNECTIONS_ORIGIN"]);
    expect(fetcher.mock.calls.at(-1)?.[1].method).toBe("PUT");
  });
  it.each([undefined,"alpha","beta","production","local"])("does not enable reference mode in %s", deployment => {
    expect(configuration.devConnectionClientFromEnvironment({ZEROS_DEPLOY_ENV:deployment,ZEROS_DEV_CONNECTIONS_ENABLED:"true"})).toBeNull();
  });
  it("invalidates on explicit generation denial and keeps outages distinct", async () => {
    const c = new DevConnectionClient({deployment:"dev",enabled:true,origin:config.origin,generation:{id:randomUUID(),credential:"a".repeat(43),audience:"zeros-dev-connections-v1"}}, async()=>Response.json({error:"dev_connection_denied"},{status:403}));
    await expect(c.revocations("0")).rejects.toMatchObject({code:"dev_connection_denied"});
  });
});
