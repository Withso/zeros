import {describe,expect,it,vi} from "vitest";
import type {CloudProviderExecution} from "../../../../cloud-provider-execution";
import {cloudCursorRequest} from "../cloud-policy";

function execution(){
  return {lease:{assertLive:vi.fn(),admission:{model:"qualified-model"}},
    coordinator:{environment:()=>({CURSOR_API_KEY:"synthetic-private-key"})},
    productServers:[{name:"design",transport:"http",url:"http://127.0.0.1:7000/scoped",headers:{Authorization:"Bearer synthetic-capability"}}],
    tools:{inputSchema:{type:"object"}}} as unknown as CloudProviderExecution;
}
describe("Cursor cloud request authority",()=>{
  it.each(["agent.create","agent.resume","platform.prewarm"])("keeps native tools and reapplies credential policy for %s",operation=>{
    const unsafe={apiKey:"untrusted-key",model:{id:"qualified-model"},tools:["shell","task"],
      cwd:"/private",local:{settingSources:["project"],customTools:{override:{}},enableAgentRetries:true},
      mcpServers:{injected:{command:"sh"}},cloud:{envVars:{SECRET:"injected"}},agents:[{}],mode:"plan"};
    const actual=cloudCursorRequest(execution(),operation,operation==="agent.resume"?{agentId:"existing",opts:unsafe}:unsafe);
    const opts=operation==="agent.resume"?(actual as {opts:unknown}).opts:actual;
    expect(opts).toEqual({apiKey:"synthetic-private-key",model:{id:"qualified-model"},cwd:"/srv/zeros/workspace",
      local:{cwd:"/srv/zeros/workspace",settingSources:[],enableAgentRetries:false,autoReview:false},
      mcpServers:{design:{url:"http://127.0.0.1:7000/scoped",headers:{Authorization:"Bearer synthetic-capability"}}},
      mode:"plan"});
  });
  it("does not allow a send to replace MCP, native tool policy or credentials",()=>{
    const actual=cloudCursorRequest(execution(),"agent.send",{agentId:"agent",handleId:"handle",runId:"run",message:"continue",
      options:{apiKey:"injected",tools:["shell"],mcpServers:{injected:{command:"sh"}},local:{customTools:{inject:{}}},
        cloud:{envVars:{SECRET:"bad"}},mode:"agent",idempotencyKey:"turn-1",model:{id:"qualified-model",params:[{id:"reasoning",value:"xhigh"}]}}});
    expect(actual).toEqual({agentId:"agent",handleId:"handle",runId:"run",message:"continue",options:{mode:"agent",idempotencyKey:"turn-1",
      model:{id:"qualified-model",params:[{id:"reasoning",value:"xhigh"}]}}});
  });
  it("preserves only boolean native delta and step observer flags",()=>{
    const actual=cloudCursorRequest(execution(),"agent.send",{message:"next",observers:{delta:true,step:true,untrusted:"ignored"}});
    expect(actual).toMatchObject({observers:{delta:true,step:true}});
    expect((actual as {observers:unknown}).observers).toEqual({delta:true,step:true});
  });
  it("rejects model changes, malformed model parameters, unsupported modes, and expired leases",()=>{
    for(const model of [{id:"unqualified-model"},{id:"qualified-model",params:[{id:"x",value:{malicious:true}}]}]){
      expect(()=>cloudCursorRequest(execution(),"agent.create",{model})).toThrow();
    }
    expect(()=>cloudCursorRequest(execution(),"agent.create",{mode:"shell"})).toThrow();
    const expired=execution();vi.mocked(expired.lease.assertLive).mockImplementation(()=>{throw new Error("expired");});
    expect(()=>cloudCursorRequest(expired,"store.open",{})).toThrow("expired");
  });
});

it.each([true,false])("preserves Cursor auto-review %s for cold starts, resumes and prewarm",autoReview=>{
  for(const operation of ["agent.create","agent.resume","platform.prewarm"]){
    const opts={local:{autoReview}};
    const result=cloudCursorRequest(execution(),operation,operation==="agent.resume"?{agentId:"native",opts}:opts) as {opts?:unknown};
    expect(operation==="agent.resume"?result.opts:result).toMatchObject({local:{autoReview}});
  }
});
