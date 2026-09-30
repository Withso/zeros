import { constants } from "node:fs";
import { open, realpath, readlink } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { CloudRepositoryMcpSchema, type CloudMcpServer } from "@zeros/protocol/cloud-customization";

export const cloudMcpDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value,
  (key, entry) => (key === "env" || key === "headers") && entry ? Object.keys(entry).sort() : entry)).digest("hex");
export function freezeCloudSnapshot<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeCloudSnapshot(child); Object.freeze(value); }
  return value;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Fixed checkout sources only. Never call the Local adopt scanner: it also
 * reads HOME, plugin caches and native account configuration. */
export async function readCloudRepositoryMcp(cwd: string): Promise<CloudMcpServer[]> {
  const root = await realpath(cwd), servers = new Map<string, CloudMcpServer>();
  for (const file of [".codex/config.toml", ".cursor/mcp.json", ".mcp.json"]) {
    let handle;
    try {
      handle = await open(path.join(root, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const actual = await readlink(`/proc/self/fd/${handle.fd}`), stat = await handle.stat();
      if (!actual.startsWith(root + path.sep) || !stat.isFile() || stat.size > 64 * 1024) throw new Error();
      const bytes = Buffer.alloc(64 * 1024 + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 64 * 1024) throw new Error();
      const source = bytes.subarray(0, bytesRead).toString("utf8");
      const document = object(file.endsWith(".toml") ? parseToml(source) : JSON.parse(source));
      const map = object(file.endsWith(".toml") ? document.mcp_servers : document.mcpServers);
      if (Object.keys(map).length > 32) throw new Error();
      for (const [name, raw] of Object.entries(map)) {
        const config = object(raw);
        if (config.enabled === false || config.disabled === true) continue;
        if (["oauth", "auth", "env_vars", "env_http_headers", "bearer_token_env_var", "headersFromEnv"].some(key => config[key] !== undefined))
          throw new Error();
        const transport = config.type ?? config.transport ?? (config.url ? "http" : "stdio");
        const candidate = transport === "stdio" ? { name, transport, command: config.command,
          ...(config.args !== undefined ? { args: config.args } : {}), ...(config.env !== undefined ? { env: config.env } : {}),
          ...(config.cwd !== undefined ? { cwd: "/srv/zeros/workspace/" + path.relative(root, path.resolve(root, String(config.cwd))) } : {}) } :
          { name, transport, url: config.url, ...((config.headers ?? config.http_headers) !== undefined ? { headers: config.headers ?? config.http_headers } : {}) };
        const parsed = CloudRepositoryMcpSchema.parse([candidate])[0]!;
        servers.set(name, parsed);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid repository MCP configuration. OAuth and implicit environment imports are unsupported in cloud workspaces.");
    } finally { await handle?.close(); }
  }
  return CloudRepositoryMcpSchema.parse([...servers.values()].sort((a, b) => a.name.localeCompare(b.name)));
}

// Codex's native MCP transport accepts stdio and streamable HTTP, not legacy
// SSE. This small relay runs as its child inside the same execution boundary.
// Values arrive through the private child environment, never through argv.
const sseRelay = `const rl=require('node:readline');
const headers=JSON.parse(process.env.ZEROS_MCP_SSE_HEADERS||'{}'),url=process.env.ZEROS_MCP_SSE_URL;
let endpoint,resolveEndpoint;const ready=new Promise(r=>resolveEndpoint=r);
const lines=rl.createInterface({input:process.stdin});let tail=Promise.resolve();
lines.on('line',line=>{tail=tail.then(async()=>{await ready;const r=await fetch(endpoint,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:line,redirect:'error'});if(!r.ok)throw Error();}).catch(()=>process.exit(1));});
lines.on('close',()=>process.exit(0));
(async()=>{const r=await fetch(url,{headers:{...headers,Accept:'text/event-stream'},redirect:'error'});if(!r.ok||!r.body)throw Error();
let buffer='',event='',data='';const decoder=new TextDecoder();
for await(const bytes of r.body){buffer+=decoder.decode(bytes,{stream:true});if(buffer.length>1048576)throw Error();let i;
while((i=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,i).replace(/\\r$/,'');buffer=buffer.slice(i+1);
if(line.startsWith('event:'))event=line.slice(6).trim();else if(line.startsWith('data:'))data+=line.slice(5).trimStart()+'\\n';
else if(line===''){if(event==='endpoint'){if(endpoint)throw Error();endpoint=new URL(data.trim(),url);if(endpoint.origin!==new URL(url).origin)throw Error();resolveEndpoint();}
else if((event==='message'||event==='')&&data){const message=JSON.parse(data);process.stdout.write(JSON.stringify(message)+'\\n');}event='';data='';}if(data.length>1048576)throw Error();}}
process.exit(1);})().catch(()=>process.exit(1));`;
export function cloudCodexMcpServer(server: CloudMcpServer): CloudMcpServer {
  return server.transport === "sse" ? { name: server.name, transport: "stdio", command: "node", args: ["-e", sseRelay],
    env: { ZEROS_MCP_SSE_URL: server.url, ZEROS_MCP_SSE_HEADERS: JSON.stringify(server.headers ?? {}) } } : server;
}
