import {access,rm} from "node:fs/promises";
import {afterEach,describe,expect,it,vi} from "vitest";
import {syntheticCodexCache} from "./codex-auth-test-fixture.js";
const state=vi.hoisted(()=>({directories:[] as string[],listeners:[] as number[]}));
vi.mock("node:child_process",async original=>{
  const actual=await original<typeof import("node:child_process")>();
  return {...actual,spawn:((_command:unknown,_args:unknown,options:import("node:child_process").SpawnOptions)=>{
    const child=actual.spawn("/zeros-synthetic-missing-native-executable",[],{...options,env:{}});
    state.directories.push(String(options.cwd));
    // Prevent the intentional regression from crashing Vitest itself while
    // counting whether production installed its own listener before the event.
    child.on("error",()=>{state.listeners.push(child.listenerCount("error")-1);});
    return child;
  })};
});
import {renewCodexNativeAuth} from "./codex-auth-keeper.js";
afterEach(async()=>{for(const directory of state.directories)await rm(directory,{recursive:true,force:true});});
describe("trusted native Codex keeper launch failure",()=>{
  it("handles failed spawn, erases private cache and frees slots without signalling a nonexistent PID",async()=>{
    const dispatch=vi.fn(async()=>{});
    for(let i=0;i<3;i++)await expect(renewCodexNativeAuth(syntheticCodexCache(),dispatch)).rejects.toThrow("Codex authentication renewal is unavailable");
    expect(dispatch).toHaveBeenCalledTimes(3);expect(state.listeners).toHaveLength(3);expect(state.listeners.every(n=>n>0)).toBe(true);
    for(const directory of state.directories)await expect(access(directory)).rejects.toMatchObject({code:"ENOENT"});
  });
});
