import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {describe,it,expect,vi} from "vitest";
import {cloudClaudeTools} from "../cloud-tools";
import type {CloudProviderExecution} from "../../../cloud-provider-execution";

// Bring up only the private namespace's loopback using stdlib ioctl. No ip
// package, external interface, host network mutation, or real API credential.
const loopback="import socket,fcntl,struct,os,sys;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);fcntl.ioctl(s.fileno(),0x8914,struct.pack('16sh',b'lo',0x49));os.execv(sys.argv[1],sys.argv[1:])";
describe.runIf(process.platform==="linux")("pinned Claude cloud configuration",()=>{
  it.each(["api","setup"])("loads both instruction sentinels without repository authority overrides (%s)",async kind=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-claude-native-"));
    try{
      await mkdir(path.join(root,"home/.claude"),{recursive:true});
      await mkdir(path.join(root,"project/.claude"),{recursive:true});
      await writeFile(path.join(root,"project/CLAUDE.md"),"W1_CLAUDE_SENTINEL_9b38\n");
      await writeFile(path.join(root,"project/AGENTS.md"),"W1_AGENTS_SENTINEL_54c2\n");
      const execution={cwd:path.join(root,"project"),lease:{assertLive:vi.fn(),customization:{servers:[],skills:[]}},productServers:[]} as unknown as CloudProviderExecution;
      const policy=cloudClaudeTools(execution),options=path.join(root,"options.json");
      await writeFile(options,JSON.stringify(policy));
      const probe=fileURLToPath(new URL("./native-policy-probe.mjs",import.meta.url));
      const result=await promisify(execFile)("unshare",["--user","--map-root-user","--net","python3","-c",loopback,process.execPath,probe,root,options,kind],{timeout:20000,maxBuffer:64*1024});
      const observed=JSON.parse(result.stdout);
      expect(observed).toMatchObject({claude:true,agents:true,init:true,admittedKey:true,admittedModel:true,trap:false,helper:false,plan:true});
      expect(observed.requests).toBeGreaterThan(0);
    }finally{await rm(root,{recursive:true,force:true});}
  },25000);
  it.each(["mcp","mcp-strict-plugin","mcp-control"])("checks real native MCP launch markers (%s)",async mode=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-claude-native-mcp-"));
    try{
      await mkdir(path.join(root,"home/.claude"),{recursive:true});await mkdir(path.join(root,"project/.claude"),{recursive:true});
      const marker=path.join(root,"admitted-marker");
      const program="require('node:fs').appendFileSync(process.argv[1],'started\\n');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{},serverInfo:{name:'fixture',version:'1'}}:{tools:[],resources:[],prompts:[]}})+'\\n')})";
      const execution={cwd:path.join(root,"project"),lease:{assertLive:vi.fn(),customization:{servers:[],skills:[]}},productServers:[],userServers:[{name:"admitted",transport:"stdio",command:process.execPath,args:["-e",program,marker]}]} as unknown as CloudProviderExecution;
      const options=path.join(root,"options.json");await writeFile(options,JSON.stringify(cloudClaudeTools(execution)));
      const probe=fileURLToPath(new URL("./native-policy-probe.mjs",import.meta.url));
      const result=await promisify(execFile)("unshare",["--user","--map-root-user","--net","python3","-c",loopback,process.execPath,probe,root,options,"setup",mode],{timeout:30000,maxBuffer:64*1024});
      const observed=JSON.parse(result.stdout);
      expect(observed).toMatchObject({launches:3,resumed:true});expect(observed.admittedStarts).toBeGreaterThanOrEqual(3);
      if(mode!=="mcp-control")expect(observed).toMatchObject({excludedStarts:0,reload:true});
      else for(const name of ["project","user","plugin"])expect(observed.markerTypes[name],name).toBeGreaterThan(0);
    }finally{await rm(root,{recursive:true,force:true});}
  },35000);
});
