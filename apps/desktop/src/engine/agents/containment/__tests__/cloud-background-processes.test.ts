import {spawn} from "node:child_process";
import {once} from "node:events";
import {describe,expect,it} from "vitest";
import {hasCloudBackgroundServers} from "../cloud-background-processes";

describe("execution-owned server observation",()=>{
  it("finds a real child listener, excludes another execution, and observes its exit",async()=>{
    const server=spawn(process.execPath,["-e","require('node:http').createServer((_,r)=>r.end('ok')).listen(0,'127.0.0.1',()=>process.stdout.write('ready'))"],{stdio:["ignore","pipe","pipe"]});
    const idle=spawn(process.execPath,["-e","process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:["ignore","pipe","pipe"]});
    const serverReady=once(server.stdout,"data"),idleReady=once(idle.stdout,"data");
    const serverExit=once(server,"exit"),idleExit=once(idle,"exit");
    try{
      await Promise.all([serverReady,idleReady]);
      expect(await hasCloudBackgroundServers([server.pid!])).toBe(true);
      expect(await hasCloudBackgroundServers([idle.pid!])).toBe(false);
      server.kill();await serverExit;expect(await hasCloudBackgroundServers([server.pid!])).toBe(false);
    }finally{server.kill();idle.kill();await Promise.all([serverExit,idleExit]);}
  });
  it("follows children on every native thread and matches the owned socket inode",async()=>{
    const io={
      list:async(path:string)=>path==="/proc/10/task"?["10","11"]:path==="/proc/20/task"?["20"]:path==="/proc/20/fd"?["3"]:[],
      read:async(path:string)=>path==="/proc/10/task/11/children"?"20":path.endsWith("/tcp")?"header\n0: local remote 0A 0 0 0 0 0 123\n":"",
      link:async()=>"socket:[123]",
    };
    expect(await hasCloudBackgroundServers([10],io)).toBe(true);
    expect(await hasCloudBackgroundServers([30],io)).toBe(false);
  });
  it("fails closed on denied inspection and bounded process/fd overflow",async()=>{
    const io={list:async()=>{throw Object.assign(new Error("denied"),{code:"EACCES"});},read:async()=>"",link:async()=>""};
    await expect(hasCloudBackgroundServers([10],io)).rejects.toThrow("denied");
    await expect(hasCloudBackgroundServers([10],{...io,list:async()=>Array(257).fill("1")})).rejects.toThrow("capacity");
  });
});
