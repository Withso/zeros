import {afterEach,describe,expect,it,vi} from "vitest";
import {PreviewRequestLease} from "./preview-request-lease.js";
afterEach(()=>vi.useRealTimers());
describe("HTTP preview authority lifetime",()=>{
  it("cancels a stalled request when renewal hangs beyond its original deadline",async()=>{
    vi.useFakeTimers({toFake:["Date","setTimeout","clearTimeout","performance"]});
    const check=vi.fn(()=>new Promise<number|null>(()=>{}));
    const lease=new PreviewRequestLease(Date.now()+60_000,new AbortController().signal,check);
    const pending=expect(lease.wait(()=>new Promise(()=>{}))).rejects.toThrow(/expired/);
    await vi.advanceTimersByTimeAsync(5000);expect(check).toHaveBeenCalledOnce();expect(lease.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);await pending;expect(lease.signal.aborted).toBe(true);
  });
  it("renews short authority but never extends the absolute request limit",async()=>{
    vi.useFakeTimers({toFake:["Date","setTimeout","clearTimeout","performance"]});
    const check=vi.fn(async()=>Date.now()+60_000),lease=new PreviewRequestLease(Date.now()+60_000,new AbortController().signal,check);
    await vi.advanceTimersByTimeAsync(59_000);expect(lease.signal.aborted).toBe(false);expect(check.mock.calls.length).toBeLessThan(13);
    await vi.advanceTimersByTimeAsync(1000);expect(lease.signal.aborted).toBe(true);
  });
  it("propagates caller cancellation and rejects a late authorization response",async()=>{
    vi.useFakeTimers({toFake:["Date","setTimeout","clearTimeout","performance"]});
    const caller=new AbortController();let resolve!:(value:number)=>void;
    const lease=new PreviewRequestLease(Date.now()+60_000,caller.signal,()=>new Promise(done=>{resolve=done;}));
    const pending=expect(lease.revalidate()).rejects.toThrow(/revoked/);
    // Let the check start; cancellation before this microtask correctly skips
    // it entirely and leaves no late authorization response to exercise.
    await Promise.resolve();caller.abort();await pending;
    resolve(Date.now()+60_000);await vi.advanceTimersByTimeAsync(0);expect(()=>lease.assertLive()).toThrow(/expired/);
  });
  it("starts asynchronous work only after confirming live authority",async()=>{
    vi.useFakeTimers({toFake:["Date","setTimeout","clearTimeout","performance"]});
    const lease=new PreviewRequestLease(Date.now()+60_000,new AbortController().signal,async()=>Date.now()+60_000);
    const operation=vi.fn(async()=>"body");
    await expect(lease.wait(operation)).resolves.toBe("body");lease.close();
    const rejected=vi.fn(async()=>{throw new Error("unobserved provider failure");});
    await expect(lease.wait(rejected)).rejects.toThrow(/expired/);expect(rejected).not.toHaveBeenCalled();
  });

});
