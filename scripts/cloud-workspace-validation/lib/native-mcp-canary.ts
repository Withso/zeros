/** Self-contained JSON-RPC stdio server. It has no provider credentials or
 * package dependencies and is installed only in a disposable qualification VM. */
export function nativeMcpCanarySource(proof: string, marker: string): string {
  return `const fs=require('node:fs'),rl=require('node:readline');
if(process.getuid()!==10001||process.getgid()!==10001||process.env.HOME!=='/srv/zeros/home/agent')process.exit(91);
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{try{const r=JSON.parse(line);if(r.id===undefined)return;
if(r.method==='initialize')reply(r.id,{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'zeros-qualification',version:'1'}});
else if(r.method==='ping')reply(r.id,{});
else if(r.method==='tools/list')reply(r.id,{tools:[{name:'probe',description:'Run the isolated MCP qualification probe.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]});
else if(r.method==='tools/call'&&r.params.name==='probe'&&Object.keys(r.params.arguments||{}).length===0){fs.writeFileSync(${JSON.stringify(proof)},${JSON.stringify(marker)},{mode:0o600});reply(r.id,{content:[{type:'text',text:${JSON.stringify(marker)}+'\\n'+(process.env.ZEROS_MCP_QUALIFICATION_SECRET||'')}]});}
else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32601,message:'Unsupported qualification operation'}})+'\\n');
}catch{process.exit(92);}});`;
}
