import {describe,expect,it,vi} from "vitest";
import type {CloudLegacyProviderExecution} from "../../../../cloud-provider-execution";
import {cloudCursorRequest} from "../cloud-policy";

function execution(cwd="/srv/zeros/workspace"){
  const lease = {assertLive:vi.fn(),admission:{model:"qualified-model"}};
  return {mode:"actor-grant-v1",cwd,model:"qualified-model",lifetime:lease,lease,
    coordinator:{environment:()=>({CURSOR_API_KEY:"synthetic-private-key"})},
    productServers:[{name:"design",transport:"http",url:"http://127.0.0.1:7000/scoped",headers:{Authorization:"Bearer synthetic-capability"}}],
    tools:{inputSchema:{type:"object"}}} as unknown as CloudLegacyProviderExecution;
}
describe("Cursor cloud request authority",()=>{
  it("reads immutable common model/customization metadata rather than legacy lease fields", () => {
    const admitted = execution();
    Object.assign(admitted, { customization: { version: 1, digest: "a".repeat(64), repositoryDigest: "b".repeat(64),
      servers: [], skills: [], cursorTeamSettings: "disabled" } });
    Object.assign(admitted.lease.admission, { model: "stale-lease-model" });
    const actual = cloudCursorRequest(admitted, "agent.create", { model: { id: "qualified-model" } });
    expect(actual).toMatchObject({ model: { id: "qualified-model" }, local: { settingSources: ["user"] } });
  });
  it("enforces the common session lifetime before every native request", () => {
    const admitted = execution();
    const closed = Object.assign(new Error("Synthetic closed session lifetime"), { code: "cloud_validation_lease_expired" });
    Object.assign(admitted, { lifetime: { assertLive: vi.fn(() => { throw closed; }) } });
    expect(() => cloudCursorRequest(admitted, "agent.send", { message: "continue" })).toThrow(closed);
    expect(admitted.lease.assertLive).not.toHaveBeenCalled();
  });
  it.each(["/srv/zeros/workspace","/srv/zeros/state/workspaces/managed-worktree","/srv/zeros/workspace/packages/app"])("binds every workspace operation to the admitted root %s",cwd=>{
    const admitted=execution(cwd);
    for(const operation of ["agent.create","platform.prewarm","agent.resume","agent.list","store.open"]){
      const unsafe={cwd:"/untrusted-renderer-root",local:{cwd:"/other-member-root"},opts:{cwd:"/untrusted-renderer-root"}};
      const actual=cloudCursorRequest(admitted,operation,operation==="agent.resume"?{agentId:"native",opts:unsafe}:unsafe) as {cwd?:string;local?:{cwd:string};opts?:{cwd:string;local:{cwd:string}}};
      const options=operation==="agent.resume"?actual.opts!:operation==="agent.list"?actual.opts!:actual;
      expect(options.cwd).toBe(cwd);
      if(operation!=="agent.list"&&operation!=="store.open")expect(options.local?.cwd).toBe(cwd);
    }
  });
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
