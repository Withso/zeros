import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalFinalSaveSource, type CloudFinalSaveResponse } from "@zeros/protocol/cloud-final-save";
import { CloudFinalSaveCustody } from "../cloud-final-save-custody";
import type { CloudCheckpointDirective, CloudDurabilityAuthority } from "../cloud-durability-runtime";

afterEach(()=>vi.restoreAllMocks());
function fixture() {
  const source={organizationId:randomUUID(),workspaceId:randomUUID(),generation:1,engineInstanceId:randomUUID(),
    runtimeId:`r1-${"a".repeat(64)}`,bootId:randomUUID(),writerEpoch:randomUUID(),fundingOwnerUserId:randomUUID(),
    fundingOwnerEpoch:1,authorityEpoch:1,registeredAtMs:Date.now(),allocationLeaseId:randomUUID(),providerResourceId:"fixture-resource"};
  const authority={organizationId:source.organizationId,workspaceId:source.workspaceId,generation:1,
    engineInstanceId:source.engineInstanceId,heartbeatEndpoint:"https://api.example.test/internal/v1/cloud-workspaces/engine/heartbeat",
    heartbeatToken:"test-only-token"} as CloudDurabilityAuthority;
  const directive:CloudCheckpointDirective={id:randomUUID(),reason:"before_stop",deadlineAtMs:Date.now()+60_000,
    finalSave:{version:1,recoveryId:randomUUID(),attemptOrdinal:0,predecessorRequestId:null,source,
      sourceSha256:createHash("sha256").update(canonicalFinalSaveSource(source)).digest("hex"),custodyId:null,retirementId:null}};
  const alive={historical:true,mutation:true};
  const nativeCurrent=vi.fn((mutation:boolean)=>alive.historical&&(!mutation||alive.mutation));
  const custody=new CloudFinalSaveCustody(directive,authority,nativeCurrent);
  const retired:CloudFinalSaveResponse={version:1,recoveryId:directive.finalSave!.recoveryId,requestId:directive.id,attemptOrdinal:0,
    sourceSha256:directive.finalSave!.sourceSha256,custodyId:custody.custodyId,state:"retired",retirementId:randomUUID(),retryAtMs:Date.now()+5000};
  const successor:CloudCheckpointDirective={...structuredClone(directive),id:randomUUID(),deadlineAtMs:Date.now()+240_000,
    finalSave:{...directive.finalSave!,attemptOrdinal:1,predecessorRequestId:directive.id,custodyId:custody.custodyId,
      retirementId:retired.retirementId}};
  return {source,authority,directive,alive,nativeCurrent,custody,retired,successor};
}

describe("original frozen final-save custody",()=>{
  it("requires current mutation authority at successor consumption, independently of historical reads",()=>{
    const f=fixture(); f.custody.consumeRetirement(f.retired); f.alive.mutation=false;
    expect(()=>f.custody.report("reconcile",null)).not.toThrow();
    expect(()=>f.custody.accept(f.successor,f.authority)).toThrow(/custody/);
    expect(f.custody.directive.id).toBe(f.directive.id);
  });
  it("keeps the original scope, authority and deadline detached and refuses renewal",()=>{
    const f=fixture(), original=structuredClone(f.directive), originalAuthority={...f.authority};
    f.directive.deadlineAtMs+=300_000; f.source.writerEpoch=randomUUID(); f.authority.heartbeatEndpoint="https://other.example.test";
    expect(f.custody.directive).toEqual(original); expect(f.custody.authority).toEqual(originalAuthority);
    expect(()=>f.custody.accept(f.directive,f.authority)).toThrow(/custody/);
    vi.spyOn(Date,"now").mockReturnValue(original.deadlineAtMs);
    expect(()=>f.custody.assert()).toThrow(/custody/);
    expect(()=>f.custody.report("reconcile",null)).not.toThrow();
  });
  it("requires exact positive predecessor retirement and refuses process replacement",()=>{
    const f=fixture();
    expect(()=>f.custody.accept(f.successor,f.authority)).toThrow(/custody/);
    expect(()=>new CloudFinalSaveCustody(f.successor,f.authority,f.nativeCurrent)).toThrow(/custody/);
    f.custody.consumeRetirement(f.retired); f.custody.accept(f.successor,f.authority);
    expect(()=>f.custody.assert()).not.toThrow();
    expect(()=>f.custody.consumeRetirement(f.retired)).toThrow(/custody/);
    expect(()=>f.custody.accept(f.directive,f.authority)).toThrow(/custody/);
  });
  it.each(["custody","source","retirement","ordinal","predecessor","deadline"] as const)("refuses a changed successor %s",field=>{
    vi.spyOn(Date,"now").mockReturnValue(Date.now());
    const f=fixture(); f.custody.consumeRetirement(f.retired);
    if(field==="custody")f.successor.finalSave!.custodyId=randomUUID();
    if(field==="source")f.successor.finalSave={...f.successor.finalSave!,source:{...f.source,bootId:randomUUID()}};
    if(field==="retirement")f.successor.finalSave!.retirementId=randomUUID();
    if(field==="ordinal")f.successor.finalSave!.attemptOrdinal=2;
    if(field==="predecessor")f.successor.finalSave!.predecessorRequestId=randomUUID();
    if(field==="deadline")f.successor.deadlineAtMs=Date.now()+300_001;
    expect(()=>f.custody.accept(f.successor,f.authority)).toThrow();
  });
  it("rejects a late response after original native identity loss",async()=>{
    const f=fixture();
    const pending=Promise.resolve().then(()=>{f.alive.historical=false;return f.retired;});
    expect(()=>f.custody.consumeRetirement(f.retired)).not.toThrow();
    await expect(pending.then(response=>f.custody.consumeRetirement(response))).rejects.toThrow(/custody/);
  });
});
