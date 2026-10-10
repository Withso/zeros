import { beforeEach, expect, it, vi } from "vitest";
const ports=vi.hoisted(()=>({actor:vi.fn(),capture:vi.fn(),human:vi.fn(),create:vi.fn(),register:vi.fn(),unregister:vi.fn(),live:vi.fn(),inspect:vi.fn()}));
vi.mock("tsx/esm/api",()=>({register:ports.register}));
vi.mock("../cloud-workspace-validation/sandbox/cloud-qualification-runtime",()=>({createCloudQualificationRuntime:ports.create}));
vi.mock("../cloud-workspace-validation/sandbox/qualify-cloud-actor-tools",()=>({qualifyCloudActorTools:ports.actor}));
vi.mock("../cloud-workspace-validation/sandbox/qualify-cloud-capture",()=>({qualifyCloudCapture:ports.capture}));
vi.mock("../cloud-workspace-validation/sandbox/qualify-cloud-human-services",()=>({qualifyCloudHumanServices:ports.human}));
import { qualifyCloudEngineRuntime } from "../cloud-workspace-validation/sandbox/qualify-cloud-engine.mjs";
const execution={sameEngineIdentity:true,noSandbox:true,ownedProcessGroups:true,originalProcessGroupsRetired:true,timeoutRetired:true,workloadCgroup:true,vmWorkloadDrain:false};
const identity={qualified:true,hostUid:10003,namespaceUid:10003,noNewPrivs:1,seccompMode:2,capabilities:{effective:0,permitted:0,inheritable:0,bounding:0,ambient:0},checks:[],resources:{finite:true,cpuMax:"400000 100000",memoryMax:String(7*1024**3),pidsMax:"4096",memoryBudget:{nominalMemoryBytes:String(8*1024**3),measuredMemoryBytes:String(8*1024**3),hostMemoryMax:String(256*1024**2),source:"nominal",capped:false},hierarchy:[{path:"/fixture/engine-runtime",memoryMax:String(7*1024**3),cpuMax:"400000 100000",pidsMax:"4096"}],cpuSplit:{engine:{cpuMax:"max 100000",cpuWeight:100},workload:{controllers:["cpu"],cpuWeight:100,cap:{kind:"applied",effectiveCpus:4,cpuMax:"300000 100000"}}}}};
const context={custody:{assertLive:ports.live},workloads:{inspect:ports.inspect}};
beforeEach(()=>{
 for(const fn of Object.values(ports))fn.mockReset();
 ports.register.mockReturnValue(ports.unregister);ports.create.mockReturnValue(context);
 ports.actor.mockResolvedValue({execution,actorTools:{sameEngineIdentity:true,noSandbox:true}});
 ports.capture.mockResolvedValue({sameEngineIdentity:true,chromiumSandbox:true});
 ports.human.mockResolvedValue({sameEngineIdentity:true,noSandbox:true});
 ports.inspect.mockResolvedValue({complete:true,pendingLaunches:0,failedRetirements:0,workloadPids:[],infrastructurePids:[22]});
});
it("runs fixed inline probes in one original controller and leaves final drain to root",async()=>{
 const report=await qualifyCloudEngineRuntime(identity);
 expect(report).toMatchObject({version:2,boundary:"workspace-vm",engineChecksPassed:true,qualified:false,identity,execution,capture:{sameEngineIdentity:true,chromiumSandbox:true},humanServices:{sameEngineIdentity:true,noSandbox:true},actorTools:{sameEngineIdentity:true,noSandbox:true}});
 expect(JSON.stringify(report)).not.toMatch(/secure|unprivileged|design/i);
 for(const fn of [ports.actor,ports.capture,ports.human])expect(fn).toHaveBeenCalledExactlyOnceWith(context);
 expect(ports.create).toHaveBeenCalledOnce();expect(ports.unregister).toHaveBeenCalledOnce();
});
it("does not activate from unqualified engine identity",async()=>{
 const report=await qualifyCloudEngineRuntime({...identity,qualified:false});expect(report.engineChecksPassed).toBe(false);expect(report.qualified).toBe(false);expect(ports.actor).not.toHaveBeenCalled();expect(ports.create).not.toHaveBeenCalled();
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
 const report=await qualifyCloudEngineRuntime(identity);expect(report.engineChecksPassed).toBe(false);expect(report.qualified).toBe(false);expect(JSON.stringify(report)).not.toContain("private provider prose");expect(ports.unregister).toHaveBeenCalledOnce();
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
