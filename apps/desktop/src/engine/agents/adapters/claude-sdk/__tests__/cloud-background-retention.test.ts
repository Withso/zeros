import {afterEach,describe,expect,it,vi} from "vitest";
import {ClaudeSdkAdapter} from "../adapter";
import * as executions from "../../../cloud-provider-execution";

afterEach(()=>vi.restoreAllMocks());
function fixture(){
  const state={disposed:false,query:{},input:{closed:false,pendingCount:0},claudeSessionId:"native-chat",turn:null,turnIdle:null,
    pendingPromptCalls:0,turnlessRunsPending:0,providerRunActive:false,scheduledWakeupStop:null,pendingPermissions:new Map(),pendingQuestions:new Map(),
    translator:{hasProcessWork:false},pendingSteers:new Map(),cancelOperation:null,executionBoundary:{},queryAllowsBypass:false,pendingRestart:false,
    env:{ZEROS_THINKING_EFFORT:"high"}};
  vi.spyOn(executions,"cloudProviderExecution").mockReturnValue({background:{retained:false,preservesNativeProcess:true}} as never);
  const adapter=Object.create(ClaudeSdkAdapter.prototype) as {sessions:Map<string,unknown>;canDetachIdleQuery(state:unknown):boolean;
    assertBackgroundReuse(opts:{sessionId:string;env:Record<string,string>;modeId?:string}):void};
  adapter.sessions=new Map([["execution",state]]);return {adapter,state};
}
describe("Claude retained native process",()=>{
  it("keeps a leased server alive during next-turn configuration before prompt begins",()=>{
    const {adapter,state}=fixture();expect(adapter.canDetachIdleQuery(state)).toBe(false);
  });
  it("rejects restart-only changes before reuse but accepts settings supported by the existing query",()=>{
    const {adapter,state}=fixture();
    expect(()=>adapter.assertBackgroundReuse({sessionId:"execution",env:{ZEROS_THINKING_EFFORT:"high"}})).not.toThrow();
    expect(()=>adapter.assertBackgroundReuse({sessionId:"execution",env:{ZEROS_THINKING_EFFORT:"max"}})).toThrow(/Stop background work/);
    expect(()=>adapter.assertBackgroundReuse({sessionId:"execution",env:state.env,modeId:"bypass"})).toThrow(/Stop background work/);
    expect(state.env.ZEROS_THINKING_EFFORT).toBe("high");expect(state.pendingRestart).toBe(false);
  });
});
