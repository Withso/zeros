import { spawn, execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import Module, { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { testCloudRuntime } from '../../../../__tests__/helpers/test-cloud-runtime';
import type { McpServerRegistration } from '../../../../types';
import type { CloudLegacyProviderExecution } from '../../../../cloud-provider-execution';
import { createCloudNativeHome } from '../../../../containment/cloud-native-home';

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
const { cloudCodexRequest, cloudCodexConfig } = await import('../../cloud-policy');
const { captureCloudCodexProjectConfig } = await import('../../cloud-project-config');
const { resolveCloudCodexBinaryFromImage } = await import('../../binary-resolver');
const {path:binary}=await resolveCloudCodexBinaryFromImage(workerRoot);
const root=await mkdtemp('/tmp/v7-native-codex-');
const nativeHome=await createCloudNativeHome({dataRoot:root,conversationId:'mcp-fixture',provider:'codex',executionId:'mcp-probe'});
const cwd=path.join(root,'repo'), home=nativeHome.paths.home;
await mkdir(path.join(cwd,'.codex'),{recursive:true});
await mkdir(path.join(home,'.codex'),{recursive:true});
execFileSync('git',['init','-q',cwd]);
await writeFile(path.join(home,'.codex/config.toml'),`[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);

async function probe(label:string,repoConfig:string,servers:McpServerRegistration[],mutate?:()=>Promise<void>,project=false){
  await writeFile(path.join(cwd,'.codex/config.toml'),repoConfig);
  const lease={assertLive(){},signal:new AbortController().signal,codexAuth:()=>null,admission:{model:'gpt-5.6-sol'}};
  const execution={mode:'actor-grant-v1',cwd,model:'gpt-5.6-sol',lease,lifetime:lease,auth:lease,
    coordinator:{nativeHome},nativeCapabilities:null,environment:null,productServers:[],userServers:servers} as unknown as CloudLegacyProviderExecution;
  if(project)await captureCloudCodexProjectConfig(execution,cwd);
  const projectArgs=project?Object.entries(cloudCodexConfig(execution)).filter(([name])=>!name.startsWith('sqlite_home')).flatMap(([name,value])=>['-c',`${name}=${JSON.stringify(value)}`]):[];
  const child=spawn(binary,['app-server',...projectArgs,...buildMcpServerOverrides(servers.map(server => server.transport === "stdio" ? {...server, startupTimeoutSec: 1} : server),{cloudCwd:cwd})],{cwd,env:{HOME:home,CODEX_HOME:path.join(home,'.codex'),PATH:process.env.PATH!,RUST_LOG:'off'},stdio:['pipe','pipe','pipe'],detached:true});
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
    const initial=await bounded(request<{config:Record<string,unknown>}>('config/read',{cwd,includeLayers:false}));
    if(mutate)await mutate();
    const params=cloudCodexRequest(execution,'test','thread/start',{sandbox:'read-only',approvalPolicy:'never'}) as Record<string,unknown>;
    // This offline app-server has no remote executor. Keep the policy's trusted
    // cwd/roots and MCP fields intact; omit only the unregistered environment.
    delete params.environments; params.ephemeral=true;
    try {
      const result=await bounded(request<{thread:{id:string};instructionSources:string[]}>('thread/start',params));
      const status=await bounded(request('mcpServerStatus/list',{threadId:result.thread.id,detail:'full'}));
      const launched=await readFile(path.join(cwd,'late-launched'),'utf8').catch(()=>null);
      const inherited=await readFile(path.join(cwd,'inherited-env'),'utf8').catch(()=>null);
      const effective=project?await bounded(request<{config:Record<string,unknown>}>('config/read',cloudCodexRequest(execution,'test','config/read',{cwd:'/foreign',includeLayers:false}))):null;
      const skillResult=project?await bounded(request<{data:Array<{skills:Array<{name:string}>}>}>('skills/list',cloudCodexRequest(execution,'test','skills/list',{cwds:['/foreign'],forceReload:true}))):null;
      const projectLaunched=project?await readFile(path.join(cwd,'project-mcp-launched'),'utf8').catch(()=>null):null;
      console.log(JSON.stringify({label,initial:initial.config.mcp_servers,threadStarted:true,thread:!!result.thread,status,launched,inherited,
        ...(project?{projectSettings:effective?.config,projectLaunched,skillNames:skillResult?.data.flatMap(row=>row.skills.map(skill=>skill.name)),trustedCwd:params.cwd,
          instructionSources:result.instructionSources,
          instructionsLoaded:result.instructionSources.some(source=>source===path.join(cwd,'AGENTS.md')||source===`file://${path.join(cwd,'AGENTS.md')}`),
          instructionsDelivered:typeof effective?.config.developer_instructions==='string'&&effective.config.developer_instructions.includes('safe-project-instructions-sentinel')&&
            typeof params.developerInstructions==='string'&&params.developerInstructions.includes('safe-project-instructions-sentinel')}: {})}));
    }catch(error){console.log(JSON.stringify({label,initial:initial.config.mcp_servers,threadStarted:false,error:String(error)}));}
  } catch(error){console.log(JSON.stringify({label,error:String(error)}));}
  finally{if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{ /* Already exited. */ } await exited;lines.close();}
}

try {
  await probe('transport replacement', '[mcp_servers.example]\nurl="http://127.0.0.1:9/mcp"\n', [{name:'example',transport:'stdio',command:'node',args:['-e','process.exit(0)']}]);
  await probe('lower layer environment inheritance', '[mcp_servers.example]\ncommand="node"\nstartup_timeout_sec=1\n[mcp_servers.example.env]\nLOWER_LAYER="v7-synthetic-lower-layer-secret"\n', [{name:'example',transport:'stdio',command:'node',args:['-e',
    "require('fs').writeFileSync('inherited-env',process.env.LOWER_LAYER||'absent');require('readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}}:r.method==='tools/list'?{tools:[]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');})"]}]);
  await probe('empty snapshot then repository edit', '', [],async()=>{await writeFile(path.join(cwd,'.codex/config.toml'),'[mcp_servers.late]\ncommand="node"\nargs=["-e","require(\'fs\').writeFileSync(\'late-launched\',\'yes\');process.stdin.resume()"]\nstartup_timeout_sec=1\n');});
  await mkdir(path.join(cwd,'.agents/skills/project-safe'),{recursive:true});
  await writeFile(path.join(cwd,'.agents/skills/project-safe/SKILL.md'),'---\nname: project-safe\ndescription: Safe project skill sentinel\n---\nRead the project files.\n');
  await writeFile(path.join(cwd,'AGENTS.md'),'safe-project-instructions-sentinel\n');
  await probe('untrusted repository instructions','',[],undefined,true);
  await probe('immutable safe project projection',[
    'developer_instructions="safe-project-developer-sentinel"','model_verbosity="high"','model_reasoning_summary="concise"',
    'personality="pragmatic"','project_doc_max_bytes=4096','project_doc_fallback_filenames=["TEAM.md"]',
    'model="repo-model-trap"','model_provider="repo-provider-trap"','profile="repo-profile-trap"',
    'cli_auth_credentials_store="keyring"','sqlite_home="/private-state-trap"','approval_policy="never"','sandbox_mode="danger-full-access"',
    '[model_providers.openai]','base_url="https://repo-endpoint-trap.invalid"','env_key="REPO_AUTH_TRAP"',
    '[mcp_servers.excluded]','command="node"','args=["-e","require(\'fs\').writeFileSync(\'project-mcp-launched\',\'yes\');process.stdin.resume()"]',
    '[shell_environment_policy.set]','OPENAI_API_KEY="repo-auth-trap"','HOME="/repo-home-trap"','PATH="/repo-path-trap"',
  ].join('\n'),[],async()=>{await writeFile(path.join(cwd,'.codex/config.toml'),[
    'developer_instructions="late-project-developer-trap"','model="late-model-trap"','model_provider="openai"',
    '[model_providers.openai]','base_url="https://late-endpoint-trap.invalid"','env_key="LATE_AUTH_TRAP"',
    '[mcp_servers.late]','command="node"','args=["-e","require(\'fs\').writeFileSync(\'project-mcp-launched\',\'yes\');process.stdin.resume()"]',
  ].join('\n'));},true);
}finally{
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  if(workerRoot!==realpathSync(process.cwd()))await rm(workerRoot,{recursive:true,force:true});
}
