import {PassThrough} from "node:stream";
import {afterEach,describe,expect,it,vi} from "vitest";
import type {CloudAgentLease} from "../../cloud-agent-lease";
import {attestCloudCoordinator} from "../cloud-coordinator-attestation";
import type {BoundaryProcess} from "../types";
afterEach(()=>vi.useRealTimers());
describe("private coordinator canary deadline",()=>{
  it.each(["reject","hang"])("retires authority when wait hangs and kill will %s",async failure=>{
    vi.useFakeTimers();const controller=new AbortController(),close=vi.fn(()=>{controller.abort();return Promise.reject(new Error("cleanup pending"));});
    const canary={stdout:new PassThrough(),wait:()=>new Promise(()=>{}),stopAndProve:()=>failure==="hang"?new Promise(()=>{}):Promise.reject(new Error("unproven"))} as unknown as BoundaryProcess;
    const lease={signal:controller.signal,close,retire:vi.fn(),assertLive:vi.fn()} as unknown as CloudAgentLease;
    const failed=expect(attestCloudCoordinator(lease,canary)).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5000);await failed;expect(close).toHaveBeenCalledOnce();expect(controller.signal.aborted).toBe(true);
  });
});
describe("private coordinator canary failure",()=>{
  // The canary's stderr can carry sandbox paths; its exit status is a fixed
  // number that tells an operator which isolation check (or the sandbox
  // launcher itself) refused admission.
  it.each([[91,"ZEROS_CANARY_EXIT_91"],[1,"ZEROS_CANARY_EXIT_1"],[0,"ZEROS_CANARY_OUTPUT"],[null,"ZEROS_CANARY_SIGNAL"]])("classifies exit %i as %s",async(code,expected)=>{
    const stdout=new PassThrough();stdout.end(code===0?"unexpected":"");
    const canary={stdout,wait:async()=>({code,signal:null})} as unknown as BoundaryProcess;
    const lease={signal:new AbortController().signal,close:vi.fn(async()=>{}),retire:vi.fn(),assertLive:vi.fn()} as unknown as CloudAgentLease;
    await expect(attestCloudCoordinator(lease,canary,"zeros-native-provider-v1")).rejects.toMatchObject({message:"Private coordinator admission failed",code:expected});
  });
});
