import {runInNewContext} from "node:vm";
import {describe,it,expect} from "vitest";
import {CLOUD_NATIVE_ADMISSION_CANARY} from "../cloud-native-boundary";

function run(changes:{uid?:number;gid?:number;caps?:string;namespace?:string;engineReadable?:boolean;cwd?:string;root?:string;directory?:boolean}={}){
  const checked:string[]=[],exit=(code:number)=>{throw Object.assign(new Error("Synthetic canary exit"),{exitCode:code});};
  const fs={readFileSync:(file:string)=>{checked.push(file);if(file==="/proc/self/status")return `CapEff:\t${changes.caps??"0000000000000000"}`;if(changes.engineReadable)return "engine authority";throw Object.assign(new Error("Denied"),{code:"EACCES"});},
    readlinkSync:()=>changes.namespace??"child-pid",writeFileSync:()=>{},unlinkSync:()=>{},realpathSync:(file:string)=>file==="/srv/zeros/workspace"?changes.root??file:changes.cwd??file,
    statSync:(file:string)=>{checked.push(file);if(file.endsWith("/.git"))throw Object.assign(new Error("No git directory"),{code:"ENOENT"});return {isDirectory:()=>changes.directory!==false,isFile:()=>false};}};
  let output="",code=0;
  try{runInNewContext(CLOUD_NATIVE_ADMISSION_CANARY,{require:(name:string)=>{if(name!=="node:fs")throw new Error("Unexpected module");return fs;},process:{getuid:()=>changes.uid??10001,getgid:()=>changes.gid??10001,argv:["node","parent-pid","engine-canary"],env:{HOME:"/private"},cwd:()=>changes.cwd??"/srv/zeros/workspace",exit,stdout:{write:(text:string)=>{output+=text;}}}});}
  catch(error){code=(error as {exitCode?:number}).exitCode??1;}
  return {code,output,checked};
}
describe("native provider admission canary",()=>{
  it("admits an ordinary directory without requiring Git metadata",()=>{
    const result=run();expect(result.code).toBe(0);expect(result.output).toBe("zeros-native-provider-v1");expect(result.checked.some(file=>file.endsWith("/.git"))).toBe(false);
  });
  it.each([{uid:0},{gid:0},{caps:"0000000000000001"},{namespace:"parent-pid"},{engineReadable:true},{cwd:"/outside"},{root:"/outside"},{directory:false}])("retains identity, namespace, authority and cwd checks: %j",changes=>{
    expect(run(changes).code).not.toBe(0);expect(run(changes).output).toBe("");
  });
});
