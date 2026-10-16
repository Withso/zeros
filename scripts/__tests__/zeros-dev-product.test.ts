import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ProductApi } from "../zeros-dev/product";
import { AlphaTransport } from "../zeros-dev/transport";
import { parseFixture } from "../zeros-dev/config";
import { ZerosDevError } from "../zeros-dev/errors";
import type { Run, RunHandle } from "../zeros-dev/receipts";
import { computerBuild, computerState } from "../../apps/desktop/src/renderer/features/settings/__tests__/cloud-computer-v2-fixtures";
import { createCloudWorkspaceRoutes } from "../../apps/control-plane/src/cloud-workspaces/routes";
import { HttpError } from "../../apps/control-plane/src/authz";
import { fixtureRetirement, retireFixtureCompute } from "./zeros-dev-cleanup-fixture";

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
function setup(pinned=fixture,clock:{now?:()=>number;sleep?:(ms:number,signal?:AbortSignal)=>Promise<void>}={}){
  let current=workspace();const snapshots:Run[]=[];
  const handle:RunHandle={run:{version:1,runId:randomUUID(),fixtureSha256:"a".repeat(64),deviceId:randomUUID(),createdAt:new Date().toISOString(),
    source:{revision:"b".repeat(40),dirty:true},lifecycle:[],prompts:[],evidence:[],deletionConfirmed:false},save:async()=>{snapshots.push(structuredClone(handle.run));}};
  const session={fixture:async()=>pinned,whoami:vi.fn(async()=>pinned),accessToken:async()=>"synthetic-account-access"};
  const fetcher=vi.fn<typeof fetch>(async(url,init)=>{
    const p=new URL(String(url)).pathname;
    if(p.endsWith("/cloud-computer/v2"))return Response.json(state());
    if(p.endsWith("/create-options"))return Response.json({configured:true,repository:{owner:repository.owner,name:repository.name,defaultBranch:"main"},installations:[{id:repository.installationId,accountLogin:repository.owner}]});
    if(p.endsWith("/builds")&&init?.method==="POST")return Response.json({revision:13,build,replayed:false});
    if(p.endsWith(`/builds/${build.id}`))return Response.json(build);
    if(p.endsWith("/pending-deletion"))return Response.json({truncated:false,pendingDeletion:[]});
    if(p.endsWith("/cloud-workspaces")&&init?.method==="POST")current={...current,name:JSON.parse(String(init.body)).name};
    if(p.endsWith("/stop")){current={...current,status:"stopped",generation:{...current.generation,observedState:"stopped"}};}
    if(p.endsWith("/wake")){current={...current,status:"ready",generation:{...current.generation,observedState:"running"}};}
    if(init?.method==="DELETE"){current={...current,status:"deleted",deletedAt:new Date().toISOString(),generation:{...current.generation,observedState:"deleted"}};}
    return Response.json({workspace:current});
  });
  const api=new ProductApi(session,new AlphaTransport(fetcher),{sleep:async()=>{},now:()=>0,...clock});
  return {api,handle,fetcher,session,snapshots,setWorkspace:(row:ReturnType<typeof workspace>)=>{current={...row,
    name:row.name===workspace().name?(handle.run.create?.body.name??row.name):row.name};}};
}

describe("zeros-dev calls normal product lifecycle and Computer APIs",()=>{
  it.each(["empty", "workspace", "page", "pending", "truncated"])("checks the %s fixture through read-only product lists before an hourly allocation", async condition => {
    const f = setup();
    f.fetcher.mockImplementation(async (url, input) => {
      expect(input?.method).toBe("GET");
      const value = new URL(String(url));
      if (value.pathname === `/v1/organizations/${fixture.organizationId}/cloud-workspaces`) {
        expect(value.search).toBe("?limit=100");
        return Response.json({ workspaces: condition === "workspace" ? [workspace()] : [], nextCursor: condition === "page" ? "next" : null });
      }
      expect(value.pathname).toBe(`/v1/organizations/${fixture.organizationId}/cloud-workspace-management/pending-deletion`);
      return Response.json({ truncated: condition === "truncated", pendingDeletion: condition === "pending" ? [{ workspaceId: randomUUID(), generation: 1 }] : [] });
    });
    if (condition === "empty") await expect(f.api.assertFixtureEmpty()).resolves.toBeUndefined();
    else await expect(f.api.assertFixtureEmpty()).rejects.toThrow("zeros_dev_cleanup_pending");
    expect(f.session.whoami).toHaveBeenCalledOnce(); expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.handle.run.create).toBeUndefined();
  });

  it.each(["missing", "different", "different-base", "unqualified", "foreign-build"])("refuses a succeeded Computer with a %s persisted runtime proof",async mode=>{
    const f=setup();await f.api.buildComputer(f.handle);
    const original=f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith(`/builds/${build.id}/runtime`)?Response.json({
      buildId:mode==="foreign-build"?randomUUID():build.id,version:build.version,
      runtimeId:mode==="missing"?null:`r1-${(mode==="different"?"b":"a").repeat(64)}`,baseImageId:mode==="missing"?null:mode==="different-base"?"other-base":"fixture-base",
      selected:mode==="unqualified"?null:{runtimeId:`r1-${"a".repeat(64)}`,baseImageId:"fixture-base",sourceCommit:"c".repeat(40),qualificationMode:"smoke"},
    }):original(url,init));
    await expect(f.api.waitComputer(f.handle.run)).rejects.toThrow(mode==="foreign-build"?"zeros_dev_identity_changed":"zeros_dev_runtime_pin_unconfirmed");
  });

  it("confirms the saved runtime and base, and refuses a different explicitly intended runtime",async()=>{
    const f=setup();await f.api.buildComputer(f.handle);const original=f.fetcher.getMockImplementation()!;
    const runtimeId=`r1-${"a".repeat(64)}`;
    f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith(`/builds/${build.id}/runtime`)?Response.json({
      buildId:build.id,version:build.version,runtimeId,baseImageId:"fixture-base",
      selected:{runtimeId,baseImageId:"fixture-base",sourceCommit:"c".repeat(40),qualificationMode:"full"},
    }):original(url,init));
    expect(await f.api.waitComputer(f.handle.run,undefined,runtimeId)).toMatchObject({runtimePin:"confirmed",state:"succeeded"});
    await expect(f.api.waitComputer(f.handle.run,undefined,`r1-${"b".repeat(64)}`)).rejects.toThrow("zeros_dev_runtime_pin_unconfirmed");
  });

  it("reads the qualified selection separately from an older saved pin without treating it as permission to use that pin", async () => {
    const f = setup(), saved = `r1-${"a".repeat(64)}`, selected = `r1-${"b".repeat(64)}`;
    const proof = { buildId: build.id, version: build.version, runtimeId: saved, baseImageId: "fixture-base",
      selected: { runtimeId: selected, baseImageId: "fixture-base", sourceCommit: "c".repeat(40), qualificationMode: "smoke" } };
    f.fetcher.mockResolvedValue(Response.json(proof));
    await expect(f.api.readComputerRuntime(build)).resolves.toEqual(proof);
    f.fetcher.mockResolvedValue(Response.json(proof));
    await expect(f.api.verifyComputerRuntime(build)).rejects.toMatchObject({ code: "runtime_pin_unconfirmed" });
    expect(f.fetcher.mock.calls.every(([, input]) => input?.method === "GET")).toBe(true);
  });

  it.each([
    ["qualified", undefined], ["unavailable", "runtime_selection_unavailable"],
    ["changed-runtime", "runtime_selection_changed"], ["changed-base", "runtime_selection_changed"],
    ["different-pin", "runtime_pin_unconfirmed"], ["foreign-build", "identity_changed"],
  ])("uses the intended qualified tuple to classify %s build completion", async (condition, code) => {
    const f = setup(); await f.api.buildComputer(f.handle); const original = f.fetcher.getMockImplementation()!;
    const target = { runtimeId: `r1-${"a".repeat(64)}`, baseImageId: "fixture-base" };
    f.fetcher.mockImplementation(async (url, init) => String(url).endsWith(`/builds/${build.id}/runtime`) ? Response.json({
      buildId: condition === "foreign-build" ? randomUUID() : build.id, version: build.version,
      ...target, runtimeId: condition === "different-pin" ? `r1-${"b".repeat(64)}` : target.runtimeId,
      selected: condition === "unavailable" ? null : { ...target, sourceCommit: "c".repeat(40), qualificationMode: "smoke",
        runtimeId: condition === "changed-runtime" ? `r1-${"b".repeat(64)}` : target.runtimeId,
        baseImageId: condition === "changed-base" ? "new-base" : target.baseImageId },
    }) : original(url, init));
    if (code) await expect(f.api.waitComputer(f.handle.run, undefined, target)).rejects.toMatchObject({ code });
    else await expect(f.api.waitComputer(f.handle.run, undefined, target)).resolves.toMatchObject({ runtimePin: "confirmed" });
  });

  it("keeps the 180 second resume deadline and carries the observed setup attempt in its closed error",async()=>{
    let elapsed=0;const f=setup(fixture,{now:()=>elapsed,sleep:async ms=>{elapsed+=ms;}});
    await f.api.createWorkspace(f.handle);f.setWorkspace({...workspace(),status:"setting_up"});
    const original=f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("?setupProgress=true")?Response.json({
      workspace:{...workspace(),status:"setting_up"},setupProgress:{generation:1,attempt:2,claimCount:3,state:"running",errorCode:"setup_engine_readiness_failed"},
    }):original(url,init));
    await expect(f.api.waitWorkspace(f.handle,"running")).rejects.toMatchObject({code:"deadline",setup:{attempt:2,claimCount:3,state:"running",errorCode:"setup_engine_readiness_failed"}});
    expect(elapsed).toBe(180_000);
    expect(f.fetcher.mock.calls.filter(([url])=>String(url).includes("setupProgress"))).not.toHaveLength(0);
  });
  it.each(["unknown-error","stale-generation","missing","malformed"])("keeps %s setup diagnostics closed and does not extend the deadline",async mode=>{
    let elapsed=0;const f=setup(fixture,{now:()=>elapsed,sleep:async ms=>{elapsed+=ms;}});
    await f.api.createWorkspace(f.handle);const original=f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("?setupProgress=true")?Response.json({
      workspace:{...workspace(),status:"setting_up"},...(mode==="missing"?{}:{setupProgress:{generation:mode==="stale-generation"?2:1,
        attempt:2,claimCount:3,state:mode==="malformed"?"synthetic-private-state":"running",errorCode:"synthetic-private-error"}}),
    }):original(url,init));
    const error=await f.api.waitWorkspace(f.handle,"running").catch(error=>error);
    expect(error.code).toBe("deadline");expect(elapsed).toBe(180_000);
    expect(error.setup).toEqual(mode==="unknown-error"?{attempt:2,claimCount:3,state:"running",errorCode:"unknown"}:undefined);
    expect(JSON.stringify(error)).not.toContain("synthetic-private");
  });

  it("retains the last validated setup observation when the next read reaches the deadline",async()=>{
    let elapsed=0;const f=setup(fixture,{now:()=>elapsed,sleep:async ms=>{elapsed+=ms;}});
    await f.api.createWorkspace(f.handle);const original=f.fetcher.getMockImplementation()!;let reads=0;
    const controller=new AbortController();
    f.fetcher.mockImplementation(async(url,init)=>{
      if(!String(url).endsWith("?setupProgress=true"))return original(url,init);
      if(reads++){controller.abort();return Response.json({});}
      return Response.json({workspace:{...workspace(),status:"setting_up"},setupProgress:{generation:1,
        attempt:2,claimCount:1,state:"running",errorCode:null}});
    });
    await expect(f.api.waitWorkspace(f.handle,"running",controller.signal)).rejects.toMatchObject({code:"deadline",
      setup:{attempt:2,claimCount:1,state:"running",errorCode:null}});
    expect(reads).toBe(2);
  });

  it("reports the queued fifth setup attempt when the resume deadline expires during token acquisition", async () => {
    let elapsed = 0;
    const f = setup(fixture, { now: () => elapsed, sleep: async ms => { elapsed += ms; } });
    await f.api.createWorkspace(f.handle);
    const controller = new AbortController(), original = f.fetcher.getMockImplementation()!;
    const progress = { generation: 1, attempt: 5, claimCount: 2, state: "queued", errorCode: "setup_provider_bootstrap_cleanup_unconfirmed" };
    let tokenReads = 0, statusReads = 0;
    f.session.accessToken = async () => {
      if (++tokenReads === 2) {
        elapsed = 180_300;
        controller.abort(new DOMException("synthetic private native timeout", "TimeoutError"));
      }
      return "synthetic-account-access";
    };
    f.fetcher.mockImplementation(async (url, init) => {
      if (!String(url).endsWith("?setupProgress=true")) return original(url, init);
      statusReads++;
      return Response.json({ workspace: { ...workspace(), status: "setting_up" }, setupProgress: progress });
    });
    await expect(f.api.waitWorkspace(f.handle, "running", controller.signal)).rejects.toMatchObject({
      code: "deadline", setup: { attempt: 5, claimCount: 2, state: "queued", errorCode: "setup_provider_bootstrap_cleanup_unconfirmed" },
    });
    expect(elapsed).toBe(180_300); expect(statusReads).toBe(1);
  });
  it.each(["stopped","ready","busy","failed"] as const)("deletes after an accepted wake settles as %s without claiming that wake succeeded",async status=>{
    let elapsed=0;const f=setup(fixture,{now:()=>elapsed,sleep:async ms=>{elapsed+=ms;}});
    await f.api.createWorkspace(f.handle);await f.api.lifecycle(f.handle,"wake");
    f.setWorkspace({...workspace(),status,generation:{...workspace().generation,observedState:status==="stopped"?"stopped":"running"}});
    const wake=f.handle.run.lifecycle.at(-1)!;
    expect(await f.api.cleanup(f.handle,true)).toEqual({planned:1,confirmed:1});
    expect(elapsed).toBe(0);
    expect(wake).toMatchObject({operation:"wake",confirmed:false,settled:{status,generation:1}});
    expect(f.handle.run.lifecycle.at(-1)).toMatchObject({operation:"delete",confirmed:true});
    expect(f.fetcher.mock.calls.filter(([,init])=>init?.method==="DELETE")).toHaveLength(1);
    expect(f.handle.run.deletionConfirmed).toBe(true);
  });

  it("plans a failed wake cleanup without writing or changing the signed lifecycle history",async()=>{
    const f=setup();await f.api.createWorkspace(f.handle);await f.api.lifecycle(f.handle,"wake");
    f.setWorkspace({...workspace(),status:"stopped"});const history=structuredClone(f.handle.run.lifecycle),before=f.fetcher.mock.calls.length;
    expect(await f.api.cleanup(f.handle,false)).toEqual({planned:1,confirmed:0});
    expect(f.handle.run.lifecycle).toEqual(history);
    expect(f.fetcher.mock.calls.slice(before).every(([,init])=>init?.method==="GET")).toBe(true);
  });

  it("persists the stop outcome and delete key before sending, then reuses the key after a lost acknowledgement",async()=>{
    const f=setup();await f.api.createWorkspace(f.handle);await f.api.lifecycle(f.handle,"stop");
    f.setWorkspace({...workspace(),status:"failed"});const original=f.fetcher.getMockImplementation()!;let first=true;
    f.fetcher.mockImplementation(async(url,init)=>{
      if(init?.method==="DELETE"){
        expect(f.snapshots.at(-1)?.lifecycle).toMatchObject([{operation:"stop",confirmed:false,settled:{status:"failed",generation:1}},{operation:"delete",confirmed:false}]);
        const response=await original(url,init);
        if(first){first=false;throw new Error("synthetic lost delete acknowledgement");}
        return response;
      }
      return original(url,init);
    });
    await expect(f.api.cleanup(f.handle,true)).rejects.toThrow("zeros_dev_service_unavailable");
    expect(await f.api.cleanup(f.handle,true)).toEqual({planned:1,confirmed:1});
    const deletes=f.fetcher.mock.calls.filter(([,init])=>init?.method==="DELETE");
    expect(deletes).toHaveLength(2);expect(deletes[0]?.[1]?.headers).toEqual(deletes[1]?.[1]?.headers);
    expect(f.handle.run.lifecycle).toHaveLength(2);
  });

  it("reports transient setup as cleanup_pending immediately, without waiting for the failed wake or inventing settlement",async()=>{
    let elapsed=0;const f=setup(fixture,{now:()=>elapsed,sleep:async ms=>{elapsed+=ms;}});
    await f.api.createWorkspace(f.handle);await f.api.lifecycle(f.handle,"wake");f.setWorkspace({...workspace(),status:"setting_up"});
    const history=structuredClone(f.handle.run.lifecycle),before=f.fetcher.mock.calls.length;
    await expect(f.api.cleanup(f.handle,true)).rejects.toThrow("zeros_dev_cleanup_pending");
    expect(elapsed).toBe(0);expect(f.handle.run.lifecycle).toEqual(history);
    expect(f.fetcher.mock.calls.slice(before).every(([,init])=>init?.method==="GET")).toBe(true);
  });

  it.each(["zd-someone-else","personal-work"])("refuses changed cleanup name %s even for the exact signed workspace",async name=>{
    const f=setup();await f.api.createWorkspace(f.handle);f.setWorkspace({...workspace(),name});const before=f.fetcher.mock.calls.length;
    await expect(f.api.cleanup(f.handle,true)).rejects.toThrow("zeros_dev_identity_changed");
    expect(f.fetcher.mock.calls.slice(before).every(([,init])=>init?.method==="GET")).toBe(true);
  });

  it("rechecks the unchanged signed name at the final deletion read",async()=>{
    const f=setup();await f.api.createWorkspace(f.handle);const original=f.fetcher.getMockImplementation()!;let reads=0;
    f.fetcher.mockImplementation(async(url,init)=>{
      if(new URL(String(url)).pathname===`/v1/cloud-workspaces/${workspace().id}`&&++reads===2)
        return Response.json({workspace:{...workspace(),name:"renamed-work"}});
      return original(url,init);
    });
    await expect(f.api.cleanup(f.handle,true)).rejects.toThrow("zeros_dev_identity_changed");
    expect(f.fetcher.mock.calls.filter(([,init])=>init?.method==="DELETE")).toHaveLength(0);
  });
  it.each(["ensureRepository","buildComputer","createWorkspace"] as const)("keeps %s closed when only the identity is configured",async method=>{
    const f=setup();
    f.session.whoami=async()=>({subject:fixture.subject,accountId:fixture.accountId,email:fixture.email,organizationId:fixture.organizationId}) as typeof fixture;
    f.session.fixture=async()=>{throw new ZerosDevError("fixture_invalid");};
    const operation=method==="ensureRepository"?f.api.ensureRepository():f.api[method](f.handle);
    await expect(operation).rejects.toThrow("zeros_dev_fixture_invalid");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.handle.run.create).toBeUndefined();expect(f.handle.run.computer).toBeUndefined();
  });

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

  it("uses the ordinary workspace create contract rather than the retired builder field",async()=>{
    const f=setup(),original=f.fetcher.getMockImplementation()!;
    const admission=new Error("synthetic admission boundary"),connect=vi.fn(async()=>{throw admission;});
    const route=createCloudWorkspaceRoutes({connect} as never,{provider:"boat"} as never,{repositoryResolver:{resolve:vi.fn()} as never});
    // Exercise the real CP request parser and retired-field rejection, stopping
    // at its first transaction. No live database or provider is involved.
    route.onError((error,c)=>error===admission?c.json({workspace:workspace()}):
      c.json({error:{code:error instanceof HttpError?error.code:"unexpected"}},error instanceof HttpError?error.status:500));
    f.fetcher.mockImplementation(async(url,init)=>{
      if(new URL(String(url)).pathname.endsWith("/cloud-workspaces")&&init?.method==="POST"){
        return route.request(new URL(String(url)).pathname,init);
      }
      return original(url,init);
    });
    await expect(f.api.createWorkspace(f.handle)).resolves.toMatchObject({id:workspace().id});
    expect(connect).toHaveBeenCalledOnce();
    const call=f.fetcher.mock.calls.find(([url,init])=>String(url).endsWith("/cloud-workspaces")&&init?.method==="POST")!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({name:`zd-${f.handle.run.runId}`,repository:{forge:"github.com",owner:repository.owner,
      name:repository.name,revision:"main",githubInstallationId:repository.installationId}});
    expect(f.snapshots[0]?.create?.body).toEqual(JSON.parse(String(call[1]?.body)));
    expect(call[1]?.headers).toMatchObject({"idempotency-key":f.handle.run.create?.key});
  });

  it("never rewrites a recorded legacy create body or selects a new key to work around a refusal",async()=>{
    const f=setup();
    const body={name:`zd-${f.handle.run.runId}`,cloudComputerBuild:{id:build.id,version:build.version},
      repository:{forge:"github.com" as const,owner:repository.owner,name:repository.name,revision:"main",githubInstallationId:repository.installationId}};
    const key=randomUUID();f.handle.run.create={body,key};
    f.fetcher.mockResolvedValue(Response.json({error:{code:"cloud_computer_build_unavailable"}},{status:409}));
    await expect(f.api.createWorkspace(f.handle)).rejects.toThrow("zeros_dev_operation_conflict");
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(body));
    expect(f.fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({"idempotency-key":key});
    expect(f.handle.run.create).toEqual({body,key});expect(f.snapshots).toEqual([]);
  });

  it.each(["ensureRepository","buildComputer","createWorkspace","workspace"] as const)("accepts product-normalized GitHub casing in %s without changing fixture pins",async method=>{
    const pinned={...fixture,repository:{...fixture.repository,owner:"Test-Owner",name:"Test-Repo"}};
    const f=setup(pinned);
    if(method==="workspace")f.handle.run.create={key:randomUUID(),body:{name:"zd-fixture",cloudComputerBuild:{id:build.id,version:build.version},
      repository:{forge:"github.com",owner:pinned.repository.owner,name:pinned.repository.name,revision:"main",githubInstallationId:pinned.repository.installationId}},
      result:{id:workspace().id,createdBy:fixture.accountId,createdAt:workspace().createdAt,generation:1}};
    const operation=method==="ensureRepository"?f.api.ensureRepository():method==="workspace"?f.api.workspace(f.handle.run):f.api[method](f.handle);
    await expect(operation).resolves.toBeDefined();
    expect(await f.session.fixture()).toEqual(pinned);
    if(method==="createWorkspace")expect(f.handle.run.create?.body.repository).toMatchObject({owner:"Test-Owner",name:"Test-Repo"});
  });

  it("builds an approved first draft before requiring an active Computer repository grant",async()=>{
    const f=setup(),original=f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async(url,init)=>{
      const pathname=new URL(String(url)).pathname;
      if(pathname.endsWith("/cloud-computer/v2"))return Response.json({...state(),state:"not_built",active:null,activeRepositories:[],latestBuild:null});
      if(pathname.endsWith("/create-options"))return Response.json({configured:true,installations:[]});
      return original(url,init);
    });
    await expect(f.api.ensureRepository()).rejects.toThrow("zeros_dev_repository_required");
    await expect(f.api.createWorkspace(f.handle)).rejects.toThrow(/zeros_dev_(?:computer_required|repository_required)/);
    expect(f.fetcher.mock.calls.every(([,init])=>init?.method==="GET")).toBe(true);
    expect(f.handle.run.create).toBeUndefined();
    await expect(f.api.buildComputer(f.handle)).resolves.toEqual(build);
    expect(f.fetcher.mock.calls.filter(([,init])=>init?.method!=="GET")).toHaveLength(1);
  });

  it("does not create a missing Computer draft from repository pins",async()=>{
    const f=setup();f.fetcher.mockResolvedValue(Response.json(computerState()));
    await expect(f.api.buildComputer(f.handle)).rejects.toThrow("zeros_dev_repository_required");
    expect(f.fetcher.mock.calls.every(([,init])=>init?.method==="GET")).toBe(true);
    expect(f.handle.run.computer).toBeUndefined();
  });

  it.each(["id","installationId","owner","name"] as const)("keeps Computer %s identity exact apart from GitHub name casing",async field=>{
    const f=setup(),foreign={...repository,[field]:field==="id"?"5678":field==="installationId"?randomUUID():"foreign"};
    f.fetcher.mockResolvedValue(Response.json({...state(),draft:{...state().draft,repositories:[foreign]}}));
    await expect(f.api.buildComputer(f.handle)).rejects.toThrow("zeros_dev_repository_required");
    expect(f.fetcher.mock.calls.every(([,init])=>init?.method==="GET")).toBe(true);
    expect(f.handle.run.computer).toBeUndefined();
  });

  it.each(["canonical","display"])("replays an unknown create with %s casing and a byte-identical body and key even after the active Computer changes",async casing=>{
    const pinned=casing==="canonical"?fixture:{...fixture,repository:{...fixture.repository,owner:"Test-Owner",name:"Test-Repo"}};
    const f=setup(pinned), original=f.fetcher.getMockImplementation()!;let first=true;
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

  it("closes explicit compute cleanup on a fresh authenticated retirement and never reissues its accepted delete", async () => {
    let clock = 0;
    const f = setup(fixture, { now: () => clock, sleep: async ms => { clock += ms; } });
    await f.api.createWorkspace(f.handle);
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, input) => {
      if (String(url).endsWith("/deletion-retirement")) {
        expect(input?.method).toBe("POST");
        expect(JSON.parse(String(input?.body))).toEqual({ generation: 1, deleteIdempotencyKey: f.handle.run.lifecycle.at(-1)!.key });
        return Response.json(fixtureRetirement(f.handle.run, new Date().toISOString()));
      }
      if (input?.method === "DELETE") {
        const row = { ...workspace(), name: f.handle.run.create!.body.name, status: "deleting", generation: { ...workspace().generation, observedState: "stopped" } };
        f.setWorkspace(row); return Response.json({ workspace: row });
      }
      return original(url, input);
    });
    const cleanup = f.api.cleanup.bind(f.api) as (...args: any[]) => Promise<unknown>;
    await expect(cleanup(f.handle, true, undefined, { allowStoragePending: true })).resolves.toEqual({ planned: 1, confirmed: 0, storagePending: 1 });
    expect(clock).toBe(0);
    expect(f.handle.run.deletionConfirmed).toBe(false);
    expect(f.handle.run.lifecycle.at(-1)).toMatchObject({ operation: "delete", confirmed: false });
    expect(f.handle.run.retirement).toMatchObject({ status: "compute_retired_storage_pending", admissionFenced: true });
    await expect(cleanup(f.handle, true, undefined, { allowStoragePending: true })).resolves.toMatchObject({ confirmed: 0, storagePending: 1 });
    expect(f.fetcher.mock.calls.filter(([, input]) => input?.method === "DELETE")).toHaveLength(1);
  });

  it.each(["exact", "retired-deleting", "foreign-row", "live", "wrong-key", "wrong-org", "changed-generation", "unaccounted-generation",
    "missing-proof", "unfenced", "cpu", "failed", "truncated", "missing-inventory", "stale", "expires-during-inventory", "old-debt"])(
    "admits only current exact retirement: %s", async condition => {
      const f = setup(); await f.api.createWorkspace(f.handle);
      const proof = retireFixtureCompute(f.handle, new Date().toISOString());
      if (condition === "wrong-key") proof.deleteIdempotencyKey = randomUUID();
      if (condition === "wrong-org") proof.organizationId = randomUUID();
      if (condition === "changed-generation") proof.currentGeneration = 2;
      if (condition === "unaccounted-generation") { proof.generations.push({ ...proof.generations[0]!, generation: 2 }); proof.reserved.storageMiB *= 2; }
      if (condition === "unfenced") Object.assign(proof, { admissionFenced: false });
      if (condition === "cpu") Object.assign(proof.reserved, { cpuMillicores: 1 });
      if (condition === "stale") proof.observedAt = new Date(Date.now() - 120_000).toISOString();
      if (condition === "old-debt") proof.requestedAt = new Date(Date.now() - 8 * 3_600_000 - 1000).toISOString();
      let restoreClock: (() => void) | undefined;
      f.fetcher.mockClear();
      f.fetcher.mockImplementation(async (url, input) => {
        const target = new URL(String(url));
        if (target.pathname.endsWith("/deletion-retirement")) {
          expect(input?.method).toBe("POST");
          return condition === "missing-proof" ? Response.json({}, { status: 404 }) : Response.json(proof);
        }
        expect(input?.method).toBe("GET");
        if (target.pathname.endsWith("/cloud-workspaces")) return Response.json({ nextCursor: null, workspaces: [{ ...workspace(),
          id: condition === "foreign-row" ? randomUUID() : workspace().id, name: f.handle.run.create!.body.name,
          status: condition === "live" ? "ready" : "deleting", generation: { ...workspace().generation,
            observedState: condition === "live" ? "running" : condition === "retired-deleting" ? "deleting" : "stopped" } }] });
        if (condition === "expires-during-inventory") {
          const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(proof.observedAt) + 60_001);
          restoreClock = () => { clock.mockRestore(); };
        }
        return Response.json({ truncated: condition === "truncated", pendingDeletion: condition === "missing-inventory" ? [] : [{
          workspaceId: workspace().id, generation: 1, state: condition === "failed" ? "failed" : "observing",
          reserved: condition === "retired-deleting" ? { ...proof.reserved, cpuMillicores: 2000, memoryMiB: 4096 } : proof.reserved,
        }] });
      });
      const result = f.api.assertFixtureEmpty(undefined, [f.handle.run]);
      try {
        if (["exact", "retired-deleting"].includes(condition)) await expect(result).resolves.toBeUndefined();
        else await expect(result).rejects.toBeInstanceOf(ZerosDevError);
      } finally { restoreClock?.(); }
      expect(f.fetcher.mock.calls.every(([url, input]) => input?.method === "GET" || String(url).endsWith("/deletion-retirement"))).toBe(true);
      expect(f.handle.run.deletionConfirmed).toBe(false);
    });

  it("rejects contradictory physical flags even when the catalog is empty", async () => {
    const f = setup(); await f.api.createWorkspace(f.handle); retireFixtureCompute(f.handle, new Date().toISOString());
    f.handle.run.deletionConfirmed = true;
    f.fetcher.mockImplementation(async url => Response.json(String(url).endsWith("/pending-deletion")
      ? { truncated: false, pendingDeletion: [] } : { workspaces: [], nextCursor: null }));
    await expect(f.api.assertFixtureEmpty(undefined, [f.handle.run])).rejects.toMatchObject({ code: "receipt_invalid" });
  });

  it("recognizes positive physical completion after content purge without inferring it from 404", async () => {
    const f = setup(); await f.api.createWorkspace(f.handle); retireFixtureCompute(f.handle, new Date().toISOString());
    const proof: any = fixtureRetirement(f.handle.run, new Date().toISOString());
    proof.status = "physically_deleted"; proof.deletionConfirmed = true; proof.reserved.storageMiB = 0;
    proof.generations[0].status = "physically_deleted"; proof.generations[0].storageStage = "completed";
    proof.generations[0].reserved.storageMiB = 0; proof.generations[0].expectedBy = null;
    f.fetcher.mockImplementation(async (url, input) => {
      expect(String(url)).toMatch(/\/deletion-retirement$/); expect(input?.method).toBe("POST");
      return Response.json(proof);
    });
    await expect(f.api.cleanup(f.handle, true, undefined, { allowStoragePending: true })).resolves.toMatchObject({ confirmed: 1, storagePending: 0 });
    expect(f.handle.run.deletionConfirmed).toBe(true); expect(f.handle.run.lifecycle.at(-1)?.confirmed).toBe(true);
    const missing = setup(); await missing.api.createWorkspace(missing.handle); retireFixtureCompute(missing.handle, new Date().toISOString());
    missing.fetcher.mockResolvedValue(Response.json({}, { status: 404 }));
    await expect(missing.api.cleanup(missing.handle, true, undefined, { allowStoragePending: true })).rejects.toMatchObject({ code: "not_found" });
    expect(missing.handle.run.deletionConfirmed).toBe(false);
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

  it("observes closed current-generation setup evidence even after readiness succeeds",async()=>{
    const f=setup();await f.api.createWorkspace(f.handle);
    const original=f.fetcher.getMockImplementation()!,observe=vi.fn();
    f.fetcher.mockImplementation(async(url,init)=>new URL(String(url)).pathname===`/v1/cloud-workspaces/${workspace().id}`
      ?Response.json({workspace:{...workspace(),status:"ready"},setupProgress:{generation:workspace().generation.number,
        attempt:2,claimCount:2,state:"succeeded",errorCode:"private-provider-detail"}})
      :original(url,init));
    await f.api.waitWorkspace(f.handle,"running",undefined,observe);
    expect(observe).toHaveBeenCalledExactlyOnceWith({attempt:2,claimCount:2,state:"succeeded",errorCode:"unknown"});
  });

  it("fails a Computer with another repository before any build mutation",async()=>{
    const f=setup();f.fetcher.mockResolvedValue(Response.json({...state(),draft:{...state().draft,repositories:[{...repository,name:"foreign"}]}}));
    await expect(f.api.buildComputer(f.handle)).rejects.toThrow("zeros_dev_repository_required");
    expect(f.fetcher.mock.calls.every(([,init])=>init?.method==="GET")).toBe(true);
  });
});
