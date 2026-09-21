import {describe,expect,it,vi} from "vitest";
import type {CloudProviderExecution} from "../../../cloud-provider-execution";
import {cloudCodexImage,cloudCodexRequest,cloudCodexToolCall,CLOUD_CODEX_CONFIG} from "../cloud-policy";
const context=()=>({lease:{assertLive:vi.fn(),admission:{model:"qualified-model"}},tools:{inputSchema:{type:"object"},call:vi.fn()}}) as unknown as CloudProviderExecution;
describe("Codex cloud native authority",()=>{
  it("routes the exact workspace tool through its execution and rejects foreign names without reflecting errors",async()=>{
    const execution=context(),input={threadId:"thread",turnId:"turn",callId:"call",namespace:null,tool:"zeros_workspace",arguments:{operation:"lsp",request:{kind:"start",language:"python"}}};
    vi.mocked(execution.tools.call).mockResolvedValue({ok:true,data:{state:"running"}});
    expect(await cloudCodexToolCall(execution,input)).toMatchObject({success:true});expect(execution.tools.call).toHaveBeenCalledWith(input.arguments,undefined);
    vi.mocked(execution.tools.call).mockClear();
    expect(await cloudCodexToolCall(execution,{...input,namespace:"foreign"})).toMatchObject({success:false});expect(execution.tools.call).not.toHaveBeenCalled();
    vi.mocked(execution.tools.call).mockRejectedValue(new Error("private-secret-sentinel"));
    const result=await cloudCodexToolCall(execution,input);expect(result.success).toBe(false);expect(JSON.stringify(result)).not.toContain("private-secret-sentinel");
  });
  it("validates a large inline image without regex stack exhaustion",()=>{
    const data=Buffer.alloc(2*1024*1024,42).toString("base64");
    expect(cloudCodexImage(data,"image/png").url).toBe(`data:image/png;base64,${data}`);
    expect(()=>cloudCodexImage("Zh==","image/png")).toThrow();
  });
  it("carries validated inline images and refuses private file selectors on turns and steering",()=>{
    const image=cloudCodexImage("aGVsbG8=","image/png");
    for(const method of ["turn/start","turn/steer"]){
      expect(cloudCodexRequest(context(),"env",method,{threadId:"thread",input:[image]})).toMatchObject({input:[image]});
      for(const type of ["localImage","localAudio","skill","mention"])
        expect(()=>cloudCodexRequest(context(),"env",method,{threadId:"thread",input:[{type,path:"/home/zeros-agent/private"}]})).toThrow("private coordinator paths");
    }
    expect(()=>cloudCodexImage("not base64","image/png")).toThrow();expect(()=>cloudCodexImage("aGVsbG8=","image/svg+xml")).toThrow();
  });
  it("does not admit hidden native history, path, capability or provider fallback selectors",()=>{
    for(const method of ["thread/start","thread/resume","turn/start"]){
      const result=cloudCodexRequest(context(),"env",method,{threadId:"native",input:[{type:"text",text:"safe"}],history:[{role:"assistant"}],path:"/home/zeros-agent/private",
        selectedCapabilityRoots:[{path:"/home/zeros-agent"}],allowProviderModelFallback:true,futureHostOverride:{secret:true}}) as Record<string,unknown>;
      for(const key of ["path","history","selectedCapabilityRoots","futureHostOverride"])expect(result).not.toHaveProperty(key);
      expect(result.allowProviderModelFallback).not.toBe(true);expect(result.runtimeWorkspaceRoots).toEqual(["/srv/zeros/workspace"]);
    }
  });
  it("uses the pinned effort and permissions fields and preserves bounded native disables",()=>{
    expect(cloudCodexRequest(context(),"env","thread/settings/update",{threadId:"thread",effort:"high",permissions:"injected"})).toEqual({threadId:"thread",model:"qualified-model",effort:"high"});
    const turn=cloudCodexRequest(context(),"env","turn/start",{threadId:"thread",permissions:"injected",effort:"xhigh"});
    expect(turn).toMatchObject({effort:"xhigh",permissions:undefined});
    expect(cloudCodexRequest(context(),"env","thread/start",{config:{mcp_servers:{"foreign.server":{enabled:false,url:"https://untrusted.test",headers:{Authorization:"injected"}}}}})).toMatchObject({
      config:{mcp_servers:{"foreign.server":{enabled:false,command:"zeros-disabled-mcp-server"}}},
    });
    expect(cloudCodexRequest(context(),"env","thread/backgroundTerminals/list",{threadId:"thread"})).toEqual({threadId:"thread"});
  });
  it.each(["thread/start","turn/start"])("pins the workload on every %s, including empty/stale environment requests",method=>{
    const result=cloudCodexRequest(context(),"current-workload",method,{threadId:"thread",model:"qualified-model",cwd:"/private",environments:[],
      sandboxPolicy:{type:"workspaceWrite",writableRoots:["/private"]},config:{"features.multi_agent":true},dynamicTools:[{}]});
    expect(result).toMatchObject({model:"qualified-model",cwd:"/srv/zeros/workspace",environments:[{environmentId:"current-workload",cwd:"/srv/zeros/workspace",runtimeWorkspaceRoots:["/srv/zeros/workspace"]}]});
    if(method==="thread/start")expect(result).toMatchObject({config:CLOUD_CODEX_CONFIG,dynamicTools:[{type:"function",name:"zeros_workspace",inputSchema:{type:"object"}}]});
  });
  it("does not claim unsupported resume environment selection; every subsequent turn pins it",()=>{
    expect(cloudCodexRequest(context(),"env","thread/resume",{threadId:"native"})).toMatchObject({threadId:"native",environments:undefined,config:CLOUD_CODEX_CONFIG});
    expect(()=>cloudCodexRequest(context(),"env","turn/start",{model:"another-model"})).toThrow(/model/);
  });
  it.each(["process/spawn","fs/readFile","account/login/start","config/batchWrite","thread/fork","review/start","thread/goal/set"])("rejects unqualified host mutation %s",method=>{
    expect(()=>cloudCodexRequest(context(),"env",method,{})).toThrow(/not admitted/);
  });
});
