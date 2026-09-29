import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { deployPersistentDevConnections } from "../dev-environment/hosted-connections.mjs";

it.each(["bootstrap-complete", "runtime-readiness", "final-receipt"])("resumes persistent deployment after losing %s without replaying a superseded bootstrap", async fault => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "connection-recovery-"));
  try {
    const id=randomUUID(), environment=randomUUID(), database=randomUUID(), broker=randomUUID();
    const inventory:any={id,environments:{edges:[],pageInfo:{hasNextPage:false}},services:{edges:[],pageInfo:{hasNextPage:false}},volumes:{edges:[],pageInfo:{hasNextPage:false}}};
    const deployments=new Map<string,any>(); let bootstrap:string|undefined, uploads=0, failed=false, persisted:any;
    const lease={state:{kind:"persistent-dev-connections",resources:{}} as any,fence:async()=>{},save:async()=>{
      if(!failed && (fault==="final-receipt" && lease.state.deployedDigest || fault==="bootstrap-complete" && lease.state.bootstrapCompletedDigest)) {
        failed=true; throw new Error("Synthetic lost receipt");
      }
      persisted=structuredClone(lease.state);
    }};
    const request=async(query:string,variables:any)=>{
      if(query.includes("query DevConnectionInventory"))return {project:inventory};
      const add=(collection:string,name:string,id=randomUUID())=>{const node={id,name,createdAt:new Date().toISOString()};inventory[collection].edges.push({node});return node;};
      if(query.includes("environmentCreate"))return {environmentCreate:add("environments",variables.input.name,environment)};
      if(query.includes("serviceCreate"))return {serviceCreate:add("services",variables.input.name,variables.input.name.endsWith("postgres")?database:broker)};
      if(query.includes("volumeCreate"))return {volumeCreate:add("volumes","data")};
      if(query.includes("serviceInstanceDeployV2")){const dep=randomUUID();deployments.set(dep,{serviceId:database,status:"SUCCESS"});return {serviceInstanceDeployV2:dep};}
      if(query.includes("query ConnectionDeployment"))return {deployment:{id:variables.id,projectId:id,environmentId:environment,...deployments.get(variables.id)}};
      if(query.includes("query ConnectionDomains"))return {domains:{serviceDomains:[]}};
      if(query.includes("serviceDomainCreate"))return {serviceDomainCreate:{id:randomUUID(),domain:"connections.example.test"}};
      return {};
    };
    const digest="b".repeat(64),archive=path.join(directory,"source.tar.gz"),bytes=Buffer.from("synthetic-source"); fs.writeFileSync(archive,bytes);
    const fetcher=async(url:any)=>{
      if(String(url).endsWith("/healthz")){
        if(fault==="runtime-readiness"&&!failed){failed=true;throw new Error("Synthetic lost readiness response");}
        return Response.json({service:"dev-connections",mode:"runtime",build:digest});
      }
      const dep=randomUUID();deployments.set(dep,{serviceId:broker,status:"SUCCESS"});
      if(uploads++===0)bootstrap=dep;else deployments.get(bootstrap!).status="REMOVED";
      return Response.json({deploymentId:dep});
    };
    const config={deployment:"dev",projectId:id,disposableProjectId:randomUUID(),apiToken:"synthetic",postgresImage:`postgres:18-alpine@sha256:${"c".repeat(64)}`,
      serviceVariables:{DEV_CONNECTIONS_WORKOS_ORGANIZATION_ID:"org_test"}};
    const artifact={archive,archiveSha256:createHash("sha256").update(bytes).digest("hex"),digest};
    await expect(deployPersistentDevConnections(lease,config,artifact,request,fetcher).then(()=>undefined)).rejects.toThrow();
    expect(failed).toBe(true);
    lease.state=structuredClone(persisted);
    if(fault==="final-receipt")delete lease.state.bootstrapCompletedDigest; // Pre-fix receipt compatibility.
    await expect(deployPersistentDevConnections(lease,config,artifact,request,fetcher).then(result=>result.origin)).resolves.toBe("https://connections.example.test");
    expect(lease.state.deployedDigest).toBe(digest); expect(uploads).toBe(2);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
