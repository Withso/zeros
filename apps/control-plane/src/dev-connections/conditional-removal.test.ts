import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {DevConnectionClient} from "./client.js";
const request={version:1 as const,operationId:randomUUID(),connectionId:randomUUID(),bindingId:randomUUID(),expectedRevision:1,
  expectedConsentRevision:1,scope:"organization" as const};
const reply={version:1,operationId:request.operationId,connectionId:request.connectionId,scope:request.scope,removed:true};
const client=(fetcher:typeof fetch)=>new DevConnectionClient({deployment:"dev",enabled:true,origin:"https://connections.example.test",
  generation:{id:randomUUID(),credential:"a".repeat(43),audience:"zeros-dev-connections-v1"}},fetcher);
describe("conditional Dev removal client",()=>{
  it("uses only the new strict conditional path and exact frozen identity",async()=>{
    let body:unknown,path:string|undefined;
    const result=await client(async(url,init)=>{path=String(url);body=JSON.parse(String(init?.body));return Response.json(reply);}).removeConditionally("synthetic-member-token",request);
    expect(path).toBe("https://connections.example.test/v1/connections/removals");expect(body).toEqual(request);expect(result).toEqual(reply);
  });
  for(const change of [{operationId:randomUUID()},{connectionId:randomUUID()},{scope:"global"},{removed:false},{unexpected:"secret"}])
    it(`refuses an unusable or mismatched broker receipt ${Object.keys(change)[0]}`,async()=>{
      await expect(client(async()=>Response.json({...reply,...change})).removeConditionally("synthetic-member-token",request)).rejects.toThrow();
    });
});
