import { beforeEach, expect, it, vi } from "vitest";
const ports=vi.hoisted(()=>({actor:vi.fn(),capture:vi.fn(),human:vi.fn(),runners:vi.fn(),create:vi.fn(),load:vi.fn(),unregister:vi.fn(),live:vi.fn(),inspect:vi.fn(),close:vi.fn()}));
import { qualifyCloudEngineRuntime as qualify } from "../cloud-workspace-validation/sandbox/qualify-cloud-engine.mjs";
import { COMPUTER_ROLE_CHECKS } from "../cloud-workspace-validation/sandbox/cloud-computer-self-test.mjs";
const qualifyCloudEngineRuntime=(value?:Parameters<typeof qualify>[0])=>qualify(value,ports.load,{runnerSupport:()=>false});
const runners={version:1,managerIdentity:true,privateMaterial:true,stdio:true,originalRetirement:true,descendantsRetired:true,census:true,revocation:true,managerRetired:true};
const execution={sameEngineIdentity:true,noSandbox:true,ownedProcessGroups:true,originalProcessGroupsRetired:true,timeoutRetired:true,workloadCgroup:true,vmWorkloadDrain:false};
const identity={qualified:true,hostUid:10003,namespaceUid:10003,noNewPrivs:1,seccompMode:2,capabilities:{effective:0,permitted:0,inheritable:0,bounding:0,ambient:0},checks:[],resources:{finite:true,cpuMax:"400000 100000",memoryMax:String(7*1024**3),pidsMax:"4096",memoryBudget:{nominalMemoryBytes:String(8*1024**3),measuredMemoryBytes:String(8*1024**3),hostMemoryMax:String(256*1024**2),source:"nominal",capped:false},hierarchy:[{path:"/fixture/engine-runtime",memoryMax:String(7*1024**3),cpuMax:"400000 100000",pidsMax:"4096"}],cpuSplit:{engine:{cpuMax:"max 100000",cpuWeight:100},workload:{controllers:["cpu"],cpuWeight:100,cap:{kind:"applied",effectiveCpus:4,cpuMax:"300000 100000"}}}}};
const context={custody:{assertLive:ports.live},workloads:{inspect:ports.inspect},close:ports.close};
it("requires an actual runner probe on a supporting base before claiming engine checks passed", async () => {
 ports.runners.mockResolvedValue(undefined);
 const report = await qualify(identity, ports.load, { runnerSupport: () => true });
 expect(report.engineChecksPassed).toBe(false);
});
it("executes the runner role only on a supporting base and requires every positive witness", async () => {
 expect((await qualify(identity, ports.load, { runnerSupport: () => false })).engineChecksPassed).toBe(true);
 expect(ports.runners).not.toHaveBeenCalled();
 expect((await qualify(identity, ports.load, { runnerSupport: () => true })).engineChecksPassed).toBe(true);
 expect(ports.runners).toHaveBeenCalledExactlyOnceWith(context);
 for(const field of Object.keys(runners)) {
  ports.runners.mockResolvedValue({...runners,[field]:false});
  expect((await qualify(identity, ports.load, { runnerSupport: () => true })).engineChecksPassed).toBe(false);
 }
});
beforeEach(()=>{
 for(const fn of Object.values(ports))fn.mockReset();
 ports.load.mockResolvedValue({roles:{createCloudQualificationRuntime:ports.create,qualifyCloudActorTools:ports.actor,qualifyCloudCapture:ports.capture,qualifyCloudHumanServices:ports.human,qualifyCloudRunners:ports.runners},unregister:ports.unregister});
 ports.create.mockReturnValue(context);
 ports.actor.mockResolvedValue({execution,actorTools:{sameEngineIdentity:true,noSandbox:true}});
 ports.capture.mockResolvedValue({sameEngineIdentity:true,chromiumSandbox:true});
 ports.human.mockResolvedValue({sameEngineIdentity:true,noSandbox:true});
 ports.runners.mockResolvedValue(runners);
 ports.inspect.mockResolvedValue({complete:true,pendingLaunches:0,failedRetirements:0,workloadPids:[],infrastructurePids:[22]});
});
it("runs fixed inline probes in one original controller and leaves final drain to root",async()=>{
 const report=await qualifyCloudEngineRuntime(identity);
 expect(report).toMatchObject({version:2,boundary:"workspace-vm",engineChecksPassed:true,qualified:false,identity,execution,capture:{sameEngineIdentity:true,chromiumSandbox:true},humanServices:{sameEngineIdentity:true,noSandbox:true},actorTools:{sameEngineIdentity:true,noSandbox:true}});
 expect(JSON.stringify(report)).not.toMatch(/secure|unprivileged|design/i);
 for(const fn of [ports.actor,ports.capture,ports.human])expect(fn).toHaveBeenCalledExactlyOnceWith(context);
 expect(ports.create).toHaveBeenCalledOnce();expect(ports.unregister).toHaveBeenCalledOnce();
 expect(ports.close).toHaveBeenCalledOnce();expect(ports.close.mock.invocationCallOrder[0]).toBeGreaterThan(ports.inspect.mock.invocationCallOrder[0]!);
});
it("does not activate from unqualified engine identity",async()=>{
 const report=await qualifyCloudEngineRuntime({...identity,qualified:false});expect(report.engineChecksPassed).toBe(false);expect(report.qualified).toBe(false);expect(ports.actor).not.toHaveBeenCalled();expect(ports.create).not.toHaveBeenCalled();expect(ports.load).not.toHaveBeenCalled();
});
it.each(["noSandbox","originalProcessGroupsRetired","timeoutRetired","workloadCgroup"] as const)("refuses missing %s before capture or human admission",async field=>{
 ports.actor.mockResolvedValue({execution:{...execution,[field]:false},actorTools:{sameEngineIdentity:true,noSandbox:true}});
 const report=await qualifyCloudEngineRuntime(identity);expect(report.engineChecksPassed).toBe(false);expect(ports.capture).not.toHaveBeenCalled();expect(ports.human).not.toHaveBeenCalled();
});
it("never accepts an inner whole-VM drain claim",async()=>{
 ports.actor.mockResolvedValue({execution:{...execution,vmWorkloadDrain:true},actorTools:{sameEngineIdentity:true,noSandbox:true}});
 expect((await qualifyCloudEngineRuntime(identity)).engineChecksPassed).toBe(false);
});
it.each(["actor","capture","human"] as const)("closes refused or thrown %s probe without forwarding output",async section=>{
 ports[section].mockRejectedValue(new Error("private provider prose"));
 const report=await qualifyCloudEngineRuntime(identity);expect(report.engineChecksPassed).toBe(false);expect(report.qualified).toBe(false);expect(JSON.stringify(report)).not.toContain("private provider prose");expect(ports.unregister).toHaveBeenCalledOnce();expect(ports.close).toHaveBeenCalledOnce();
});
it("ends controller services and the loader when the final census refuses",async()=>{
 ports.inspect.mockResolvedValue({complete:false,pendingLaunches:0,failedRetirements:0,workloadPids:[],infrastructurePids:[22]});
 expect((await qualifyCloudEngineRuntime(identity)).engineChecksPassed).toBe(false);expect(ports.close).toHaveBeenCalledOnce();expect(ports.unregister).toHaveBeenCalledOnce();
});
it("does not pass when controller services cannot be ended",async()=>{
 ports.close.mockImplementation(()=>{throw new Error("private transport prose");});
 const report=await qualifyCloudEngineRuntime(identity);expect(report.engineChecksPassed).toBe(false);expect(JSON.stringify(report)).not.toContain("private transport prose");expect(ports.unregister).toHaveBeenCalledOnce();
});
it("refuses without a context when the role loader fails",async()=>{
 ports.load.mockRejectedValue(new Error("private loader prose"));
 const report=await qualifyCloudEngineRuntime(identity);expect(report.engineChecksPassed).toBe(false);expect(JSON.stringify(report)).not.toContain("private loader prose");expect(ports.create).not.toHaveBeenCalled();expect(ports.unregister).not.toHaveBeenCalled();
});
it.each(["capture","human"] as const)("requires actual policy witness from %s",async section=>{
 ports[section].mockResolvedValue({sameEngineIdentity:true});expect((await qualifyCloudEngineRuntime(identity)).engineChecksPassed).toBe(false);
});
it.each(["root","cap","nnp","seccomp"])("refuses a contradictory %s identity even with qualified:true",async kind=>{
 const change=kind==="root"?{namespaceUid:0}:kind==="cap"?{capabilities:{...identity.capabilities,bounding:1}}:kind==="nnp"?{noNewPrivs:0}:{seccompMode:0};
 expect((await qualifyCloudEngineRuntime({...identity,...change})).engineChecksPassed).toBe(false);expect(ports.create).not.toHaveBeenCalled();
});
it("rejects unresolved workload census while allowing exact live controller births",async()=>{
 ports.inspect.mockResolvedValue({complete:true,pendingLaunches:0,failedRetirements:0,workloadPids:[33],infrastructurePids:[22]});
 expect((await qualifyCloudEngineRuntime(identity)).engineChecksPassed).toBe(false);
});
it("waits for the actual asynchronous loader retirement before returning its inner report", async () => {
 let release!: () => void;
 ports.unregister.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
 let returned = false; const pending = qualifyCloudEngineRuntime(identity).then(report => { returned = true; return report; });
 await vi.waitFor(() => expect(ports.unregister).toHaveBeenCalledOnce());
 expect(returned).toBe(false); release(); await pending;
});
it("refuses the legacy secure result instead of borrowing its retired-sandbox claim", async () => {
 ports.actor.mockResolvedValue({ secure: true });
 expect((await qualifyCloudEngineRuntime(identity)).engineChecksPassed).toBe(false); expect(ports.capture).not.toHaveBeenCalled();
});

it.each([false, true])("times serial qualification roles without charging runner work to adjacent stages (runner support: %s)", async runnerSupport => {
 const observed = vi.fn(); let ms = 0;
 for (const [name, duration] of [["load", 11], ["create", 12], ["actor", 13], ["capture", 14], ["human", 15], ["runners", 19], ["inspect", 16], ["close", 17], ["unregister", 18]] as const) {
  const original = ports[name].getMockImplementation();
  ports[name].mockImplementation((...args: any[]) => { ms += duration; return original?.(...args); });
 }
 const report = await qualify(identity, ports.load, { onPerformance: observed, now: () => ms, runnerSupport: () => runnerSupport });
 expect(report.engineChecksPassed).toBe(true); expect(report.qualified).toBe(false);
 expect(report).not.toHaveProperty("performance");
 expect(observed).toHaveBeenCalledOnce();
 const stages = observed.mock.calls[0][0].groups[0].stages;
 expect(stages.map((entry: any) => [entry.stage, entry.totalMs])).toEqual([
  ["module_load", 11], ["context_create", 12], ["actor_tools", 13], ["capture", 14], ["human_services", 15], ["census", 16], ["context_close", 35],
 ]);
 expect(ports.capture.mock.invocationCallOrder[0]).toBeGreaterThan(ports.actor.mock.invocationCallOrder[0]!);
 expect(ports.human.mock.invocationCallOrder[0]).toBeGreaterThan(ports.capture.mock.invocationCallOrder[0]!);
 expect(ports.close.mock.invocationCallOrder[0]).toBeGreaterThan(ports.inspect.mock.invocationCallOrder[0]!);
 if (runnerSupport) {
  expect(ports.runners).toHaveBeenCalledExactlyOnceWith(context);
  expect(ports.runners.mock.invocationCallOrder[0]).toBeGreaterThan(ports.human.mock.invocationCallOrder[0]!);
  expect(ports.inspect.mock.invocationCallOrder[0]).toBeGreaterThan(ports.runners.mock.invocationCallOrder[0]!);
  expect(report).toHaveProperty("runners", runners);
 } else {
  expect(ports.runners).not.toHaveBeenCalled();
  expect(report).not.toHaveProperty("runners");
 }
});
it.each(["refused", "thrown"])("keeps runner admission %s without rewriting a successful human-service timer", async failure => {
 const observed = vi.fn();
 if (failure === "refused") ports.runners.mockResolvedValue({...runners,revocation:false});
 else ports.runners.mockRejectedValue(new Error("private runner output"));
 const report = await qualify(identity, ports.load, { onPerformance: observed, runnerSupport: () => true });
 expect(report.engineChecksPassed).toBe(false); expect(report.qualified).toBe(false);
 expect(ports.inspect).not.toHaveBeenCalled();
 expect(ports.close).toHaveBeenCalledOnce(); expect(ports.unregister).toHaveBeenCalledOnce();
 expect(observed).toHaveBeenCalledOnce();
 expect(observed.mock.calls[0][0].groups[0].stages).toEqual(expect.arrayContaining([
  expect.objectContaining({stage:"human_services",lastOutcome:"passed"}),
  expect.objectContaining({stage:"context_close",lastOutcome:"passed"}),
 ]));
 expect(JSON.stringify([report, observed.mock.calls])).not.toContain("private runner output");
});
it("retains a closed failed role and cleanup while discarding raw errors", async () => {
 const observed=vi.fn(); ports.capture.mockRejectedValue(new Error("private probe"));
 const report=await (qualify as any)(identity,ports.load,{onPerformance:observed,runnerSupport:()=>false});
 expect(report.engineChecksPassed).toBe(false); expect(ports.human).not.toHaveBeenCalled();
 expect(observed.mock.calls[0]?.[0].groups[0].stages).toEqual(expect.arrayContaining([
  expect.objectContaining({stage:"capture",lastOutcome:"failed"}),expect.objectContaining({stage:"context_close",lastOutcome:"passed"}),
 ]));
 expect(JSON.stringify(observed.mock.calls)).not.toContain("private probe");
});
it.each([false, true])("cannot let a diagnostic observer alter qualification or cleanup (runner support: %s)", async runnerSupport => {
 const report=await qualify(identity,ports.load,{onPerformance:()=>{throw new Error("observer");},runnerSupport:()=>runnerSupport});
 expect(report.engineChecksPassed).toBe(true);expect(ports.close).toHaveBeenCalledOnce();expect(ports.unregister).toHaveBeenCalledOnce();
});

it("retains the complete observed actor and human checks for the build producer", async () => {
 ports.actor.mockResolvedValue({execution,actorTools:{sameEngineIdentity:true,noSandbox:true},checks:[...COMPUTER_ROLE_CHECKS.actorTools]});
 ports.human.mockResolvedValue({sameEngineIdentity:true,noSandbox:true,checks:[...COMPUTER_ROLE_CHECKS.humanServices]});
 const report = await qualifyCloudEngineRuntime(identity);
 expect(report.actorTools).toHaveProperty("buildChecks",COMPUTER_ROLE_CHECKS.actorTools);
 expect(report.humanServices).toHaveProperty("buildChecks",COMPUTER_ROLE_CHECKS.humanServices);
 expect(ports.actor).toHaveBeenCalledOnce();expect(ports.human).toHaveBeenCalledOnce();
});

it.each(["partial", "unknown", "duplicate"])("keeps %s role details out of reusable evidence without weakening the legacy gate", async kind => {
 const checks=[...COMPUTER_ROLE_CHECKS.actorTools];
 if(kind==="partial")checks.pop();
 else checks.push(kind==="duplicate"?checks[0]:"synthetic-private-output");
 ports.actor.mockResolvedValue({execution,actorTools:{sameEngineIdentity:true,noSandbox:true},checks});
 const report=await qualifyCloudEngineRuntime(identity);
 expect(report.engineChecksPassed).toBe(true);expect(report.actorTools).not.toHaveProperty("buildChecks");
 expect(JSON.stringify(report)).not.toContain("synthetic-private-output");
});
