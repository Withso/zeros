import {randomUUID} from "node:crypto";
import {afterEach,describe,expect,it,vi} from "vitest";
import {CLOUD_NATIVE_PROVIDER_RESTRICTIONS,type ExecutionBoundaryStatus} from "@zeros/protocol/containment";
import {CloudNativeBoundary} from "../containment/cloud-native-boundary";
import type {PreparedBoundary} from "../containment/types";
import {cloudProviderExecution,createCloudAgentExecutionFactory} from "../cloud-provider-execution";

vi.mock("../containment/cloud-native-boundary",()=>({CloudNativeBoundary:{prepare:vi.fn()}}));
afterEach(()=>vi.resetAllMocks());
function fixture(provider: "claude"|"codex"|"cursor"="cursor", credentialKind="cursor-api-key"){
  const status:ExecutionBoundaryStatus={version:1,actor:"agent-code",state:"ready",backend:"cloud-worker",
    designProtection:{required:true,enforced:true,protectedDirectoryCount:1},
    parity:{level:"restricted",restrictions:[...CLOUD_NATIVE_PROVIDER_RESTRICTIONS.cursor]},checkedAt:Date.now()};
  const workload={generation:"workload",status,attestation:Promise.resolve(),stopAndProve:vi.fn(async()=>{})} as unknown as PreparedBoundary;
  const controller=new AbortController();
  const coordinator={...workload,environment:()=>({}),providerHomePath:"/private"};
  vi.mocked(CloudNativeBoundary.prepare).mockResolvedValue(coordinator as unknown as CloudNativeBoundary);
  const leaseId=randomUUID();
  const request=vi.fn(async(input:{kind:string})=>input.kind==="release"?{released:true}:{leaseId,authorityId:"a".repeat(64),
    expiresAt:new Date(Date.now()+45000).toISOString(),credentialVersion:1,credentialKind,provider,model:"grok-4.6",material:
      credentialKind==="claude-setup-token"?{kind:credentialKind,accessToken:"synthetic-setup-token"}:
      credentialKind==="codex-chatgpt"?{kind:credentialKind,accessToken:"synthetic-chatgpt-token",accountId:"synthetic-account",expiresAt:2_100_000_000}:
      {kind:credentialKind,apiKey:"synthetic-provider-key"}});
  const factory=createCloudAgentExecutionFactory({request,supervisor:{onRetirementFailure:vi.fn()}});
  const input={admission:{executionId:randomUUID(),delegationId:randomUUID(),provider,model:"grok-4.6",
    source:{kind:"session" as const,actorSessionId:randomUUID()}},conversationId:randomUUID(),workload,cwd:"/srv/zeros/workspace",signal:controller.signal};
  return {factory,input,workload,coordinator,controller};
}
describe("admitted native cloud diagnostic",()=>{
  it.each([
    ["claude","claude-api-key","claude-direct-login-required"],
    ["claude","claude-setup-token","claude-direct-login-required"],
    ["codex","codex-api-key","codex-runtime-unavailable"],
    ["codex","codex-chatgpt","codex-runtime-unavailable"],
    ["cursor","cursor-api-key","provider-unsupported"],
  ] as const)("reports browser unavailability for %s with %s without blocking chat admission",async(provider,kind,reason)=>{
    const {factory,input}=fixture(provider,kind);
    const result=await factory.prepare(input);
    try {
      expect(result.boundary.status).toHaveProperty("browser",{
        version:1,provider,runtimeProfile:"zeros-cloud-worker-v3",credentialKind:kind,state:"unavailable",reason,
      });
      expect(result.boundary.status.state).toBe("ready");
    } finally { await result.boundary.stopAndProve(); }
  });
  it.each([false,true])("separates successful private admission from actual Design registration (%s)",async design=>{
    const {factory,input,workload}=fixture();
    const result=await factory.prepare({...input,...(design?{productTools:{env:{},servers:[{name:"design-draft",transport:"http" as const,url:"http://127.0.0.1:1234/mcp"}]}}:{})});
    try{
      expect(result.boundary.status.cloudExecution).toEqual({version:1,profile:"zeros-cloud-native-v1",runtimeProfile:"zeros-cloud-worker-v3",provider:"cursor",designApi:design?"admitted":"unavailable"});
      expect(cloudProviderExecution(result.boundary)).not.toBeNull();
      expect(cloudProviderExecution(workload)).toBeNull();
      expect(workload.status).not.toHaveProperty("cloudExecution");
    }finally{await result.boundary.stopAndProve();}
  });
  it.each(["failed canary","late aborted canary"])("does not publish a core diagnostic after %s",async reason=>{
    const {factory,input,workload,coordinator,controller}=fixture();
    vi.mocked(CloudNativeBoundary.prepare).mockImplementation(async()=>{
      if(reason==="failed canary")throw new Error("canary failed");
      controller.abort();return coordinator as unknown as CloudNativeBoundary;
    });
    await expect(factory.prepare(input)).rejects.toThrow();
    expect(workload.stopAndProve).toHaveBeenCalled();expect(cloudProviderExecution(workload)).toBeNull();
    expect(workload.status).not.toHaveProperty("cloudExecution");
  });
  it("does not publish admission after an untrusted product transport",async()=>{
    const {factory,input,workload}=fixture();
    await expect(factory.prepare({...input,productTools:{env:{},servers:[{name:"design-draft",transport:"stdio",command:"untrusted"}]}})).rejects.toThrow(/scoped remote/);
    expect(workload.stopAndProve).toHaveBeenCalled();expect(cloudProviderExecution(workload)).toBeNull();
  });
});
