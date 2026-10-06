import {randomUUID} from "node:crypto";
import {afterEach,describe,expect,it,vi} from "vitest";
import {CLOUD_NATIVE_PROVIDER_RESTRICTIONS,type ExecutionBoundaryStatus} from "@zeros/protocol/containment";
import {CloudNativeBoundary} from "../containment/cloud-native-boundary";
import type {PreparedBoundary} from "../containment/types";
import {adminWorkspaceSystemInstruction,cloudProviderExecution,createCloudAgentExecutionFactory} from "../cloud-provider-execution";
import {CLOUD_COMPUTER_ADMIN_WORKSPACE_NOTICE} from "@zeros/protocol/system-instructions";
import {resolveCloudRuntime} from "../containment/cloud-runtime-root.mjs";
import {AgentGateway} from "../gateway";
import type {AgentAdapter} from "../types";
import {testExecutionBoundary} from "./helpers/test-execution-boundary";
import type { CloudComputerExecutionEnvironment } from "@zeros/protocol/cloud-agent-execution";
import {readCloudRepositoryMcp} from "../cloud-mcp";

vi.mock("../containment/cloud-native-boundary",()=>({CloudNativeBoundary:{prepare:vi.fn()}}));
vi.mock("../cloud-mcp",async original=>{
  const actual=await original<typeof import("../cloud-mcp")>();
  return {...actual,readCloudRepositoryMcp:vi.fn(actual.readCloudRepositoryMcp)};
});
vi.mock("../containment/cloud-runtime-root.mjs",async original=>{
  const actual=await original<typeof import("../containment/cloud-runtime-root.mjs")>();
  return {...actual,resolveCloudRuntime:vi.fn(actual.resolveCloudRuntime)};
});
afterEach(()=>vi.resetAllMocks());
function fixture(provider: "claude"|"codex"|"cursor"="cursor", credentialKind="cursor-api-key", computerToolsVersion?:1,environment?:CloudComputerExecutionEnvironment){
  const status:ExecutionBoundaryStatus={version:1,actor:"agent-code",state:"ready",backend:"cloud-worker",
    designProtection:{required:true,enforced:true,protectedDirectoryCount:1},
    parity:{level:"restricted",restrictions:[...CLOUD_NATIVE_PROVIDER_RESTRICTIONS.cursor]},checkedAt:Date.now()};
  const workload={generation:"workload",status,attestation:Promise.resolve(),stopAndProve:vi.fn(async()=>{})} as unknown as PreparedBoundary;
  const controller=new AbortController();
  const coordinator={...workload,environment:()=>({}),providerHomePath:"/private"};
  vi.mocked(CloudNativeBoundary.prepare).mockResolvedValue(coordinator as unknown as CloudNativeBoundary);
  const leaseId=randomUUID();
  const request=vi.fn(async(input:{kind:string})=>input.kind==="release"?{released:true}:{leaseId,authorityId:"a".repeat(64),
    expiresAt:new Date(Date.now()+45000).toISOString(),credentialVersion:1,...(computerToolsVersion?{computerToolsVersion}:{}),credentialKind,provider,model:"grok-4.6",...(environment?{environment}:{}),material:
      credentialKind==="claude-setup-token"?{kind:credentialKind,accessToken:"synthetic-setup-token"}:
      credentialKind==="codex-chatgpt"?{kind:credentialKind,accessToken:"synthetic-chatgpt-token",accountId:"synthetic-account",expiresAt:2_100_000_000}:
      {kind:credentialKind,apiKey:"synthetic-provider-key"}});
  const factory=createCloudAgentExecutionFactory({request,supervisor:{onRetirementFailure:vi.fn()}});
  const input={admission:{executionId:randomUUID(),delegationId:randomUUID(),provider,model:"grok-4.6",
    source:{kind:"session" as const,actorSessionId:randomUUID()}},conversationId:randomUUID(),workload,cwd:"/srv/zeros/workspace",signal:controller.signal};
  return {factory,input,workload,coordinator,controller};
}
describe("admitted native cloud diagnostic",()=>{
  it("starts a v4 basic turn when optional customization is unqualified and reports the restriction", async () => {
    vi.mocked(resolveCloudRuntime).mockReturnValue({ ...resolveCloudRuntime(), profile: "v4" } as ReturnType<typeof resolveCloudRuntime>);
    vi.mocked(readCloudRepositoryMcp).mockResolvedValueOnce([]);
    const { factory, input } = fixture();
    const result = await factory.prepare({ ...input, customization: true });
    try {
      const execution = cloudProviderExecution(result.boundary)!;
      expect(execution.lease.admission.customization?.version).toBe(3);
      expect(execution.userServers).toEqual([]);
      expect(result.boundary.status.parity.restrictions).toContain("user-mcp-disabled");
    } finally { await result.boundary.stopAndProve(); }
  });
  it.each(["claude","codex","cursor"] as const)("composes admitted computer and Design servers for %s and retires both with the execution",async provider=>{
    vi.mocked(resolveCloudRuntime).mockReturnValue({...resolveCloudRuntime(),profile:"v4"} as ReturnType<typeof resolveCloudRuntime>);
    const {factory,input}=fixture(provider,`${provider}-api-key`,1);
    const result=await factory.prepare({...input,productTools:{env:{DESIGN_AUTH:"Bearer synthetic-design-capability"},servers:[{
      name:"design-draft",transport:"http",url:"http://127.0.0.1:1234/mcp",headersFromEnv:{Authorization:"DESIGN_AUTH"},
    }]}});
    const execution=cloudProviderExecution(result.boundary)!;
    expect(adminWorkspaceSystemInstruction(result.boundary,"Existing workspace orientation"))
      .toBe(`Existing workspace orientation\n\n${CLOUD_COMPUTER_ADMIN_WORKSPACE_NOTICE}`);
    expect(adminWorkspaceSystemInstruction(input.workload,"Ordinary workspace orientation"))
      .toBe("Ordinary workspace orientation");
    expect(execution.productServers.map(server=>server.name)).toEqual(["design-draft","cloud-computer"]);
    const computer=execution.productServers[1]!;
    if(computer.transport!=="http")throw new Error("Expected HTTP product transport");
    expect(execution.redactor!.value(computer.headers!.Authorization)).toBe("[redacted]");
    expect(execution.redactor!.value("synthetic-design-capability")).toBe("[redacted]");
    expect((await fetch(computer.url)).status).toBe(401);
    await result.boundary.stopAndProve();
    expect(execution.lease.signal.aborted).toBe(true);
    await expect(fetch(computer.url)).rejects.toThrow();
  });
  it("keeps computer tools absent without CP admission and rejects a caller-supplied namesake",async()=>{
    const {factory,input}=fixture();
    const result=await factory.prepare(input);
    expect(adminWorkspaceSystemInstruction(result.boundary)).toBeUndefined();
    expect(cloudProviderExecution(result.boundary)!.productServers.some(server=>server.name==="cloud-computer")).toBe(false);
    await result.boundary.stopAndProve();
    const another=fixture();
    await expect(another.factory.prepare({...another.input,productTools:{env:{},servers:[{
      name:"cloud-computer",transport:"http",url:"http://127.0.0.1:1234/mcp",
    }]}})).rejects.toThrow("private execution admission");
  });
  it("requires v4 even if an older local runtime receives the capability",async()=>{
    const {factory,input,workload}=fixture("cursor","cursor-api-key",1);
    await expect(factory.prepare(input)).rejects.toThrow("Update the cloud runtime");
    expect(workload.stopAndProve).toHaveBeenCalled();
  });
  it("retires the computer endpoint through gateway Stop even if native cancellation hangs",async()=>{
    vi.mocked(resolveCloudRuntime).mockReturnValue({...resolveCloudRuntime(),profile:"v4"} as ReturnType<typeof resolveCloudRuntime>);
    const {factory,input}=fixture("cursor","cursor-api-key",1);
    const result=await factory.prepare(input);
    const execution=cloudProviderExecution(result.boundary)!;
    const computer=execution.productServers[0]!;
    if(computer.transport!=="http")throw new Error("Expected HTTP product transport");
    const gateway=new AgentGateway({projectRoot:"/w",executionBoundary:testExecutionBoundary(),
      events:{onSessionUpdate(){},onPermissionRequest(){},onQuestionRequest(){},onAgentStderr(){},onAgentExit(){}}});
    const state=gateway as unknown as {adapters:Map<string,AgentAdapter>;executionToAgent:Map<string,string>;executionBoundaries:Map<string,PreparedBoundary>};
    state.adapters.set("cursor",{agentId:"cursor",cancel:()=>new Promise(()=>{})} as unknown as AgentAdapter);
    state.executionToAgent.set(input.admission.executionId,"cursor");
    state.executionBoundaries.set(input.admission.executionId,result.boundary);
    try{
      await gateway.cancel("cursor",input.admission.executionId);
      expect(execution.lease.signal.aborted).toBe(true);
      await expect(fetch(computer.url,{headers:computer.headers})).rejects.toThrow();
    }finally{await result.boundary.stopAndProve();}
  });
  it("redacts org literals even when native process preparation fails before history opens", async () => {
    const environment:CloudComputerExecutionEnvironment={version:1,revision:"c".repeat(64),values:{ORG_KEY:"synthetic-org-value"},
      history:{owner:"a".repeat(64),currentKeyVersion:1,keys:{1:"b".repeat(43)}}};
    const {factory,input,workload}=fixture("cursor","cursor-api-key",undefined,environment);
    vi.mocked(CloudNativeBoundary.prepare).mockImplementation(async lease=>{
      expect(lease.environment?.values).toEqual(environment.values);
      throw new Error("native failed: synthetic-org-value");
    });
    await expect(factory.prepare(input)).rejects.toThrow("native failed: [redacted]");
    expect(JSON.stringify(workload.status)).not.toContain("synthetic-org-value");
    expect(process.env.ORG_KEY).toBeUndefined();
  });
  it("reports the verified v4 profile for execution and unavailable Browser",async()=>{
    const legacy=resolveCloudRuntime();
    vi.mocked(resolveCloudRuntime).mockReturnValue({...legacy,profile:"v4"} as ReturnType<typeof resolveCloudRuntime>);
    const {factory,input}=fixture();
    const result=await factory.prepare(input);
    try {
      expect(result.boundary.status.cloudExecution?.runtimeProfile).toBe("zeros-cloud-worker-v4");
      expect(result.boundary.status.browser).toMatchObject({runtimeProfile:"zeros-cloud-worker-v4",state:"unavailable",reason:"provider-unsupported"});
    } finally { await result.boundary.stopAndProve(); }
  });
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
