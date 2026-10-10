import { constants } from "node:fs";
import { open, realpath, readlink } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { CloudMcpServerSchema, CloudRepositoryMcpSchema, type CloudMcpServer } from "@zeros/protocol/cloud-customization";
import type { CloudAgentExecutionAdmission } from "@zeros/protocol/cloud-agent-execution";

export const cloudMcpDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value,
  (key, entry) => (key === "env" || key === "headers") && entry ? Object.keys(entry).sort() : entry)).digest("hex");
export function freezeCloudSnapshot<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeCloudSnapshot(child); Object.freeze(value); }
  return value;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const repositoryMcpFiles = { claude: ".mcp.json", codex: ".codex/config.toml", cursor: ".cursor/mcp.json" } as const;
export type CloudRepositoryMcpDiagnostic = {
  file: typeof repositoryMcpFiles[keyof typeof repositoryMcpFiles];
  /** Present only for a schema-validated id; never excerpt an invalid name. */
  server?: string;
  reason: "unsafe_file" | "file_unreadable" | "file_too_large" | "file_malformed" | "unsupported_auth" | "invalid_entry" | "server_limit";
};
export type CloudRepositoryMcpNotice = { excluded: number; omitted: number; diagnostics: readonly CloudRepositoryMcpDiagnostic[] };
/** Fixed checkout sources only. Never call the Local adopt scanner: it also
 * reads HOME, plugin caches and native account configuration. Optional repo
 * configuration cannot reject authority admission. Only accepted entries are
 * echoed/digested by the control plane; diagnostics never contain file data. */
export async function readCloudRepositoryMcp(cwd: string, provider: CloudAgentExecutionAdmission["provider"],
  report?: (notice: CloudRepositoryMcpNotice) => void): Promise<CloudMcpServer[]> {
  const root = await realpath(cwd), servers = new Map<string, CloudMcpServer>();
  const file = repositoryMcpFiles[provider], diagnostics: CloudRepositoryMcpDiagnostic[] = [];
  let excluded = 0;
  const exclude = (reason: CloudRepositoryMcpDiagnostic["reason"], name?: string) => {
    excluded++;
    if (diagnostics.length >= 16) return;
    const safeId = name !== undefined && CloudMcpServerSchema.safeParse({ name, transport: "stdio", command: "node" }).success;
    diagnostics.push({ file, ...(safeId ? { server: name } : {}), reason });
  };
  {
    let handle;
    let fileFailure: CloudRepositoryMcpDiagnostic["reason"] = "file_unreadable";
    try {
      handle = await open(path.join(root, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const actual = await readlink(`/proc/self/fd/${handle.fd}`), stat = await handle.stat();
      fileFailure = "unsafe_file";
      if (!actual.startsWith(root + path.sep) || !stat.isFile()) throw new Error();
      fileFailure = "file_too_large";
      if (stat.size > 64 * 1024) throw new Error();
      fileFailure = "file_unreadable";
      const bytes = Buffer.alloc(64 * 1024 + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 64 * 1024) { fileFailure="file_too_large";throw new Error(); }
      fileFailure = "file_malformed";
      const source = new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,bytesRead));
      const parsedDocument: unknown = file.endsWith(".toml") ? parseToml(source) : JSON.parse(source);
      if (!parsedDocument || typeof parsedDocument !== "object" || Array.isArray(parsedDocument)) throw new Error();
      const document = object(parsedDocument), rawMap = file.endsWith(".toml") ? document.mcp_servers : document.mcpServers;
      if (rawMap !== undefined && (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap))) throw new Error();
      const map = object(rawMap);
      for (const [name, raw] of Object.entries(map).sort(([a], [b]) => a.localeCompare(b))) {
        const config = object(raw);
        if (config.enabled === false || config.disabled === true) continue;
        if (["oauth", "auth", "env_vars", "env_http_headers", "bearer_token_env_var", "headersFromEnv"].some(key => config[key] !== undefined)) {
          exclude("unsupported_auth", name); continue;
        }
        if (config.cwd !== undefined && typeof config.cwd !== "string") { exclude("invalid_entry", name); continue; }
        const transport = config.type ?? config.transport ?? (config.url ? "http" : "stdio");
        const relativeCwd = config.cwd === undefined ? undefined : path.relative(root, path.resolve(root, config.cwd as string));
        const candidate = transport === "stdio" ? { name, transport, command: config.command,
          ...(config.args !== undefined ? { args: config.args } : {}), ...(config.env !== undefined ? { env: config.env } : {}),
          ...(relativeCwd !== undefined ? { cwd: "/srv/zeros/workspace" + (relativeCwd ? "/" + relativeCwd : "") } : {}) } :
          { name, transport, url: config.url, ...((config.headers ?? config.http_headers) !== undefined ? { headers: config.headers ?? config.http_headers } : {}) };
        const parsed = CloudMcpServerSchema.safeParse(candidate);
        if (!parsed.success) { exclude("invalid_entry", name); continue; }
        if (servers.size >= 32) { exclude("server_limit", name); continue; }
        servers.set(name, parsed.data);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") exclude(code === "ELOOP" ? "unsafe_file" : fileFailure);
    } finally { await handle?.close().catch(() => {}); }
  }
  if (excluded) {
    try { report?.(freezeCloudSnapshot({ excluded, omitted: excluded - diagnostics.length, diagnostics })); }
    catch { /* An optional notice transport cannot reject authority admission. */ }
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
