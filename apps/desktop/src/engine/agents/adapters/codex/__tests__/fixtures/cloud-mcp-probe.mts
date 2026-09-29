import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { buildMcpServerOverrides } from '../../app-server';
import { cloudCodexRequest } from '../../cloud-policy';
import type { McpServerRegistration } from '../../../../types';
import type { CloudProviderExecution } from '../../../../cloud-provider-execution';

const binary=path.resolve('node_modules/.pnpm/@openai+codex@0.154.0-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex');
const root=await mkdtemp('/tmp/v7-native-codex-');
const cwd=path.join(root,'repo'), home=path.join(root,'home');
await mkdir(path.join(cwd,'.codex'),{recursive:true});
await mkdir(path.join(home,'.codex'),{recursive:true});
execFileSync('git',['init','-q',cwd]);
await writeFile(path.join(home,'.codex/config.toml'),`[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);

async function probe(label:string,repoConfig:string,servers:McpServerRegistration[],mutate?:()=>Promise<void>){
  await writeFile(path.join(cwd,'.codex/config.toml'),repoConfig);
  const child=spawn(binary,['app-server',...buildMcpServerOverrides(servers.map(server => server.transport === "stdio" ? {...server, startupTimeoutSec: 1} : server),{cloudCwd:cwd})],{cwd,env:{HOME:home,CODEX_HOME:path.join(home,'.codex'),PATH:process.env.PATH!,RUST_LOG:'off'},stdio:['pipe','pipe','pipe'],detached:true});
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  let stderr=''; let id=0;
  const pending=new Map<number,{resolve:(v:unknown)=>void,reject:(e:Error)=>void}>();
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{ try {const v=JSON.parse(line) as {id?:number; error?:{message:string}; result?:unknown}; if(v.id && pending.has(v.id)){const p=pending.get(v.id)!; pending.delete(v.id); if(v.error) p.reject(new Error(v.error.message)); else p.resolve(v.result);}}catch{ /* Ignore non-JSON diagnostic lines. */ } });
  child.stderr.on('data',data=>{stderr+=data;});
  child.on('exit',()=>{for(const p of pending.values())p.reject(new Error('Codex exited: '+stderr));pending.clear();});
  const request=<T=unknown,>(method:string,params:unknown)=>new Promise<T>((resolve,reject)=>{const current=++id;pending.set(current,{resolve:value=>resolve(value as T),reject});child.stdin.write(JSON.stringify({id:current,method,params})+'\n');});
  const bounded=<T,>(p:Promise<T>)=>Promise.race([p,new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(new Error('Timed out: '+stderr)),15000);t.unref();})]);
  try {
    await bounded(request('initialize',{clientInfo:{name:'zeros-cloud-mcp-fixture',version:'1'},capabilities:{experimentalApi:true}}));
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const initial=await bounded(request<{config:{mcp_servers:unknown}}>('config/read',{cwd,includeLayers:false}));
    if(mutate)await mutate();
    const execution={lease:{assertLive(){},admission:{model:'gpt-5.6-sol'}},productServers:[],userServers:servers} as unknown as CloudProviderExecution;
    const params=cloudCodexRequest(execution,'test','thread/start',{sandbox:'read-only',approvalPolicy:'never'}) as Record<string,unknown>;
    // Change only this disposable probe's filesystem routing, never an MCP field.
    params.cwd=cwd; delete params.environments; params.runtimeWorkspaceRoots=[cwd]; params.ephemeral=true;
    try {
      const result=await bounded(request<{thread:{id:string}}>('thread/start',params));
      const status=await bounded(request('mcpServerStatus/list',{threadId:result.thread.id,detail:'full'}));
      const launched=await readFile(path.join(cwd,'late-launched'),'utf8').catch(()=>null);
      const inherited=await readFile(path.join(cwd,'inherited-env'),'utf8').catch(()=>null);
      console.log(JSON.stringify({label,initial:initial.config.mcp_servers,threadStarted:true,thread:!!result.thread,status,launched,inherited}));
    }catch(error){console.log(JSON.stringify({label,initial:initial.config.mcp_servers,threadStarted:false,error:String(error)}));}
  } catch(error){console.log(JSON.stringify({label,error:String(error)}));}
  finally{if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{ /* Already exited. */ } await exited;lines.close();}
}

try {
  await probe('transport replacement', '[mcp_servers.example]\nurl="http://127.0.0.1:9/mcp"\n', [{name:'example',transport:'stdio',command:'node',args:['-e','process.exit(0)']}]);
  await probe('lower layer environment inheritance', '[mcp_servers.example]\ncommand="node"\nstartup_timeout_sec=1\n[mcp_servers.example.env]\nLOWER_LAYER="v7-synthetic-lower-layer-secret"\n', [{name:'example',transport:'stdio',command:'node',args:['-e',
    "require('fs').writeFileSync('inherited-env',process.env.LOWER_LAYER||'absent');require('readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}}:r.method==='tools/list'?{tools:[]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');})"]}]);
  await probe('empty snapshot then repository edit', '', [],async()=>{await writeFile(path.join(cwd,'.codex/config.toml'),'[mcp_servers.late]\ncommand="node"\nargs=["-e","require(\'fs\').writeFileSync(\'late-launched\',\'yes\');process.stdin.resume()"]\nstartup_timeout_sec=1\n');});
}finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
