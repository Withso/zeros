import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ProductApi } from "../zeros-dev/product";
import { AlphaTransport } from "../zeros-dev/transport";
import { parseFixture } from "../zeros-dev/config";
import type { Run, RunHandle } from "../zeros-dev/receipts";
import { computerBuild, computerState } from "../../apps/desktop/src/renderer/features/settings/__tests__/cloud-computer-v2-fixtures";

const fixture=parseFixture({ZEROS_DEV_WORKOS_SUBJECT:"user_fixture",ZEROS_DEV_ACCOUNT_ID:"11111111-1111-4111-8111-111111111111",ZEROS_DEV_EMAIL:"fixture@example.test",
  ZEROS_DEV_ORGANIZATION_ID:"22222222-2222-4222-8222-222222222222",ZEROS_DEV_REPOSITORY:"test-owner/test-repo",ZEROS_DEV_REPOSITORY_ID:"1234",ZEROS_DEV_GITHUB_INSTALLATION_ID:"33333333-3333-4333-8333-333333333333"});
const repository={...fixture.repository,requestedRef:null};
const build=computerBuild({version:4});
const state=()=>computerState({state:"active",revision:12,draft:{configId:build.configId,repositories:[repository],installScript:"echo synthetic-recipe",timeoutSeconds:900,environment:[]},active:build,
  activeRepositories:[{id:repository.id,owner:repository.owner,name:repository.name,installationId:repository.installationId}]});
const workspace=()=>({id:"44444444-4444-4444-8444-444444444444",organizationId:fixture.organizationId,teamId:"55555555-5555-4555-8555-555555555555",name:"zd-fixture",createdBy:fixture.accountId,
  ownerUserId:fixture.accountId,placement:"cloud",status:"ready",capabilities:{canWrite:true,canEdit:true,canManage:true,canStart:true,startUnavailableReason:null},
  repository:{forge:"github.com",owner:repository.owner,name:repository.name,revision:"a".repeat(40)},
  generation:{number:1,architecture:"linux/amd64",resources:{cpuMillicores:2000,memoryMiB:4096,storageMiB:16384},observedState:"running",lastObservedAt:null},
  version:1,error:null,createdAt:"2026-10-12T00:00:00.000Z",updatedAt:"2026-10-12T00:00:00.000Z",deletedAt:null as string|null});
function setup(){
  let current=workspace();const snapshots:Run[]=[];
  const handle:RunHandle={run:{version:1,runId:randomUUID(),fixtureSha256:"a".repeat(64),deviceId:randomUUID(),createdAt:new Date().toISOString(),
    source:{revision:"b".repeat(40),dirty:true},lifecycle:[],prompts:[],evidence:[],deletionConfirmed:false},save:async()=>{snapshots.push(structuredClone(handle.run));}};
  const session={fixture:async()=>fixture,whoami:vi.fn(async()=>fixture),accessToken:async()=>"synthetic-account-access"};
  const fetcher=vi.fn<typeof fetch>(async(url,init)=>{
    const p=new URL(String(url)).pathname;
    if(p.endsWith("/cloud-computer/v2"))return Response.json(state());
    if(p.endsWith("/create-options"))return Response.json({configured:true,repository:{owner:repository.owner,name:repository.name,defaultBranch:"main"},installations:[{id:repository.installationId,accountLogin:repository.owner}]});
    if(p.endsWith("/builds")&&init?.method==="POST")return Response.json({revision:13,build,replayed:false});
    if(p.endsWith(`/builds/${build.id}`))return Response.json(build);
    if(p.endsWith("/pending-deletion"))return Response.json({truncated:false,pendingDeletion:[]});
    if(p.endsWith("/stop")){current={...current,status:"stopped",generation:{...current.generation,observedState:"stopped"}};}
    if(p.endsWith("/wake")){current={...current,status:"ready",generation:{...current.generation,observedState:"running"}};}
    if(init?.method==="DELETE"){current={...current,status:"deleted",deletedAt:new Date().toISOString(),generation:{...current.generation,observedState:"deleted"}};}
    return Response.json({workspace:current});
  });
  const api=new ProductApi(session,new AlphaTransport(fetcher),{sleep:async()=>{},now:()=>0});
  return {api,handle,fetcher,session,snapshots,setWorkspace:(row:ReturnType<typeof workspace>)=>{current=row;}};
}

describe("zeros-dev calls normal product lifecycle and Computer APIs",()=>{
  it("preserves T2's completed checkpoint restoration through the shared response contract",async()=>{
    const f=setup();await f.api.createWorkspace(f.handle);
    const restored={checkpointId:randomUUID(),checkpointAt:"2026-10-11T00:00:00.000Z",completedAt:"2026-10-12T00:00:00.000Z",sourceGeneration:1,generation:2};
    f.setWorkspace({...workspace(),generation:{...workspace().generation,number:2},recovery:{state:null,checkpointId:null,checkpointAt:null,sourceGeneration:1,needsAcknowledgement:false,restored}} as ReturnType<typeof workspace>);
    f.handle.run.create!.result!.generation=2;
    expect((await f.api.workspace(f.handle.run)).recovery?.restored).toEqual(restored);
  });

  it("adopts only the fixed fixture and uses Computer CAS with a saved operation ID",async()=>{
    const f=setup();expect(await f.api.ensureRepository()).toMatchObject({revision:"main"});
    await f.api.buildComputer(f.handle);
    const post=f.fetcher.mock.calls.find(([url,init])=>String(url).endsWith("/builds")&&init?.method==="POST")!;
    const body=JSON.parse(String(post[1]?.body));
    expect(body).toEqual({expectedRevision:12,operationId:f.handle.run.computer!.operationId});
    expect(f.snapshots[0]?.computer).toEqual({operationId:body.operationId,expectedRevision:12});
    expect(post[1]?.headers).toMatchObject({"idempotency-key":body.operationId});
    expect(f.handle.run.computer!.result).toEqual({id:build.id,version:4});
    expect(JSON.stringify(f.handle.run)).not.toContain("synthetic-recipe");
  });

  it("replays an unknown create with byte-identical body and key even after the active Computer changes",async()=>{
    const f=setup(), original=f.fetcher.getMockImplementation()!;let first=true;
    f.fetcher.mockImplementation(async(url,init)=>{
      if(String(url).endsWith("/cloud-workspaces")&&init?.method==="POST"&&first){first=false;expect(f.snapshots.at(-1)?.create?.body).toEqual(JSON.parse(String(init.body)));throw new Error("synthetic lost acknowledgment");}
      if(!first&&new URL(String(url)).pathname.endsWith("/cloud-computer/v2"))return Response.json({...state(),active:{...build,id:randomUUID(),version:5}});
      return original(url,init);
    });
    await expect(f.api.createWorkspace(f.handle)).rejects.toThrow("zeros_dev_service_unavailable");
    await f.api.createWorkspace(f.handle);
    const posts=f.fetcher.mock.calls.filter(([url,init])=>String(url).endsWith("/cloud-workspaces")&&init?.method==="POST");
    expect(posts).toHaveLength(2);expect(posts[0]?.[1]?.body).toBe(posts[1]?.[1]?.body);expect(posts[0]?.[1]?.headers).toEqual(posts[1]?.[1]?.headers);
    expect(f.handle.run.create?.result?.id).toBe(workspace().id);
  });

  it.each(["organizationId","createdBy","ownerUserId","repository","generation"])("refuses changed %s before cleanup writes",async field=>{
    const f=setup();await f.api.createWorkspace(f.handle);
    const foreign={...workspace(),[field]:field==="repository"?{...workspace().repository,name:"foreign"}:field==="generation"?{...workspace().generation,number:2}:randomUUID()};
    f.setWorkspace(foreign as ReturnType<typeof workspace>);const before=f.fetcher.mock.calls.length;
    await expect(f.api.cleanup(f.handle,true)).rejects.toThrow(/zeros_dev_(?:identity_changed|runtime_changed)/);
    expect(f.fetcher.mock.calls.slice(before).every(([,init])=>init?.method==="GET")).toBe(true);
  });

  it("previews exact cleanup with no writes, then verifies physical deletion before marking it complete",async()=>{
    const f=setup();await f.api.createWorkspace(f.handle);const before=f.fetcher.mock.calls.length;
    expect(await f.api.cleanup(f.handle,false)).toEqual({planned:1,confirmed:0});
    expect(f.fetcher.mock.calls.slice(before).every(([,init])=>init?.method==="GET")).toBe(true);
    expect(await f.api.cleanup(f.handle,true)).toEqual({planned:1,confirmed:1});
    expect(f.handle.run.deletionConfirmed).toBe(true);
    expect(f.fetcher.mock.calls.some(([url])=>String(url).includes("/pending-deletion"))).toBe(true);
  });

  it.each(["truncated","pending"])("does not turn a %s provider-deletion view into confirmed cleanup",async mode=>{
    const f=setup();await f.api.createWorkspace(f.handle);const original=f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/pending-deletion")?Response.json({truncated:mode==="truncated",pendingDeletion:mode==="pending"?[{workspaceId:workspace().id,generation:1}]:[]}):original(url,init));
    await expect(f.api.cleanup(f.handle,true,AbortSignal.timeout(15))).rejects.toThrow(/zeros_dev_(?:deadline|cleanup_pending)/);
    expect(f.handle.run.deletionConfirmed).toBe(false);
  });

  it("uses stop and wake product paths and never wakes for a passive status read",async()=>{
    const f=setup();await f.api.createWorkspace(f.handle);
    await f.api.lifecycle(f.handle,"stop");
    const before=f.fetcher.mock.calls.length;expect((await f.api.workspace(f.handle.run)).status).toBe("stopped");
    expect(f.fetcher.mock.calls.slice(before).every(([,init])=>init?.method==="GET")).toBe(true);
    await expect(f.api.lifecycle(f.handle,"wake")).rejects.toThrow("zeros_dev_operation_conflict");
    await f.api.waitWorkspace(f.handle,"stopped");
    await f.api.lifecycle(f.handle,"wake");expect(f.handle.run.lifecycle.map(row=>row.operation)).toEqual(["stop","wake"]);
    await f.api.waitWorkspace(f.handle,"running");
    expect(f.handle.run.lifecycle.every(row=>row.confirmed)).toBe(true);
  });

  it.each(["ready","busy"])("waits for engine %s after provider-running setup",async status=>{
    const f=setup();await f.api.createWorkspace(f.handle);
    const original=f.fetcher.getMockImplementation()!;let reads=0;
    f.fetcher.mockImplementation(async(url,init)=>{
      if(new URL(String(url)).pathname===`/v1/cloud-workspaces/${workspace().id}`){
        reads++;return Response.json({workspace:{...workspace(),status:reads===1?"setting_up":status}});
      }
      return original(url,init);
    });
    expect((await f.api.waitWorkspace(f.handle,"running")).status).toBe(status);
    expect(reads).toBe(2);
  });

  it("fails a Computer with another repository before any build mutation",async()=>{
    const f=setup();f.fetcher.mockResolvedValue(Response.json({...state(),draft:{...state().draft,repositories:[{...repository,name:"foreign"}]}}));
    await expect(f.api.buildComputer(f.handle)).rejects.toThrow("zeros_dev_repository_required");
    expect(f.fetcher.mock.calls.every(([,init])=>init?.method==="GET")).toBe(true);
  });
});
