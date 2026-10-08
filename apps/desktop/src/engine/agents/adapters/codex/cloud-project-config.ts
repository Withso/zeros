import { constants } from "node:fs";
import { open, realpath, readlink, opendir } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { CloudProviderExecution } from "../../cloud-provider-execution";
import type { AvailableCommand } from "@zeros/protocol/agent-events";

// Native repository configuration stays disabled. These data-only settings
// are captured by the engine and passed as immutable process/thread overrides.
// No provider/auth/endpoint/profile/env/MCP, permission or state-root field is
// projected, including a repository's redefinition of the `openai` provider.
const safeSettings = {
  developer_instructions: z.string().max(32 * 1024),
  model_reasoning_summary: z.enum(["auto", "concise", "detailed", "none"]),
  model_verbosity: z.enum(["low", "medium", "high"]),
  personality: z.enum(["none", "friendly", "pragmatic"]),
  project_doc_max_bytes: z.number().int().positive().max(64 * 1024),
  project_doc_fallback_filenames: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)).max(16),
} as const;
type ProjectSnapshot = { settings: Readonly<Record<string, unknown>>; excluded: boolean };
const snapshots = new WeakMap<CloudProviderExecution, ProjectSnapshot>();
const empty = (excluded = false): ProjectSnapshot => ({ settings: Object.freeze({}), excluded });

export async function readCloudCodexProjectConfig(cwd: string): Promise<ProjectSnapshot> {
  let handle;
  try {
    const root = await realpath(cwd);
    const directory = path.join(root, ".codex");
    // Disallow parent symlink escapes as well as final-file symlinks/FIFOs.
    if (await realpath(directory) !== directory) return empty(true);
    handle = await open(path.join(directory, "config.toml"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const actual = await readlink(`/proc/self/fd/${handle.fd}`), stat = await handle.stat();
    if (actual !== path.join(directory, "config.toml") || !stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) return empty(true);
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 64 * 1024) return empty(true);
    const document = parseToml(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)));
    const settings: Record<string, unknown> = {};
    let excluded = Object.keys(document).some(key => !Object.hasOwn(safeSettings, key) && key !== "mcp_servers");
    for (const [key, schema] of Object.entries(safeSettings)) {
      if (!Object.hasOwn(document, key)) continue;
      const parsed = schema.safeParse(document[key]);
      if (!parsed.success) { excluded = true; continue; }
      settings[key] = Array.isArray(parsed.data) ? Object.freeze(parsed.data) : parsed.data;
    }
    return { settings: Object.freeze(settings), excluded };
  } catch (error) {
    // Optional repo settings never block basic execution. Diagnostics contain
    // no excerpts of a name/value/path/parse exception from this untrusted file.
    return empty((error as NodeJS.ErrnoException)?.code !== "ENOENT");
  } finally { await handle?.close(); }
}

export async function captureCloudCodexProjectConfig(execution: CloudProviderExecution, cwd: string): Promise<ProjectSnapshot> {
  const existing = snapshots.get(execution);
  if (existing) return existing;
  execution.lease.assertLive();
  const settings = await readCloudCodexProjectConfig(cwd);
  const instructions = await readCloudCodexInstructions(cwd, settings.settings);
  const snapshot:ProjectSnapshot={settings:Object.freeze({...settings.settings,
    ...(instructions.text?{developer_instructions:instructions.text}:{})}),excluded:settings.excluded||instructions.excluded};
  execution.lease.assertLive();
  snapshots.set(execution, snapshot);
  return snapshot;
}

/** The pinned CLI does not scan AGENTS.md under untrusted project trust.
 * Append only bounded UTF-8 instruction data through its native developer
 * channel. This neither enables native project settings nor scans HOME. */
async function readCloudCodexInstructions(cwd:string,settings:Readonly<Record<string,unknown>>):Promise<{text?:string;excluded:boolean}>{
  const base=typeof settings.developer_instructions==="string"?settings.developer_instructions:"";
  const names=["AGENTS.override.md","AGENTS.md",...((settings.project_doc_fallback_filenames as readonly string[]|undefined)??[])];
  let excluded=false;
  for(const name of names){
    let file;
    try{
      const root=await realpath(cwd),target=path.join(root,name);
      file=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const info=await file.stat();
      if(!info.isFile()||info.nlink!==1||info.size>64*1024||await readlink(`/proc/self/fd/${file.fd}`)!==target){excluded=true;continue;}
      const bytes=Buffer.alloc(64*1024+1),read=await file.read(bytes,0,bytes.length,0);
      const maximum=typeof settings.project_doc_max_bytes==="number"?settings.project_doc_max_bytes:32*1024;
      if(read.bytesRead>maximum){excluded=true;continue;}
      const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,read.bytesRead));
      if(!text.trim())continue;
      const appended=[base,`Repository instructions (${name}):\n${text}`].filter(Boolean).join("\n\n");
      if(Buffer.byteLength(appended)>64*1024||Buffer.byteLength(JSON.stringify(appended))>96*1024){excluded=true;continue;}
      return {text:appended,excluded};
    }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")excluded=true;}
    finally{await file?.close();}
  }
  return {text:base||undefined,excluded};
}
export function cloudCodexProjectSettings(execution: CloudProviderExecution): Readonly<Record<string, unknown>> {
  return snapshots.get(execution)?.settings ?? {};
}

/** Cloud command metadata comes only from bounded regular repository files,
 * never from the engine's HOME. Bodies remain instruction data, as in Local
 * discovery; this does not enable native plugins or project configuration. */
export async function discoverCloudCodexCommands(execution:CloudProviderExecution):Promise<AvailableCommand[]>{
  execution.lease.assertLive();const commands:AvailableCommand[]=[];
  try{
    const root=await realpath(execution.cwd),directory=path.join(root,".codex/prompts");
    if(await realpath(path.join(root,".codex"))!==path.join(root,".codex")||await realpath(directory)!==directory)return [];
    const entries=await opendir(directory);let count=0,remaining=256*1024;
    for await(const entry of entries){
      if(++count>64||remaining<=0)break;
      if(!entry.isFile()||!entry.name.endsWith(".md"))continue;
      let file;
      try{
        const target=path.join(directory,entry.name);file=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>64*1024||stat.size>remaining||await readlink(`/proc/self/fd/${file.fd}`)!==target)continue;
        const bytes=Buffer.alloc(Math.min(64*1024,remaining)+1),read=await file.read(bytes,0,bytes.length,0);remaining-=read.bytesRead;
        if(read.bytesRead>64*1024||remaining<0)continue;
        const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,read.bytesRead));
        const front=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
        const field=(key:string)=>new RegExp(`^${key}:\\s*(.+)$`,"m").exec(front?.[1]??"")?.[1]?.trim().replace(/^(["'])([\s\S]*)\1$/,"$2");
        const name=field("name")??entry.name.slice(0,-3);if(!/^[A-Za-z0-9_-]{1,128}$/.test(name))continue;
        const description=(field("description")??text.slice(front?.[0].length??0).split(/\r?\n/).find(line=>line.trim())??"").trim().slice(0,512);
        commands.push({name,description,kind:"command"});
      }catch{/* Optional command metadata never blocks a turn. */}finally{await file?.close();}
    }
  }catch{/* Missing optional repository commands are normal. */}
  execution.lease.assertLive();return commands.sort((a,b)=>a.name.localeCompare(b.name));
}
