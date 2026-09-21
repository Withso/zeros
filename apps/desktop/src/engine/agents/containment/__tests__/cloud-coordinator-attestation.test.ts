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
