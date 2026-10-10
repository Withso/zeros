import { beforeEach, expect, it, vi } from "vitest";
const host=vi.hoisted(()=>({capture:vi.fn(),inspect:vi.fn(),create:vi.fn(),configuration:vi.fn(),identity:{uid:10003,gid:10003} as {uid:number;gid:number}|null}));
vi.mock("../../apps/desktop/src/engine/design/capture-cloud",()=>({createCloudDesignCaptureHost:(boundary:unknown,options:{onIdentity(identity:{uid:number;gid:number}):void})=>{host.create(boundary);return async()=>{
 if(host.identity)options.onIdentity(host.identity);return host.capture();
}}}));
vi.mock("../../apps/desktop/src/engine/agents/containment/cloud-worker-config",()=>({loadCloudWorkerConfiguration:host.configuration}));
vi.mock("../../apps/desktop/src/engine/agents/containment/cloud-workload-custody",()=>({createCloudWorkloadCustody:()=>({assertLive(){}})}));
vi.mock("../../apps/desktop/src/engine/agents/containment/cloud-owned-workloads",()=>({CloudOwnedWorkloadRegistry:class{inspect=host.inspect}}));
vi.mock("../../apps/desktop/src/engine/agents/containment/cloud-execution-boundary",()=>({CloudExecutionBoundary:class{}}));
import { qualifyCloudCapture, createCloudCaptureQualificationRuntime } from "../cloud-workspace-validation/sandbox/qualify-cloud-capture";
beforeEach(()=>{
 const bytes=Buffer.alloc(24);Buffer.from("89504e470d0a1a0a","hex").copy(bytes);bytes.write("IHDR",12);bytes.writeUInt32BE(80,16);bytes.writeUInt32BE(48,20);
 host.capture.mockReset().mockResolvedValue({bytes,renderer:"chromium-fixed"});host.identity={uid:10003,gid:10003};
 host.create.mockReset();host.configuration.mockReset().mockReturnValue({uid:10003,gid:10003});
 host.inspect.mockReset().mockResolvedValue({complete:true,pendingLaunches:0,failedRetirements:0,workloadPids:[],infrastructurePids:[]});
});
it("reuses the original runtime boundary and registry for the operator and fixed-worker proof",async()=>{
 const context=createCloudCaptureQualificationRuntime();
 await expect(qualifyCloudCapture(context)).resolves.toMatchObject({sameEngineIdentity:true,chromiumSandbox:true});
 expect(host.create).toHaveBeenCalledExactlyOnceWith(context.boundary);
 expect(context.workloads.inspect).toBe(host.inspect);expect(host.configuration).toHaveBeenCalledOnce();
});
it("refuses missing cloud configuration before constructing a runtime",()=>{
 host.configuration.mockReturnValue(null);expect(()=>createCloudCaptureQualificationRuntime()).toThrow();
 expect(host.create).not.toHaveBeenCalled();
});
it("requires the actual PNG worker identity and positively empty original registry",async()=>{
 await expect(qualifyCloudCapture()).resolves.toMatchObject({sameEngineIdentity:true,chromiumSandbox:true,renderer:"chromium-fixed",bytes:24});
});
it.each([null,{uid:0,gid:0},{uid:10001,gid:10001}])("refuses absent or foreign capture identity %s even with a PNG",async identity=>{
 host.identity=identity;await expect(qualifyCloudCapture()).rejects.toThrow();
});
it("refuses a bad PNG before publishing identity success",async()=>{
 host.capture.mockResolvedValue({bytes:Buffer.alloc(24),renderer:"chromium-fixed"});await expect(qualifyCloudCapture()).rejects.toThrow();
});
it("refuses unresolved owned processes after capture",async()=>{
 host.inspect.mockResolvedValue({complete:false,pendingLaunches:1,failedRetirements:0,workloadPids:[12],infrastructurePids:[]});await expect(qualifyCloudCapture()).rejects.toThrow();
});
