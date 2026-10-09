import {randomUUID} from "node:crypto";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {afterEach,describe,expect,it,vi} from "vitest";
import {CLOUD_NATIVE_PROVIDER_RESTRICTIONS,type ExecutionBoundaryStatus} from "@zeros/protocol/containment";
import {CloudNativeBoundary} from "../containment/cloud-native-boundary";
import type {PreparedBoundary} from "../containment/types";
import {adminWorkspaceSystemInstruction,cloudProviderExecution,cloudExecutionLifetime,createCloudAgentExecutionFactory} from "../cloud-provider-execution";
import {CLOUD_COMPUTER_ADMIN_WORKSPACE_NOTICE} from "@zeros/protocol/system-instructions";
import {resolveCloudRuntime} from "../containment/cloud-runtime-root.mjs";
import {AgentGateway} from "../gateway";
import type {AgentAdapter} from "../types";
import {testExecutionBoundary} from "./helpers/test-execution-boundary";
import type { CloudComputerExecutionEnvironment } from "@zeros/protocol/cloud-agent-execution";
import {readCloudRepositoryMcp,cloudMcpDigest} from "../cloud-mcp";
import {CloudRepositoryMcpSchema as CpRepositoryMcpSchema} from "../../../../../control-plane/src/cloud-workspaces/mcp-contract";
import {admitCustomization} from "../../../../../control-plane/src/cloud-workspaces/mcp-admission";
import type {Tx} from "../../../../../control-plane/src/db";
import type {CloudAgentExecutionAdmission} from "@zeros/protocol/cloud-agent-execution";
import {cloudClaudeTools} from "../adapters/claude-sdk/cloud-tools";

vi.mock("../containment/cloud-native-boundary",()=>({CloudNativeBoundary:{prepare:vi.fn()}}));
vi.mock("../cloud-mcp",async original=>{
  const actual=await original<typeof import("../cloud-mcp")>();
  return {...actual,readCloudRepositoryMcp:vi.fn(actual.readCloudRepositoryMcp)};
});
vi.mock("../containment/cloud-runtime-root.mjs",async original=>{
  const actual=await original<typeof import("../containment/cloud-runtime-root.mjs")>();
  const {testCloudRuntime}=await import("./helpers/test-cloud-runtime");
  return {...actual,resolveCloudRuntime:vi.fn(testCloudRuntime)};
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
  return {factory,input,workload,coordinator,controller,request};
}
function legacyExecution(boundary:PreparedBoundary){
  const execution=cloudProviderExecution(boundary);
  if(!execution||execution.mode!=="actor-grant-v1")throw new Error("Expected genuine legacy admission");
  return execution;
}
describe("admitted native cloud diagnostic",()=>{
  it.each(["claude", "cursor", "codex"] as const)("publishes immutable common %s metadata and its genuine legacy lifetime/auth owner", async provider => {
    const { factory, input } = fixture(provider, `${provider}-api-key`);
    const result = await factory.prepare(input);
    try {
      const execution = legacyExecution(result.boundary);
      expect(execution).toMatchObject({ mode: "actor-grant-v1", provider, model: input.admission.model,
        executionId: input.admission.executionId, conversationId: input.conversationId, cwd: input.cwd,
        credentialKind: `${provider}-api-key`, customization: null, environment: null, gitAuthor: null,
        nativeCapabilities: null, backgroundTasksVersion: null, computerToolsVersion: null });
      expect(execution.lifetime).toBe(execution.lease);
      expect(execution.auth).toBe(execution.lease);
      expect(cloudExecutionLifetime(execution)).toBe(execution.lease);
      expect(Object.isFrozen(execution)).toBe(true);
      expect(execution.lease.admission).toEqual(input.admission);
      expect(cloudProviderExecution(input.workload)).toBeNull();
    } finally { await result.boundary.stopAndProve(); }
  });
  it("passes optional authority flight observations and internal request metadata through the real lease", async () => {
    const { input, request } = fixture();
    const authority = await request({ kind: "admit" }); request.mockClear();
    if (!("leaseId" in authority)) throw new Error("Expected admission authority fixture");
    const leaseId = authority.leaseId;
    const authorityObservation = { created: vi.fn(), wait: vi.fn(), settled: vi.fn() };
    const factory = createCloudAgentExecutionFactory({ request, supervisor: { onRetirementFailure: vi.fn() }, authorityObservation });
    request.mockResolvedValueOnce(authority);
    const result = await factory.prepare(input);
    try {
      request.mockClear();
      request.mockResolvedValueOnce({ leaseId, credentialVersion: 1, expiresAt: new Date(Date.now() + 45_000).toISOString() } as typeof authority);
      await legacyExecution(result.boundary).lease.validate();
      expect(authorityObservation.created).toHaveBeenCalledWith({ flightId: expect.any(String), operation: "validate", producer: "caller" });
      const flightId = authorityObservation.created.mock.calls[0]![0].flightId;
      expect(request).toHaveBeenCalledWith({ kind: "validate", leaseId, renew: false, credentialVersion: 1 }, expect.any(AbortSignal), { flightId });
    } finally { await result.boundary.stopAndProve(); }
  });
  it.each(["", "nested", ".zeros/worktrees/feature"].flatMap(suffix=>[undefined,".","tools"].map(relative=>({suffix,relative}))))("runs repository MCP in the admitted checkout with %j, retaining wire echo identity",async({suffix,relative})=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"cloud-mcp-cwd-")),cwd=path.join(root,suffix);
    await mkdir(path.join(cwd,"tools"),{recursive:true});
    await writeFile(path.join(root,"MARKER"),"primary");
    await writeFile(path.join(cwd,"MARKER"),suffix||"primary");await writeFile(path.join(cwd,"tools/MARKER"),`${suffix||"primary"}-tools`);
    await writeFile(path.join(cwd,".mcp.json"),JSON.stringify({mcpServers:{escape:{command:"node",cwd:"../outside"},tool:{command:process.execPath,args:["-e","process.stdout.write(require('node:fs').readFileSync('MARKER','utf8'))"],...(relative===undefined?{}:{cwd:relative})}}}));
    const {factory,input,request}=fixture("claude","claude-api-key");
    const authority=await request({kind:"admit"});request.mockClear();
    request.mockImplementationOnce(async raw=>{
      const requested=raw as unknown as {admission:CloudAgentExecutionAdmission};
      const repository=CpRepositoryMcpSchema.parse(requested.admission.customization!.repositoryServers);
      expect(repository).toHaveLength(1);
      if(relative===undefined)expect(repository[0]).not.toHaveProperty("cwd");
      else expect(repository[0]).toMatchObject({cwd:"/srv/zeros/workspace"+(relative==="tools"?"/tools":"")});
      const content={version:1 as const,repositoryDigest:"b".repeat(64),servers:repository.map(server=>({server,scope:"repository" as const,secretRef:null,revision:0})),skills:[],cursorTeamSettings:"disabled" as const};
      return {...authority,customization:{...content,digest:cloudMcpDigest(content)}};
    });
    try{
      const result=await factory.prepare({...input,cwd,customization:true});
      try{
        const execution=legacyExecution(result.boundary);
        if(relative===undefined)expect(execution.userServers![0]).not.toHaveProperty("cwd");
        else expect(execution.userServers![0]).toMatchObject({cwd:relative==="tools"?path.join(cwd,"tools"):cwd});
        expect(execution.lease.customization!.servers[0]!.server).toEqual(CpRepositoryMcpSchema.parse(execution.lease.admission.customization!.repositoryServers)[0]);
        const tool=cloudClaudeTools(execution).mcpServers!.tool as {command:string;args:string[]};
        expect((await promisify(execFile)(tool.command,tool.args,{cwd:execution.cwd})).stdout).toBe(`${suffix||"primary"}${relative==="tools"?"-tools":""}`);
      }finally{await result.boundary.stopAndProve();}
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it("retains a typed canary cause when retirement itself also fails",async()=>{
    const {factory,input,workload}=fixture();
    vi.mocked(CloudNativeBoundary.prepare).mockRejectedValueOnce(Object.assign(new Error("canary failed"),{code:"cloud_containment_canary_failed"}));
    vi.mocked(workload.stopAndProve).mockRejectedValueOnce(new Error("private retirement diagnostic"));
    await expect(factory.prepare(input)).rejects.toMatchObject({code:"cloud_containment_canary_failed"});
    expect(workload.stopAndProve).toHaveBeenCalledOnce();
  });
  it.each(["claude","codex","cursor"] as const)("admits the live digit-leading MCP shape and valid siblings through the %s factory",async provider=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"cloud-provider-mcp-"));
    await mkdir(path.join(root,".codex"));await mkdir(path.join(root,".cursor"));
    await writeFile(path.join(root,".mcp.json"),provider==="claude"?'{"mcpServers":{"0canvas":{"type":"http","url":"http://localhost:24193/mcp"},"valid":{"command":"node"},"invalid":{"command":"node","env":{"TOKEN":"${env:SECRET}"}}}}':"malformed");
    await writeFile(path.join(root,".cursor/mcp.json"),provider==="cursor"?'{"mcpServers":{"0canvas":{"type":"http","url":"http://localhost:24193/mcp"},"valid":{"command":"node"},"invalid":{"command":"node","env":{"TOKEN":"${env:SECRET}"}}}}':"malformed");
    await writeFile(path.join(root,".codex/config.toml"),provider==="codex"?'[mcp_servers.0canvas]\ntype="http"\nurl="http://localhost:24193/mcp"\n[mcp_servers.valid]\ncommand="node"\n[mcp_servers.invalid]\ncommand="node"\nenv={TOKEN="${env:SECRET}"}\n':"malformed=[");
    const {input,request}=fixture(provider,`${provider}-api-key`),onRepositoryMcpNotice=vi.fn();
    const authority=await request({kind:"admit"});request.mockClear();
    if(!("leaseId" in authority))throw new Error("Expected admission authority fixture");
    const grantedLeaseId=authority.leaseId;
    if(typeof grantedLeaseId!=="string")throw new Error("Expected admission lease fixture");
    const tx={query:vi.fn(async()=>({rows:[]}))} as unknown as Tx;
    request.mockImplementationOnce(async raw=>{
      const requested=raw as unknown as {admission:CloudAgentExecutionAdmission};
      const repository=CpRepositoryMcpSchema.parse(requested.admission.customization!.repositoryServers);
      const snapshot=await admitCustomization(tx,{organizationId:randomUUID(),workspaceId:randomUUID(),actorUserId:randomUUID()},grantedLeaseId,repository,
        {keys:{1:Buffer.alloc(32,1).toString("base64url")},currentKeyVersion:1},false,true);
      return {...authority,customization:snapshot};
    });
    const factory=createCloudAgentExecutionFactory({request,supervisor:{onRetirementFailure:vi.fn()},onRepositoryMcpNotice});
    try{
      const result=await factory.prepare({...input,cwd:root,customization:true});
      try{
        const execution=legacyExecution(result.boundary);
        expect(execution.cwd).toBe(root);
        expect(execution.userServers!.map(server=>server.name)).toEqual(["0canvas","valid"]);
        expect(execution.lease.admission.customization!.repositoryServers).toEqual(execution.userServers);
        expect(onRepositoryMcpNotice).toHaveBeenCalledWith({executionId:input.admission.executionId,conversationId:input.conversationId,provider,notice:{excluded:1,omitted:0,diagnostics:[{file:provider==="claude"?".mcp.json":provider==="codex"?".codex/config.toml":".cursor/mcp.json",server:"invalid",reason:"invalid_entry"}]}});
        expect(request).toHaveBeenCalledTimes(1);
        expect(tx.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO cloud_customization_execution_snapshots"),expect.any(Array));
      }finally{await result.boundary.stopAndProve();}
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it.each(["validation", "admission", "containment"] as const)("keeps a safe %s preparation cause after cleanup", async stage => {
    const { factory, input, request, workload } = fixture();
    if (stage === "validation") vi.mocked(resolveCloudRuntime).mockReturnValue({ ...resolveCloudRuntime(), profile: "v3" } as unknown as ReturnType<typeof resolveCloudRuntime>);
    else if (stage === "admission") request.mockRejectedValueOnce(new Error("private admission diagnostic"));
    else vi.mocked(CloudNativeBoundary.prepare).mockRejectedValueOnce(new Error("private containment diagnostic"));
    await expect(factory.prepare(input)).rejects.toMatchObject({ code: stage==="admission"?"cloud_admission_authority_unavailable":`cloud_${stage}_rejected` });
    expect(workload.stopAndProve).toHaveBeenCalled();
    if (stage === "validation") expect(request).not.toHaveBeenCalled();
  });
  it("starts a v4 basic turn when optional customization is unqualified and reports the restriction", async () => {
    vi.mocked(resolveCloudRuntime).mockReturnValue({ ...resolveCloudRuntime(), profile: "v4" } as ReturnType<typeof resolveCloudRuntime>);
    vi.mocked(readCloudRepositoryMcp).mockResolvedValueOnce([]);
    const { factory, input } = fixture();
    const result = await factory.prepare({ ...input, customization: true });
    try {
      const execution = legacyExecution(result.boundary);
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
    const execution=legacyExecution(result.boundary);
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
    expect(legacyExecution(result.boundary).productServers.some(server=>server.name==="cloud-computer")).toBe(false);
    await result.boundary.stopAndProve();
    const another=fixture();
    await expect(another.factory.prepare({...another.input,productTools:{env:{},servers:[{
      name:"cloud-computer",transport:"http",url:"http://127.0.0.1:1234/mcp",
    }]}})).rejects.toThrow("private execution admission");
  });
  it.each(["v1","v2","v3"])("refuses %s before requesting agent credentials",async profile=>{
    vi.mocked(resolveCloudRuntime).mockReturnValue({...resolveCloudRuntime(),profile} as ReturnType<typeof resolveCloudRuntime>);
    const {factory,input,workload,request}=fixture();
    await expect(factory.prepare(input)).rejects.toThrow("qualified v4");
    expect(request).not.toHaveBeenCalled();
    expect(workload.stopAndProve).toHaveBeenCalled();
  });
  it("retires the computer endpoint through gateway Stop even if native cancellation hangs",async()=>{
    vi.mocked(resolveCloudRuntime).mockReturnValue({...resolveCloudRuntime(),profile:"v4"} as ReturnType<typeof resolveCloudRuntime>);
    const {factory,input}=fixture("cursor","cursor-api-key",1);
    const result=await factory.prepare(input);
    const execution=legacyExecution(result.boundary);
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
        version:1,provider,runtimeProfile:"zeros-cloud-worker-v4",credentialKind:kind,state:"unavailable",reason,
      });
      expect(result.boundary.status.state).toBe("ready");
    } finally { await result.boundary.stopAndProve(); }
  });
  it.each([false,true])("separates successful private admission from actual Design registration (%s)",async design=>{
    const {factory,input,workload}=fixture();
    const result=await factory.prepare({...input,...(design?{productTools:{env:{},servers:[{name:"design-draft",transport:"http" as const,url:"http://127.0.0.1:1234/mcp"}]}}:{})});
    try{
      expect(result.boundary.status.cloudExecution).toEqual({version:1,profile:"zeros-cloud-native-v1",runtimeProfile:"zeros-cloud-worker-v4",provider:"cursor",designApi:design?"admitted":"unavailable"});
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
