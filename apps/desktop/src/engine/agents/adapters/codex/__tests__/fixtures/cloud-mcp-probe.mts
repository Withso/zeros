import { spawn, execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import Module, { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { testCloudRuntime } from '../../../../__tests__/helpers/test-cloud-runtime';
import type { McpServerRegistration } from '../../../../types';
import type { CloudProviderExecution } from '../../../../cloud-provider-execution';

// This subprocess exercises the pinned CLI/MCP contract without an installed
// host runtime. Inject the same explicit v4 authority as the consumer tests.
const runtimeFile = fileURLToPath(new URL('../../../../containment/cloud-runtime-root.mjs', import.meta.url));
// CI links installed packages from a pnpm store on the same filesystem, and the
// v4 image check correctly refuses a hard-linked executable. Runtime bundles
// copy files, so mirror the resolver's pinned package tree into a private
// worker root with an unlinked copy of the native executable.
async function imageRoot(): Promise<string> {
  const repo = realpathSync(process.cwd());
  const wrapper = realpathSync(createRequire(path.join(repo, 'package.json')).resolve('@openai/codex/package.json'));
  const platform = realpathSync(createRequire(wrapper).resolve(`@openai/codex-linux-${process.arch}/package.json`));
  const vendor = path.join(path.dirname(platform), 'vendor');
  const [triple] = await readdir(vendor);
  const native = path.join(vendor, triple!, 'bin', 'codex');
  if ((await stat(native)).nlink === 1) return repo;
  const image = realpathSync(await mkdtemp('/tmp/zeros-codex-image-'));
  const target = path.join(image, `node_modules/@openai/codex-linux-${process.arch}`);
  const bin = path.join(target, 'vendor', triple!, 'bin');
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(image, 'node_modules/@openai/codex'), { recursive: true });
  const pin = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')).dependencies['@openai/codex'];
  await writeFile(path.join(image, 'package.json'), JSON.stringify({ dependencies: { '@openai/codex': pin } }));
  await copyFile(wrapper, path.join(image, 'node_modules/@openai/codex/package.json'));
  await copyFile(platform, path.join(target, 'package.json'));
  await copyFile(native, path.join(bin, 'codex'));
  await chmod(path.join(bin, 'codex'), 0o755);
  for (const entry of await readdir(path.join(vendor, triple!)))
    if (entry !== 'bin') await symlink(path.join(vendor, triple!, entry), path.join(target, 'vendor', triple!, entry));
  for (const entry of await readdir(path.dirname(native)))
    if (entry !== 'codex') await symlink(path.join(path.dirname(native), entry), path.join(bin, entry));
  return image;
}
const workerRoot = await imageRoot();
const runtime = { ...testCloudRuntime(), workerRoot };
// tsx loads this source tree through CommonJS. Replace only runtime authority
// in this disposable subprocess, retaining the real CLI/package pin checks.
const require = createRequire(import.meta.url);
const authority = new Module(runtimeFile);
authority.filename = runtimeFile;
authority.loaded = true;
authority.exports = { ...require(runtimeFile), resolveCloudRuntime: () => runtime,
  resolveCloudRuntimePackagePath: (file: string) => realpathSync(file) };
require.cache[runtimeFile] = authority;
const { buildMcpServerOverrides } = await import('../../app-server');
const { cloudCodexRequest } = await import('../../cloud-policy');
const { resolveCloudCodexBinaryFromImage } = await import('../../binary-resolver');
const {path:binary}=await resolveCloudCodexBinaryFromImage(workerRoot);
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
}finally{
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  if(workerRoot!==realpathSync(process.cwd()))await rm(workerRoot,{recursive:true,force:true});
}
