import { constants } from "node:fs";
import { lstat, realpath, mkdir, open, rename, unlink, rmdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { parseAgentEnv } from "../agent-env-check.mjs";

const MAX_BYTES = 256 * 1024;
export const ZEROS_DEV_KEYS = Object.freeze([
  "ZEROS_DEV_PASSWORD", "ZEROS_DEV_WORKOS_SUBJECT", "ZEROS_DEV_ACCOUNT_ID", "ZEROS_DEV_EMAIL",
  "ZEROS_DEV_ORGANIZATION_ID", "ZEROS_DEV_REPOSITORY", "ZEROS_DEV_REPOSITORY_ID", "ZEROS_DEV_GITHUB_INSTALLATION_ID",
  "ZEROS_DEV_ACCESS_TOKEN", "ZEROS_DEV_REFRESH_TOKEN", "ZEROS_DEV_SESSION_ID", "ZEROS_DEV_TOKEN_EXPIRES_AT",
  "ZEROS_DEV_DEVICE_PRIVATE_KEY_B64", "ZEROS_DEV_ALPHA_READONLY_DATABASE_URL",
]);
const WRITABLE = new Set([
  "ZEROS_DEV_ACCESS_TOKEN", "ZEROS_DEV_REFRESH_TOKEN", "ZEROS_DEV_SESSION_ID", "ZEROS_DEV_TOKEN_EXPIRES_AT",
  "ZEROS_DEV_DEVICE_PRIVATE_KEY_B64",
]);
const failure = code => new Error(`zeros_dev_credentials_${code}`);
const same = (a,b) => a.dev === b.dev && a.ino === b.ino;

function safeFile(info) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() ||
      (info.mode & 0o7777) !== 0o600 || info.size > MAX_BYTES) throw failure("unsafe");
}
function safeDirectory(info, mode) {
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
      (info.mode & 0o022) || (mode !== undefined && (info.mode & 0o7777) !== mode)) throw failure("unsafe");
}

async function gitReference(handle, file) {
  const info=await handle.stat();
  // Git honors a shared-group umask for these nonsecret pointer files. That
  // group already controls the checkout's executable source. Credentials and
  // their canonical parent still require the separate private-file policy.
  const mode=info.mode&0o7777;
  if(!info.isFile() || info.nlink!==1 || info.uid!==process.getuid?.() || info.size>4096 ||
     (mode&0o7113) || !(mode&0o400) || ((mode&0o020) && info.gid!==process.getgid?.()))throw failure("unsafe");
  const text=await handle.readFile("utf8");
  if(Buffer.byteLength(text)>4096 || !same(info,await lstat(file)))throw failure("unsafe");
  return text;
}

/** Git's common directory is shared by linked checkouts. Ignore copied
 * worktree .env.agent files: refresh tokens have exactly one rotation owner. */
export async function canonicalAgentFile(checkout) {
  let directory = await realpath(checkout);
  for (let level=0;level<32;level++) {
    const entry=path.join(directory,".git");
    let handle;
    try { handle=await open(entry,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK); }
    catch(error) { if(error.code!=="ENOENT") throw failure("unsafe"); }
    if(handle) {
      try {
        const info=await handle.stat();
        let common;
        if(info.isDirectory()) {safeDirectory(info);common=await realpath(entry);}
        else {
          const match=/^gitdir: ([^\r\n]+)\r?\n?$/.exec(await gitReference(handle,entry));
          if(!match) throw failure("unsafe");
          const gitdir=await realpath(path.resolve(directory,match[1]));
          const commonFile=path.join(gitdir,"commondir");
          const reference=await open(commonFile,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
          let relative;
          try {relative=(await gitReference(reference,commonFile)).trim();}finally{await reference.close();}
          if(!relative || /[\r\n\0]/.test(relative)) throw failure("unsafe");
          common=await realpath(path.resolve(gitdir,relative));
        }
        if(!same(info,await lstat(entry)) || path.basename(common)!==".git") throw failure("unsafe");
        const root=path.dirname(common); safeDirectory(await lstat(root));
        return path.join(root,".env.agent");
      } catch {throw failure("unsafe");}
      finally {await handle.close();}
    }
    const parent=path.dirname(directory);if(parent===directory)break;directory=parent;
  }
  throw failure("missing");
}

function parsedValues(text) {
  const parsed=parseAgentEnv(text);
  if(parsed.malformedLines.length || parsed.duplicateKeys.length ||
     [...parsed.values.keys()].some(key=>key.startsWith("ZEROS_DEV_")&&!ZEROS_DEV_KEYS.includes(key))) throw failure("invalid");
  return Object.freeze(Object.fromEntries(parsed.values));
}

export class AgentFileStore {
  constructor(file, {lockTimeoutMs=10_000}={}) {
    this.file=path.resolve(file); this.lockTimeoutMs=lockTimeoutMs;
    if(path.basename(this.file)!==".env.agent")throw failure("unsafe");
  }
  async read() {
    safeDirectory(await lstat(path.dirname(this.file)));
    let handle;
    try {
      handle=await open(this.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const opened=await handle.stat();safeFile(opened);
      const text=await handle.readFile("utf8");
      safeFile(await handle.stat());
      if(Buffer.byteLength(text)>MAX_BYTES || !same(opened,await lstat(this.file)))throw failure("unsafe");
      return {text,values:parsedValues(text),info:opened};
    } catch(error) {
      if(error.message?.startsWith("zeros_dev_credentials_"))throw error;
      throw failure(error.code==="ENOENT"?"missing":"unsafe");
    } finally {await handle?.close();}
  }
  async locked(work) {
    // Validate before creating anything, including when a caller will log in.
    await this.read();
    const lock=`${this.file}.zeros-dev-lock`;
    const deadline=performance.now()+this.lockTimeoutMs;
    let held;
    for(;;) {
      try {await mkdir(lock,{mode:0o700});held=await lstat(lock);safeDirectory(held,0o700);break;}
      catch(error) {
        if(error.code!=="EEXIST")throw error.message?.startsWith("zeros_dev_credentials_")?error:failure("unsafe");
        safeDirectory(await lstat(lock),0o700);
        if(performance.now()>=deadline)throw failure("busy");
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    }
    try {
      let current=await this.read();
      const store={
        get values(){return current.values;},
        update:async changes=>{
          if(!changes || typeof changes!=="object" || Array.isArray(changes) || Object.entries(changes).some(([key,value])=>
            !WRITABLE.has(key) || typeof value!=="string" || value.length>128*1024 || /[\r\n\0]/.test(value) || value.trim()!==value))throw failure("invalid");
          const before=await this.read();
          if(!same(current.info,before.info) || current.text!==before.text || !same(held,await lstat(lock)))throw failure("changed");
          const pending=new Map(Object.entries(changes));
          const lines=current.text.replace(/\r\n/g,"\n").split("\n").map(line=>{
            const key=/^\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
            if(!key || !pending.has(key))return line;
            const value=pending.get(key);pending.delete(key);return `${key}=${value}`;
          });
          while(lines.at(-1)==="")lines.pop();
          for(const [key,value] of pending)lines.push(`${key}=${value}`);
          const text=lines.join("\n")+"\n";
          const parsed=parsedValues(text);
          if(Object.entries(changes).some(([key,value])=>parsed[key]!==value))throw failure("invalid");
          if(Buffer.byteLength(text)>MAX_BYTES)throw failure("invalid");
          // Atomic replacement protects unrelated provider keys from a crash.
          // A mode-0600 sibling exists only during this rename; no backup or
          // session cache is retained, and it is never read as a credential file.
          const temporary=`${this.file}.write-${randomUUID()}`;
          let output;
          try {
            output=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
            safeFile(await output.stat());
            await output.writeFile(text);await output.sync();await output.close();output=undefined;
            if(!same(before.info,await lstat(this.file)) || !same(held,await lstat(lock)))throw failure("changed");
            await rename(temporary,this.file);
            const directory=await open(path.dirname(this.file),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
            try{safeDirectory(await directory.stat());await directory.sync();}finally{await directory.close();}
            current=await this.read();
          } finally {await output?.close();await unlink(temporary).catch(error=>{if(error.code!=="ENOENT")throw failure("unsafe");});}
        },
      };
      return await work(store);
    } finally {
      if(same(held,await lstat(lock)))await rmdir(lock);
    }
  }
}
