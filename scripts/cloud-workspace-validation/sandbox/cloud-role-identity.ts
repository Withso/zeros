import { readlinkSync } from "node:fs";
import { cloudEnginePrivilegeStatus } from "./qualify-cloud-engine.mjs";

/** Fixed credential-free kernel observation executed by an original target.
 * It emits nothing; callers publish only a fixed success marker after checks. */
export function cloudRoleIdentityProbe(options: { workloadDirectory: string; home?: string; credential: "absent" | "synthetic-cursor" },
  readNamespace: (file: string) => string = readlinkSync): string {
  const names = ["mnt", "pid", "user", "net", "cgroup"];
  const namespaces = Object.fromEntries(names.map(name => {
    const value = readNamespace(`/proc/self/ns/${name}`);
    if (!new RegExp(`^${name}:\\[[0-9]{1,20}\\]$`).test(value)) throw new Error("Cloud role namespace is unavailable");
    return [name, value];
  }));
  if (!options.workloadDirectory.startsWith("/sys/fs/cgroup/") || options.workloadDirectory.includes("\0"))
    throw new Error("Cloud role workload is unavailable");
  return `{
    const fs=require('node:fs'), expected=${JSON.stringify(namespaces)};
    let ok=false;
    try {
      const privilege=(${cloudEnginePrivilegeStatus.toString()})(fs.readFileSync('/proc/self/status','utf8'));
      ok=[process.getuid(),process.geteuid(),process.getgid(),process.getegid()].every(value=>value===10003) &&
        privilege.noNewPrivs===1 && privilege.seccompMode===2 && Object.values(privilege.capabilities).every(value=>value===0) &&
        Object.entries(expected).every(([name,value])=>fs.readlinkSync('/proc/self/ns/'+name)===value) &&
        fs.readFileSync('/proc/self/cgroup','utf8')===${JSON.stringify(`0::${options.workloadDirectory.slice("/sys/fs/cgroup".length)}\n`)} &&
        ${options.home === undefined ? "true" : `process.env.HOME===${JSON.stringify(options.home)}`} &&
        ['ANTHROPIC_API_KEY','OPENAI_API_KEY','CODEX_API_KEY'].every(name=>!process.env[name]) &&
        ${options.credential === "synthetic-cursor" ? "process.env.CURSOR_API_KEY==='synthetic-image-private-credential'" : "!process.env.CURSOR_API_KEY"};
    } catch {}
    if(!ok)process.exit(91);
  }\n`;
}
