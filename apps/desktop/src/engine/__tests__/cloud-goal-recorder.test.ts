import {describe,expect,it,vi} from "vitest";
import type {CloudCommandClaim,CloudGoalSnapshot} from "@zeros/protocol/cloud-commands";
import {CloudGoalRecorder} from "../cloud-goal-recorder";

const claim={conversationId:"conversation"} as CloudCommandClaim;
const goal={objective:"Finish",status:"paused" as const,tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:1,updatedAt:1};
describe("confirmed cloud goal persistence",()=>{
  it("releases an active goal when a later command pauses it without accepting older acknowledgements", async () => {
    let release!: () => void;
    const recorder = new CloudGoalRecorder(async (_claim, revision, value) => {
      if (value?.status === "paused") await new Promise<void>(resolve => { release = resolve; });
      return { version: 1, conversationId: "conversation", revision, goal: value };
    });
    const nextClaim = { conversationId: "conversation" } as CloudCommandClaim;
    await recorder.observe(claim, { ...goal, status: "active" });
    const pause = recorder.observe(nextClaim, goal);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(recorder.active()).toBe(true);
    release(); await pause; expect(recorder.active()).toBe(false);
    const olderPause = recorder.observe(nextClaim, goal);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await recorder.observe(claim, { ...goal, status: "active" });
    release(); await olderPause; expect(recorder.active()).toBe(true);
  });
  it("protects a running goal beyond the foreground turn and releases a confirmed paused/cleared goal", async () => {
    const recorder = new CloudGoalRecorder(async (_claim, revision, value) => ({ version: 1, conversationId: "conversation", revision, goal: value }));
    await recorder.observe(claim, { ...goal, status: "active" }); expect(recorder.active()).toBe(true);
    await recorder.observe(claim, goal); expect(recorder.active()).toBe(false);
    await recorder.observe(claim, { ...goal, status: "active" }); expect(recorder.active()).toBe(true);
    await recorder.observe(claim, null); expect(recorder.active()).toBe(false);
  });
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
