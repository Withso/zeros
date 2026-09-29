import {describe,expect,it,vi} from "vitest";
import type {CloudCommandClaim,CloudGoalSnapshot} from "@zeros/protocol/cloud-commands";
import {CloudGoalRecorder} from "../cloud-goal-recorder";

const claim={conversationId:"conversation"} as CloudCommandClaim;
const goal={objective:"Finish",status:"paused" as const,tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:1,updatedAt:1};
describe("confirmed cloud goal persistence",()=>{
  it("awaits durable acknowledgement and retains a clear over an older in-flight read",async()=>{
    let release!:(snapshot:CloudGoalSnapshot)=>void;
    const persist=vi.fn(()=>new Promise<CloudGoalSnapshot>(resolve=>{release=resolve;}));
    const recorder=new CloudGoalRecorder(persist),readRevision=recorder.revision(claim);
    let finished=false;const confirmed=recorder.observe(claim,null).then(()=>{finished=true;});
    await vi.waitFor(()=>expect(persist).toHaveBeenCalledOnce());expect(finished).toBe(false);
    const oldRead=recorder.confirm(claim,goal,readRevision);
    release({version:1,conversationId:"conversation",revision:7,goal:null});
    await Promise.all([confirmed,oldRead]);
    expect(persist).toHaveBeenCalledOnce();expect((await recorder.flush(claim))?.goal).toBeNull();
  });
  it("serializes set/clear and propagates persistence failure instead of acknowledging success",async()=>{
    const values:unknown[]=[];
    const recorder=new CloudGoalRecorder(async(_claim,sequence,value)=>{values.push(value);return {version:1,conversationId:"conversation",revision:sequence,goal:value};});
    await Promise.all([recorder.observe(claim,goal),recorder.observe(claim,null)]);
    expect(values).toEqual([goal,null]);expect((await recorder.flush(claim))?.revision).toBe(2);
    const failed=new CloudGoalRecorder(async()=>{throw new Error("unavailable");});
    await expect(failed.confirm(claim,null,0)).rejects.toThrow("unavailable");
    await expect(failed.flush(claim)).rejects.toThrow("unavailable");
  });
});
