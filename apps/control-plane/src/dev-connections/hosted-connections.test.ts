import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  deployPersistentDevConnections,
  ensurePersistentDevConnections,
  connectionProtection,
  assertDisposableConnectionTarget,
  registerConnectionGeneration,
  revokeConnectionGeneration,
} from "../../../../scripts/dev-environment/hosted-connections.mjs";
const config = {
  deployment: "dev",
  origin: "https://connections.example.test",
  organization: "org_dev",
  registrationToken: "synthetic-registration-authority",
};
function lease() {
  return {
    state: {
      generation: randomUUID(),
      owner: "a".repeat(24),
      status: "provisioning",
    } as any,
    save: vi.fn(async () => {}),
    fence: vi.fn(async () => {}),
  };
}
describe("unwired hosted connection provisioning", () => {
  it("does not reuse a generation credential or acknowledge revoke at a different service origin", async () => {
    const l = lease(),
      fetcher = vi.fn(async () => Response.json({ ok: true }));
    await registerConnectionGeneration(l, config, fetcher);
    fetcher.mockClear();
    const changed = { ...config, origin: "https://other.example.test" };
    await expect(
      registerConnectionGeneration(l, changed, fetcher),
    ).rejects.toThrow();
    await expect(
      revokeConnectionGeneration(l, changed, fetcher),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("journals one generation credential before registration and replays identically", async () => {
    const l = lease(),
      calls: string[] = [],
      fetcher = vi.fn(async (_url, options) => {
        expect(l.save).toHaveBeenCalled();
        calls.push(options.body);
        return Response.json({ ok: true });
      });
    const first = await registerConnectionGeneration(l, config, fetcher),
      second = await registerConnectionGeneration(l, config, fetcher);
    expect(calls[0]).toBe(calls[1]);
    expect(first).toEqual(second);
    expect(first).not.toHaveProperty("DEV_CONNECTIONS_PROVISIONER_TOKEN");
  });
  it("retains an archive revocation task through outage, then retries without the checkout", async () => {
    const l = lease();
    await registerConnectionGeneration(l, config, async () =>
      Response.json({ ok: true }),
    );
    expect(
      await revokeConnectionGeneration(l, config, async () => {
        throw new Error("synthetic-private-error");
      }),
    ).toEqual({ revoked: false, pending: true });
    expect(l.state.connectionRevocation.pending).toBe(true);
    expect(
      await revokeConnectionGeneration(l, config, async () =>
        Response.json({ ok: true }),
      ),
    ).toEqual({ revoked: true, pending: false });
    expect(l.state.connectionRegistration).toBeUndefined();
  });
  it("protects the entire persistent project even when resource IDs are still unknown", () => {
    const receipt = { projectId: randomUUID() },
      p = connectionProtection(receipt);
    expect(() =>
      assertDisposableConnectionTarget(
        { projectId: receipt.projectId, id: randomUUID() },
        p,
      ),
    ).toThrow();
    expect(() =>
      assertDisposableConnectionTarget({ name: "zeros-dev-connections" }, p),
    ).toThrow();
    expect(() =>
      assertDisposableConnectionTarget(
        { projectId: randomUUID(), id: randomUUID(), name: "dev-owned" },
        p,
      ),
    ).not.toThrow();
  });
  it("refuses release provisioning or the disposable Railway project", async () => {
    const request = vi.fn(),
      l = lease(),
      projectId = randomUUID();
    l.state.kind = "persistent-dev-connections";
    await expect(
      ensurePersistentDevConnections(l, { deployment: "alpha" }, request),
    ).rejects.toThrow();
    await expect(
      ensurePersistentDevConnections(
        l,
        { deployment: "dev", projectId, disposableProjectId: projectId },
        request,
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("ensures persistent environment, broker, database and volume only once", async () => {
    const l = lease();
    l.state = { kind: "persistent-dev-connections" };
    const inventory = {
      id: randomUUID(),
      environments: { edges: [], pageInfo: { hasNextPage: false } },
      services: { edges: [], pageInfo: { hasNextPage: false } },
      volumes: { edges: [], pageInfo: { hasNextPage: false } },
    };
    const counts = { environment: 0, service: 0, volume: 0 };
    const request = vi.fn(async (query, variables) => {
      if (query.includes("query DevConnectionInventory"))
        return { project: inventory };
      const add = (collection: string, name: string) => {
        const row = {
          id: randomUUID(),
          name,
          createdAt: new Date().toISOString(),
        };
        (inventory as any)[collection].edges.push({ node: row });
        return row;
      };
      if (query.includes("environmentCreate")) {
        counts.environment++;
        return { environmentCreate: add("environments", variables.input.name) };
      }
      if (query.includes("serviceCreate")) {
        counts.service++;
        return { serviceCreate: add("services", variables.input.name) };
      }
      if (query.includes("volumeCreate")) {
        counts.volume++;
        return { volumeCreate: add("volumes", "database-storage") };
      }
      return {};
    });
    const cfg = {
      deployment: "dev",
      projectId: inventory.id,
      disposableProjectId: randomUUID(),
      serviceVariables: {
        ZEROS_DEPLOY_ENV: "dev",
        ZEROS_DEV_CONNECTIONS_ENABLED: "true",
        DEV_CONNECTIONS_DATABASE_URL: "synthetic-private-database",
        DEV_CONNECTIONS_ENCRYPTION_KEYS: "synthetic-encryption-ring",
        DEV_CONNECTIONS_FINGERPRINT_KEYS: "synthetic-fingerprint-ring",
      },
      databaseVariables: {
        POSTGRES_PASSWORD: "synthetic-postgres-password",
        POSTGRES_DB: "dev_connections",
      },
      postgresImage: `postgres:18-alpine@sha256:${"a".repeat(64)}`,
    };
    const first = await ensurePersistentDevConnections(l, cfg, request),
      second = await ensurePersistentDevConnections(l, cfg, request);
    expect(first).toEqual(second);
    expect(counts).toEqual({ environment: 1, service: 2, volume: 1 });
    expect(JSON.stringify(l.state)).not.toContain(
      "synthetic-postgres-password",
    );
  });
});

it("deploys dedicated roles/migrations before runtime, strips owner authority, and reuses the same source",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"connection-deploy-test-")),archive=path.join(directory,"source.tar.gz"),bytes=Buffer.from('synthetic-source');fs.writeFileSync(archive,bytes);
  try{
    const l=lease();l.state={kind:'persistent-dev-connections',resources:{}};
    const id=randomUUID(),env=randomUUID(),db=randomUUID(),service=randomUUID(),volume=randomUUID();
    const inventory:any={id,environments:{edges:[],pageInfo:{hasNextPage:false}},services:{edges:[],pageInfo:{hasNextPage:false}},volumes:{edges:[],pageInfo:{hasNextPage:false}}};
    const deployments=new Map<string,string>(),staged:any[]=[];
    const request=vi.fn(async(query:string,variables:any)=>{
      if(query.includes('query DevConnectionInventory'))return {project:inventory};
      const add=(collection:string,id:string,name:string)=>{const row={id,name,createdAt:new Date().toISOString()};inventory[collection].edges.push({node:row});return row;};
      if(query.includes('environmentCreate'))return {environmentCreate:add('environments',env,variables.input.name)};
      if(query.includes('serviceCreate'))return {serviceCreate:add('services',variables.input.name.endsWith('postgres')?db:service,variables.input.name)};
      if(query.includes('volumeCreate'))return {volumeCreate:add('volumes',volume,'data')};
      if(query.includes('serviceInstanceDeployV2')){const deployment=randomUUID();deployments.set(deployment,db);return {serviceInstanceDeployV2:deployment};}
      if(query.includes('query ConnectionDeployment'))return {deployment:{id:variables.id,projectId:id,environmentId:env,serviceId:deployments.get(variables.id),status:'SUCCESS'}};
      if(query.includes('query ConnectionDomains'))return {domains:{serviceDomains:[]}};
      if(query.includes('serviceDomainCreate'))return {serviceDomainCreate:{id:randomUUID(),domain:'connections.example.test'}};
      if(query.includes('ConnectionRuntimeVariables'))staged.push(variables.input.variables);
      return {};
    });
    const fetcher=vi.fn(async(url:any)=>{
      if(String(url).endsWith('/healthz'))return Response.json({service:'dev-connections',mode:'runtime',build:'b'.repeat(64)});
      const deploymentId=randomUUID();deployments.set(deploymentId,service);return Response.json({deploymentId});
    });
    const config={deployment:'dev',projectId:id,disposableProjectId:randomUUID(),apiToken:'synthetic-railway',postgresImage:`postgres:18-alpine@sha256:${'c'.repeat(64)}`,serviceVariables:{DEV_CONNECTIONS_WORKOS_ORGANIZATION_ID:'org_test'}};
    const artifact={archive,archiveSha256:createHash('sha256').update(bytes).digest('hex'),digest:'b'.repeat(64)};
    await deployPersistentDevConnections(l,config,artifact,request,fetcher);
    await deployPersistentDevConnections(l,config,artifact,request,fetcher);
    expect(staged).toHaveLength(2);expect(staged[0]).toHaveProperty('DEV_CONNECTIONS_ADMIN_DATABASE_URL');
    expect(staged[1]).not.toHaveProperty('DEV_CONNECTIONS_ADMIN_DATABASE_URL');expect(staged[1]).not.toHaveProperty('DEV_CONNECTIONS_MIGRATION_DATABASE_URL');
    expect(staged[1].DEV_CONNECTIONS_DATABASE_URL).toContain('zeros_connections_runtime');
    expect(l.state.resources.volume.id).toBe(volume);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
