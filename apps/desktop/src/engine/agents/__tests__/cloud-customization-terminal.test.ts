import {expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({execution:null as any}));
vi.mock('../cloud-provider-execution',async original=>({...await original<any>(),cloudProviderExecution:()=>state.execution}));
import {CloudCustomizationRedactor} from '../cloud-customization-redaction';
import {AgentGateway} from '../gateway';

const legacyExecution=(provider:'claude'|'codex',redactor:CloudCustomizationRedactor)=>{
 const lease={signal:new AbortController().signal,admission:{provider},validate:vi.fn(async()=>{}),close:vi.fn(async()=>{})};
 return {mode:'actor-grant-v1' as const,provider,lease,lifetime:lease,redactor};
};

it('preserves schema-owned ToolCallLocation keys for common MCP values',()=>{
 const r=new CloudCustomizationRedactor(['path','line']);
 const n=r.notification({sessionId:'s',update:{sessionUpdate:'tool_call_update',toolCallId:'t',status:'completed',locations:[{path:'/workspace/file.ts',line:7}]}});
 expect(n.update).toHaveProperty('locations',[{path:'/workspace/file.ts',line:7}]);
});
it('preserves nested command field names and identities while filtering content values',()=>{
 const r=new CloudCustomizationRedactor(['path','line','hint','command']);
 const n=r.notification({sessionId:'s',update:{sessionUpdate:'available_commands_update',availableCommands:[{name:'command',kind:'command',description:'Run command',input:{hint:'Enter path'}}]}});
 expect(n.update).toHaveProperty('availableCommands',[{name:'command',kind:'command',description:'Run [redacted]',input:{hint:'Enter [redacted]'}}]);
 const tool=r.notification({sessionId:'s',update:{sessionUpdate:'tool_call_update',toolCallId:'path',locations:[{path:'/workspace/path/file.ts',line:7}]}});
 expect(tool.update).toMatchObject({toolCallId:'path',locations:[{path:'/workspace/[redacted]/file.ts',line:7}]});
});
it('withholds a truncated literal in terminal error notices',()=>{
 const secret='v7b-synthetic-opaque-private-value',prefix=secret.slice(0,-1),r=new CloudCustomizationRedactor([secret]);
 const n=r.notification({sessionId:'s',update:{sessionUpdate:'error_notice',message:'MCP exited: '+prefix}} as any);
 expect(JSON.stringify(n)).not.toContain(prefix);
});
it('withholds a truncated literal in rejected provider errors and diagnostic tails',()=>{
 const secret='v7b-synthetic-opaque-private-value',prefix=secret.slice(0,-1),r=new CloudCustomizationRedactor([secret]);
 const e=Object.assign(new Error('MCP exited: '+prefix),{failure:{kind:'protocol-error',stage:'prompt',message:'MCP exited: '+prefix,exit:{stderrTail:prefix,code:1,signal:null}}});
 const output=r.error(e) as typeof e;
 expect(output.message+' '+JSON.stringify(output.failure)+' '+output.stack).not.toContain(prefix);
});
it('filters raw stderr boot failures before the stack newline and through nested causes',()=>{
 const secret='v7b-synthetic-opaque-private-value',prefix=secret.slice(0,-1),r=new CloudCustomizationRedactor([secret]);
 const cause=new Error('child exited: '+prefix);
 const error=Object.assign(new Error('codex app-server boot failed at initialize: EOF\nstderr tail:\n'+prefix,{cause}),{failure:{kind:'protocol-error',stage:'initialize',message:'child exited: '+prefix,advice:'diagnostic: '+prefix,exit:{code:1,signal:null,stderrTail:prefix}}});
 const output=r.error(error) as typeof error;
 expect(output).toBeInstanceOf(Error);
 expect(output.failure).toMatchObject({kind:'protocol-error',stage:'initialize',exit:{code:1,signal:null}});
 expect([output.message,output.stack,(output.cause as Error).message,(output.cause as Error).stack,JSON.stringify(output.failure)].join('\n')).not.toContain(prefix);
 expect(output.stack).toContain('at ');
});
it.each(['end_turn','cancelled','failure'])('public prompt completion retains assistant text and safely finishes pending suffix (%s)',async ending=>{
 const secret='v7b-synthetic-opaque-private-value';
 const events={onSessionUpdate:vi.fn(),onPermissionRequest:vi.fn(),onQuestionRequest:vi.fn(),onAgentStderr:vi.fn(),onAgentExit:vi.fn()};
 const gateway=new AgentGateway({projectRoot:'/tmp',events,cloudAgentExecutionFactory:{prepare:vi.fn()}}),g=gateway as any;
 state.execution=legacyExecution('codex',new CloudCustomizationRedactor([secret]));
 g.executionBoundaries.set('s',{});
 g.adapterForSession=()=>({agentId:'codex',prompt:vi.fn(async()=>{
  for(const text of ['Complete ordinary answer. v7b-','synthetic-','opaque-private-value','! Last ',secret.slice(0,-1)])
   g.events.onSessionUpdate('codex',{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',messageId:'m',content:{type:'text',text}}});
  if(ending==='failure')throw new Error('safe failure');
  return {stopReason:ending};
 })});
 try{
  let failure:any=null;await gateway.prompt('codex','s',[{type:'text',text:'Hello'}]).catch(e=>{failure=e;});
  if(ending==='failure')expect(failure).toMatchObject({code:'cloud_provider_prompt_rejected',failure:{kind:'protocol-error',stage:'prompt',message:expect.stringContaining('Review the conversation')}});else expect(failure).toBeNull();
  const text=events.onSessionUpdate.mock.calls.map(([,n])=>n.update.content.text).join('');
  expect(text).toBe('Complete ordinary answer. [redacted]! Last [redacted]');
  expect(events.onSessionUpdate.mock.calls.every(([,n])=>n.sessionId==='s'&&n.update.messageId==='m')).toBe(true);
 }finally{state.execution=null;g.executionBoundaries.clear();}
});

it('public gateway rejects with a scrubbed truncated provider diagnostic',async()=>{
 const secret='v7b-synthetic-opaque-private-value',prefix=secret.slice(0,-1);
 const events={onSessionUpdate:vi.fn(),onPermissionRequest:vi.fn(),onQuestionRequest:vi.fn(),onAgentStderr:vi.fn(),onAgentExit:vi.fn()};
 const gateway=new AgentGateway({projectRoot:'/tmp',events,cloudAgentExecutionFactory:{prepare:vi.fn()}}),g=gateway as any;
 state.execution=legacyExecution('codex',new CloudCustomizationRedactor([secret]));g.executionBoundaries.set('s',{});
 g.adapterForSession=()=>({agentId:'codex',prompt:vi.fn(async()=>{throw new Error('MCP exited: '+prefix);})});
 try{const error=await gateway.prompt('codex','s',[{type:'text',text:'Hello'}]).catch(e=>e);expect(error).toMatchObject({code:'cloud_provider_prompt_rejected',failure:{kind:'protocol-error',stage:'prompt',message:expect.stringContaining('Review the conversation')}});expect([error.message,error.stack,JSON.stringify(error.failure)].join('\n')).not.toContain(prefix);}finally{state.execution=null;g.executionBoundaries.clear();}
});

it('public gateway retries interrupted owner changes without resuming the prior owner binding',async()=>{
 const {mkdtemp,writeFile,rm,realpath}=await import('node:fs/promises');
 const {randomBytes,randomUUID}=await import('node:crypto');
 const {acquireCloudNativeHistory}=await import('../containment/cloud-native-history');
 const {testExecutionBoundary}=await import('./helpers/test-execution-boundary');
 const root=await realpath(await mkdtemp('/tmp/v7b-reset-gateway-')),historyRoot=root+'/history';
 const authority={owner:'a'.repeat(64),currentKeyVersion:1,keys:{'1':randomBytes(32).toString('base64url')}};
 const input={root:historyRoot,conversationId:'c',provider:'claude' as const,uid:process.getuid!(),gid:process.getgid!()};
 const first=await acquireCloudNativeHistory({...input,customization:{authority,secrets:[]}});
 await writeFile(first.mount.directory+'/provider-history','old owner history');await first.release();
 const nextAuthority={...authority,owner:'b'.repeat(64)};
 const changed=await acquireCloudNativeHistory({...input,customization:{authority:nextAuthority,secrets:[]}});await changed.release();
 const retry=await acquireCloudNativeHistory({...input,customization:{authority:nextAuthority,secrets:[]}});
 const workload=testExecutionBoundary(),events={onSessionUpdate:vi.fn(),onPermissionRequest:vi.fn(),onQuestionRequest:vi.fn(),onAgentStderr:vi.fn(),onAgentExit:vi.fn()};
 const factory={prepare:vi.fn(async(i:any)=>({boundary:i.workload,env:{},authorityId:'a'.repeat(64)}))};
 const gateway=new AgentGateway({projectRoot:root,executionBoundary:{...workload,backend:'cloud-worker'},events,cloudAgentExecutionFactory:factory} as any);
 const prior={version:1 as const,kind:'native' as const,providerId:'claude',resumeId:'prior-owner-native-binding'};
 const adapter={agentId:'claude',newSession:vi.fn(async(_input:unknown)=>({session:{providerBinding:{...prior,resumeId:'fresh-binding'}},initialize:{}})),loadSession:vi.fn(async()=>({providerBinding:prior})),disposeSession:vi.fn(async()=>{}),dispose:vi.fn(async()=>{})};
 (gateway as any).adapters.set('claude',adapter);
 try{
  const redactor=retry.redactor;
  if(!(redactor instanceof CloudCustomizationRedactor))throw new Error('The customization history fixture must provide its redactor');
  state.execution={...legacyExecution('claude',redactor),coordinator:{requiresFreshHistory:retry.fresh}};
  await gateway.loadSession('claude',prior,{cwd:root,conversationId:'c',cloudExecution:{delegationId:randomUUID(),model:'test-model',source:{kind:'session',actorSessionId:randomUUID()}}});
  expect(adapter.loadSession).not.toHaveBeenCalled();expect(adapter.newSession).toHaveBeenCalledOnce();
  expect(adapter.newSession.mock.calls[0]?.[0]).not.toHaveProperty('providerBinding');
  expect(adapter.newSession.mock.calls[0]?.[0]).not.toHaveProperty('sessionId');
 }finally{state.execution=null;await gateway.dispose();await retry.release();await rm(root,{recursive:true,force:true});}
});
