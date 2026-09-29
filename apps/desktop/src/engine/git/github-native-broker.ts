import { execFile } from "node:child_process";
import { chmod, chown, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import path from "node:path";
import { promisify } from "node:util";
import { CLOUD_GITHUB_DESKTOP_REQUIRED, type CloudGithubNativeSource } from "@zeros/protocol/github-auth";
import { forwardNativeGithub, requestNativeGithub, type NativeGitCredential, type NativeGitOperation } from "./github-native-client";
import { nativeGithubTerminalPeer } from "./github-native-peer";
import { nativeGithubGitSocket } from "./github-native-socks";
const exec = promisify(execFile);
type Options = {
  directory: string; visibleDirectory: string; cwd: string; path: string; node: string;
  source: CloudGithubNativeSource | (() => CloudGithubNativeSource); authorized(): boolean; signal?: AbortSignal;
  onAuthorityChange?: (invalidate: () => void) => void; onRetire?: () => void;
  identity?: { uid: number; gid: number }; peerProcess?: () => number | null;
  request?: (request: NativeGitOperation, signal: AbortSignal) => Promise<NativeGitCredential>;
  forward?: (path: string, token: string, init: RequestInit) => Promise<Response>;
};
type Operation = { source: string; controller: AbortController; branch: string | null; operation: "git.push" | "git.fetch"; deadline: number; credential: Promise<NativeGitCredential> };

/** Git-only Unix transport. Each Git invocation obtains a connected-account
 * grant through the desktop. Neither grants nor bearers enter child env/files. */
export async function createNativeGithubBroker(options: Options) {
  const controller = new AbortController(), operations = new Map<string, Operation>();
  const request = options.request ?? requestNativeGithub, forward = options.forward ?? forwardNativeGithub;
  let retired = false;
  const live = () => !retired && !options.signal?.aborted && options.authorized();
  const source = () => typeof options.source === "function" ? options.source() : options.source;
  const sourceKey = () => { try { return JSON.stringify(source()); } catch { return null; } };
  const release = async (id: string) => {
    const operation = operations.get(id); operations.delete(id);
    operation?.controller.abort();
    if (operation) await operation.credential.then(value => value.release()).catch(() => undefined);
  };
  options.onAuthorityChange?.(() => { for (const id of operations.keys()) void release(id); });
  const currentBranch = async () => {
    try {
      return (await exec("/usr/bin/git", ["-c", `safe.directory=${options.cwd}`, "symbolic-ref", "--quiet", "--short", "HEAD"], {
        cwd: options.cwd, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 3000,
      })).stdout.trim() || null;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === 1) return null;
      throw new Error("Cloud Git branch inspection failed");
    }
  };
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const socket = path.join(options.directory, "g");
  const http = createServer(async (incoming, outgoing) => {
    outgoing.setHeader("cache-control", "no-store");
    try {
      const actor = source();
      if (!live() || (actor.kind === "terminal" && (!options.peerProcess ||
          !await nativeGithubTerminalPeer(incoming.socket, options.peerProcess() ?? 0)))) throw new Error();
      if (incoming.headers.host !== "github.zeros.invalid") throw new Error();
      const url = new URL(incoming.url ?? "", "http://github.zeros.invalid");
      const match = /^\/([a-f0-9-]{36})(\/.*)?$/.exec(url.pathname);
      if (!match) throw new Error();
      const id = match[1]!, route = match[2];
      if (incoming.method === "DELETE" && !route && !url.search) {
        await release(id); outgoing.writeHead(204); outgoing.end(); return;
      }
      const repo = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/?(\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(route ?? "");
      if (!repo) throw new Error();
      const rpc = repo[4] === "info/refs" ? url.searchParams.get("service") : repo[4];
      if (!["git-receive-pack", "git-upload-pack"].includes(rpc ?? "") ||
          (repo[4] === "info/refs" ? incoming.method !== "GET" || url.search !== `?service=${rpc}` : incoming.method !== "POST" || !!url.search)) throw new Error();
      const kind = rpc === "git-receive-pack" ? "git.push" : "git.fetch";
      const branch = await currentBranch();
      if (kind === "git.push" && !branch) throw new Error();
      let operation = operations.get(id);
      if (!operation) {
        if (operations.size >= 16) throw new Error();
        const started = performance.now(), operationController = new AbortController();
        operation = { source: JSON.stringify(actor), controller: operationController, branch, operation: kind, deadline: started + 59000,
          credential: request({ source: actor, operation: kind, branch }, AbortSignal.any([controller.signal, operationController.signal])).then(value => {
            const current = operations.get(id);
            if (!live() || !current || current.source !== sourceKey()) { void value.release(); throw new Error(); }
            current.deadline = Math.min(current.deadline, performance.now() + value.expiresAtMs - Date.now() - 1000);
            return value;
          }) };
        operations.set(id, operation);
      }
      const credential = await operation.credential;
      if (!live() || operation.controller.signal.aborted || operation.source !== sourceKey() || operation.operation !== kind || operation.branch !== branch || performance.now() >= operation.deadline ||
          repo[1]!.toLowerCase() !== credential.owner.toLowerCase() || repo[2]!.toLowerCase() !== credential.repository.toLowerCase()) throw new Error();
      const headers: Record<string, string> = {};
      for (const name of ["content-type", "git-protocol", "content-encoding"])
        if (typeof incoming.headers[name] === "string") headers[name] = incoming.headers[name];
      const response = await forward(`/${credential.owner}/${credential.repository}.git/${repo[4]}${url.search}`, credential.token, {
        method: incoming.method, headers,
        signal: AbortSignal.any([controller.signal, operation.controller.signal, AbortSignal.timeout(Math.max(1, Math.floor(operation.deadline - performance.now())))]),
        ...(incoming.method === "POST" ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
      } as RequestInit);
      if (!live() || operation.controller.signal.aborted || operation.source !== sourceKey()) { await response.body?.cancel(); throw new Error(); }
      outgoing.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "text/plain" });
      if (!response.body) { outgoing.end(); return; }
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).on("error", () => outgoing.destroy()).pipe(outgoing);
    } catch (error) {
      if (!outgoing.headersSent) outgoing.writeHead(403, { "content-type": "text/plain" });
      outgoing.end(`${error instanceof Error && [CLOUD_GITHUB_DESKTOP_REQUIRED, "Open a new terminal to authorize GitHub for your account."].includes(error.message)
        ? error.message : "Cloud Git operation is not authorized or its authority has expired."}\n`);
    }
  });
  http.requestTimeout = 60000; http.headersTimeout = 10000;
  const git = nativeGithubGitSocket(http);
  try {
    await writeFile(path.join(options.directory, "git"), `#!${options.node}\n${nativeGitShim(path.join(options.visibleDirectory, "g"))}`, { mode: 0o500, flag: "wx" });
    await new Promise<void>((resolve, reject) => { git.server.once("error", reject); git.server.listen(socket, resolve); });
    if (options.identity) for (const file of [options.directory, socket, path.join(options.directory, "git")])
      await chown(file, options.identity.uid, options.identity.gid);
    await chmod(socket, 0o600);
  } catch (error) { git.close(); git.server.close(); await rm(options.directory, { recursive: true, force: true }); throw error; }
  let closing: Promise<void> | undefined;
  const stopAndProve = (): Promise<void> => {
    if (closing) return closing;
    retired = true; controller.abort(); clearInterval(timer); options.signal?.removeEventListener("abort", abort);
    options.onRetire?.();
    closing = (async () => {
      git.close(); await new Promise<void>(resolve => git.server.close(() => resolve()));
      await Promise.all([...operations.keys()].map(release));
      await rm(options.directory, { recursive: true, force: true });
    })();
    return closing;
  };
  const abort = () => { void stopAndProve().catch(() => undefined); };
  const timer = setInterval(() => {
    if (!live()) abort();
    else for (const [id, operation] of operations) if (performance.now() >= operation.deadline || operation.source !== sourceKey()) void release(id);
  }, 1000);
  timer.unref(); options.signal?.addEventListener("abort", abort, { once: true });
  if (!live()) { await stopAndProve(); throw new Error("Cloud GitHub admission ended"); }
  return { env: { PATH: `${options.visibleDirectory}:${options.path}` }, stopAndProve };
}

function nativeGitShim(socket: string): string {
  return `const {spawn}=require('node:child_process');
const socket=${JSON.stringify(socket)},id=require('node:crypto').randomUUID();
const args=process.argv.slice(2);let command;
for(let i=0;i<args.length;i++){if(['-C','-c','--git-dir','--work-tree','--namespace','--super-prefix','--config-env'].includes(args[i])){i++;continue;}if(!args[i].startsWith('-')){command=args[i];break;}}
const env={...process.env},network=['push','fetch','pull','clone','ls-remote'].includes(command);
if(network){
  const origin='http://github.zeros.invalid/'+id+'/';
  let count=Number(env.GIT_CONFIG_COUNT||0);if(!Number.isInteger(count)||count<0||count>64)process.exit(1);
  for(const [key,value] of [['url.'+origin+'.insteadOf','https://github.com/'],['url.'+origin+'.insteadOf','git@github.com:'],['url.'+origin+'.insteadOf','ssh://git@github.com/'],['credential.'+origin+'.helper',''],['http.http://github.zeros.invalid/.proxy','socks5h://localhost'+socket],['http.followRedirects','false']]){env['GIT_CONFIG_KEY_'+count]=key;env['GIT_CONFIG_VALUE_'+count]=value;count++;}
  env.GIT_CONFIG_COUNT=String(count);env.GIT_TERMINAL_PROMPT='0';delete env.NO_PROXY;delete env.no_proxy;
}
const child=spawn('/usr/bin/git',args,{env,stdio:'inherit'});
function finish(code){
  if(!network){process.exit(code);return;}
  const net=require('node:net'),client=net.connect(socket);let stage=0,buf=Buffer.alloc(0);
  const done=()=>{client.destroy();process.exit(code);};client.setTimeout(1500,done);client.on('error',done);client.on('end',done);
  client.on('connect',()=>client.write(Buffer.from([5,1,0])));
  client.on('data',data=>{buf=Buffer.concat([buf,data]);if(stage===0&&buf.length>=2){if(buf[0]!==5||buf[1]!==0)return done();buf=buf.subarray(2);stage=1;const host=Buffer.from('github.zeros.invalid');client.write(Buffer.concat([Buffer.from([5,1,0,3,host.length]),host,Buffer.from([0,80])]));}
    if(stage===1&&buf.length>=10){if(buf[0]!==5||buf[1]!==0)return done();stage=2;buf=Buffer.alloc(0);client.write('DELETE /'+id+' HTTP/1.1\\r\\nHost: github.zeros.invalid\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n');}
    else if(stage===2)done();});
}
child.on('error',()=>finish(1));child.on('exit',code=>finish(code??1));
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child.kill(signal));\n`;
}
