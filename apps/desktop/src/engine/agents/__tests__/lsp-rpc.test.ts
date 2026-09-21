import {PassThrough} from "node:stream";
import {describe,it,expect,vi,afterEach} from "vitest";
import type {BoundaryProcess} from "../containment/types";
import {LspRpc} from "../lsp-rpc";

function frame(value:unknown){const bytes=Buffer.from(JSON.stringify(value));return Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`),bytes]);}
function fixture(){
  const stdin=new PassThrough(),stdout=new PassThrough(),stderr=new PassThrough(),failed=vi.fn();
  const child={stdin,stdout,stderr,wait:()=>new Promise(()=>{})} as unknown as BoundaryProcess;
  const rpc=new LspRpc(child,failed);return {rpc,stdin,stdout,stderr,failed};
}
afterEach(()=>vi.useRealTimers());
describe("bounded LSP framing",()=>{
  it("handles split UTF8 and coalesced responses without confusing byte lengths",async()=>{
    const {rpc,stdout}=fixture();const one=rpc.request("one",{}),two=rpc.request("two",{});
    const bytes=Buffer.concat([frame({jsonrpc:"2.0",id:2,result:"日本語"}),frame({jsonrpc:"2.0",id:1,result:{ok:true}})]);
    for(const byte of bytes)stdout.write(Buffer.from([byte]));
    expect(await one).toEqual({ok:true});expect(await two).toBe("日本語");rpc.close();
  });
  it.each(["Content-Length: 9999999\r\n\r\n","Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}","X-Foo: value\r\nContent-Length: 2\r\n\r\n{}"])("rejects invalid or oversized headers",async header=>{
    const {rpc,stdout,failed}=fixture();const result=rpc.request("one",{}).catch(error=>error.code);
    stdout.write(header);expect(await result).toMatch(/unavailable|output_limit/);expect(failed).toHaveBeenCalledOnce();
  });
  it("rejects every pending call when a response omits both result and error",async()=>{
    vi.useFakeTimers();const {rpc,stdout}=fixture();let outcome="pending";
    const done=rpc.request("one",{}).then(()=>{outcome="resolved";},()=>{outcome="rejected";});
    stdout.write(frame({jsonrpc:"2.0",id:1}));await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("rejected");await done;
  });
  it("cancels only the exact request and never delivers its late response",async()=>{
    const {rpc,stdout}=fixture(),abort=new AbortController();const one=rpc.request("one",{},abort.signal).catch(error=>error.code);
    abort.abort();const two=rpc.request("two",{});stdout.write(frame({jsonrpc:"2.0",id:1,result:"stale"}));stdout.write(frame({jsonrpc:"2.0",id:2,result:"current"}));
    expect(await one).toBe("unavailable");expect(await two).toBe("current");rpc.close();
  });
  it("refuses server edit requests and never reflects server diagnostic text",async()=>{
    const {rpc,stdin,stdout}=fixture(),sent:Buffer[]=[];stdin.on("data",chunk=>sent.push(chunk));
    stdout.write(frame({jsonrpc:"2.0",id:"server",method:"workspace/applyEdit",params:{secret:"private-sentinel"}}));
    expect(Buffer.concat(sent).toString()).toContain("Unsupported request");expect(Buffer.concat(sent).toString()).not.toContain("private-sentinel");rpc.close();
  });
  it("caps pending requests and retires on a timed-out server",async()=>{
    vi.useFakeTimers();const {rpc,failed}=fixture();const pending=Array.from({length:8},()=>rpc.request("one",{}).catch(error=>error.code));
    await expect(rpc.request("overflow",{})).rejects.toMatchObject({code:"capacity"});await vi.advanceTimersByTimeAsync(10001);
    expect(await Promise.all(pending)).toContain("timeout");expect(failed).toHaveBeenCalledOnce();
  });
});
