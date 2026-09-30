import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { ZerosEngine } from "../../zeros-engine";
import type { TransportClient } from "../../transport/types";
import type { CloudGithubNativeSource } from "@zeros/protocol/github-auth";
import type { createNativeGithubBroker } from "../github-native-broker";
import { configureNativeGithubTransport, requestNativeGithub } from "../github-native-client";
import { configureNativeGithubDesktop } from "../github-native-desktop";
type Broker = Awaited<ReturnType<typeof createNativeGithubBroker>>;
type Options = Parameters<typeof createNativeGithubBroker>[0];
const fixture = vi.hoisted(() => ({ brokers: [] as Broker[], options: [] as Options[], sources: [] as CloudGithubNativeSource[], forwarded: [] as string[], realRequest: false }));
vi.mock("../github-native-broker", async importOriginal => {
  const original = await importOriginal<typeof import("../github-native-broker")>();
  return { ...original, createNativeGithubBroker: async (options: Options) => {
    fixture.options.push(options);
    const broker = await original.createNativeGithubBroker({ ...options, request: async (request, signal) => {
      fixture.sources.push(request.source);
      if (fixture.realRequest) return requestNativeGithub(request, signal);
      return { token: `zgp_${"t".repeat(43)}`, owner: "org", repository: "repo", expiresAtMs: Date.now() + 60000, release: async () => undefined };
    }, forward: async url => {
      fixture.forwarded.push(url);
      return new Response("0000", { headers: { "content-type": "application/x-git-receive-pack-result" } });
    } });
    fixture.brokers.push(broker); return broker;
  } };
});
const exec = promisify(execFile);
afterEach(async () => {
  for (const broker of fixture.brokers.splice(0)) await broker.stopAndProve();
  fixture.realRequest = false; configureNativeGithubDesktop(() => []); configureNativeGithubTransport(() => null);
  fixture.options.length = 0; fixture.sources.length = 0; fixture.forwarded.length = 0; vi.restoreAllMocks();
});
async function prepare(memberIdentity = true) {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-native-terminal-"));
  await exec("git", ["init", "-b", "topic", root]);
  const engine = new ZerosEngine({ root, port: 0 });
  Object.defineProperty(engine, "cloudWorker", { value: { version: 3, backend: "cloud-worker", profile: "zeros-cloud-worker-v3", uid: process.getuid!(), gid: process.getgid!(), toolchain: { node: process.execPath, supervisor: "/opt/zeros/supervisor", bwrap: "/usr/bin/bwrap", setpriv: "/usr/bin/setpriv" } } as NonNullable<typeof engine["cloudWorker"]> });
  Object.defineProperty(engine, "cloudRuntimeRegistration", { value: { gitAuthorRequest: vi.fn(async () => ({ name: "Actor A", email: "123+a@users.noreply.github.com" })) } as unknown as NonNullable<typeof engine["cloudRuntimeRegistration"]> });
  const seam = engine as unknown as { workspaceAllowsProcessStart(): boolean; terminalDesignWatchGuard(): Promise<null> };
  vi.spyOn(engine["workspace"], "workspaceIdForCwd").mockReturnValue(null);
  vi.spyOn(engine["pty"], "resolveCwd").mockReturnValue(root);
  vi.spyOn(engine["pty"], "isWithinAllowed").mockReturnValue(true);
  vi.spyOn(seam, "workspaceAllowsProcessStart").mockReturnValue(true);
  vi.spyOn(seam, "terminalDesignWatchGuard").mockResolvedValue(null);
  const id = randomUUID(), info = { sessionId: id, pid: process.pid, cwd: root, cols: 80, rows: 24, reattached: false };
  const create = vi.spyOn(engine["pty"], "create").mockReturnValue(info);
  vi.spyOn(engine["pty"], "list").mockReturnValue([info]);
  const state = { liveA: true };
  const actor = (label: string): TransportClient => ({ id: randomUUID(), accountUserId: randomUUID(), kind: "cloud", cloudActor: { sessionId: randomUUID(), deviceId: randomUUID(), role: "developer", fingerprint: label.repeat(64) }, authorized: () => label === "a" ? state.liveA : true, send: vi.fn(), close: vi.fn() });
  const member = actor("a"), b = actor("b");
  const { accountUserId: _accountUserId, ...unidentified } = member;
  const a: TransportClient = memberIdentity ? member : unidentified;
  const message = { type: "PTY_CREATE" as const, source: "browser" as const, id: randomUUID(), timestamp: Date.now(), sessionId: id, cwd: root, cols: 80, rows: 24 };
  try { await engine["handlePtyCreate"](message, a); }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  const env = create.mock.calls[0]![0].env;
  const child = path.join(root, "git-transport.mjs");
  await writeFile(child, `import net from 'node:net';
const s=net.connect(process.argv[2]);let stage=0,output='';
const line='a'.repeat(40)+' '+'b'.repeat(40)+' refs/heads/topic'+String.fromCharCode(0)+'report-status\\n';
const body=(Buffer.byteLength(line)+4).toString(16).padStart(4,'0')+line+'0000PACK';
s.on('connect',()=>s.write(Buffer.from([5,1,0])));
s.on('error',()=>process.exit(1));
s.on('data',chunk=>{if(stage===0){stage=1;const host=Buffer.from('github.zeros.invalid');s.write(Buffer.concat([Buffer.from([5,1,0,3,host.length]),host,Buffer.from([0,80])]));}
else if(stage===1){stage=2;s.write('POST /'+process.argv[3]+'/org/repo.git/git-receive-pack HTTP/1.1\\r\\nHost: github.zeros.invalid\\r\\nContent-Type: application/x-git-receive-pack-request\\r\\nContent-Length: '+Buffer.byteLength(body)+'\\r\\nConnection: close\\r\\n\\r\\n'+body);}
else output+=chunk;});
s.on('end',()=>{process.stdout.write(output.split('\\r\\n')[0]);process.exit(output.startsWith('HTTP/1.1 200')?0:1);});
setTimeout(()=>process.exit(2),5000).unref();
`);
  const gitRequest = () => exec(process.execPath, [child, path.join(fixture.options[0]!.directory, "g"), randomUUID()], { cwd: root, env: { ...process.env, ...env } }).then(() => true, () => false);
  const reattach = async (client: TransportClient) => {
    vi.spyOn(engine["pty"], "has").mockReturnValue(true);
    vi.spyOn(engine["pty"], "snapshot").mockResolvedValue(null);
    create.mockReturnValue({ ...info, reattached: true });
    await engine["handlePtyCreate"](message, client);
  };
  return { root, engine, id, a, b, gitRequest, reattach, state, env };
}
it.runIf(process.platform === "linux").each([false, true])("cloud PTY opens with no desktop courier; push then fails with the clear message (member identity: %s)", async memberIdentity => {
  fixture.realRequest = true;
  configureNativeGithubDesktop(() => []);
  const authority = { heartbeatEndpoint: "https://api.example.test/internal/heartbeat", heartbeatToken: "synthetic-heartbeat",
    workspaceId: randomUUID(), organizationId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
  let actorUserId: string = randomUUID();
  const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const { request } = JSON.parse(String(init?.body)) as { request: { kind: string } };
    if (request.kind === "native-capabilities") return Response.json({ nativeGit: 1 });
    if (request.kind === "native-context") return Response.json({ actorUserId, workspaceId: authority.workspaceId,
      organizationId: authority.organizationId, generation: 1, engineInstanceId: authority.engineInstanceId,
      owner: "org", repository: "repo", repositoryId: "42" });
    throw new Error("Unexpected grant redemption without a desktop");
  });
  configureNativeGithubTransport(() => authority, request);
  const f = await prepare(memberIdentity);
  try {
    actorUserId = f.a.accountUserId ?? actorUserId;
    expect(request).not.toHaveBeenCalled();
    expect(fixture.sources).toHaveLength(0);
    await exec("git", ["-C", f.root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "initial"]);
    await exec("git", ["-C", f.root, "remote", "add", "origin", "https://github.com/org/repo.git"]);
    await expect(exec(path.join(fixture.options[0]!.directory, "git"), ["push", "origin", "topic"], {
      cwd: f.root, env: { ...process.env, ...f.env }, timeout: 10000,
    })).rejects.toThrow("Open Zeros to authorize GitHub push for this cloud workspace");
    expect(fixture.forwarded).toHaveLength(0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it.runIf(process.platform === "linux")("refuses GitHub forwarding once another member supplies input to the shared PTY", async () => {
  const f = await prepare();
  try {
    expect(await f.gitRequest()).toBe(true);
    await f.reattach(f.b);
    let result: Promise<boolean> | undefined;
    const write = vi.spyOn(f.engine["pty"], "write").mockImplementation(() => { result = f.gitRequest(); });
    await f.engine["handleMessage"]({ type: "PTY_WRITE", id: randomUUID(), timestamp: Date.now(), source: "browser", sessionId: f.id, data: "git push origin topic\n" }, f.b);
    expect(write).toHaveBeenCalledOnce();
    expect(await result).toBe(false);
    expect(fixture.forwarded).toHaveLength(1);
    await f.reattach(f.a);
    expect(await f.gitRequest()).toBe(false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it.runIf(process.platform === "linux")("reacquires same-member authority after disconnect without replacing the live PTY broker", async () => {
  const f = await prepare();
  try {
    expect(await f.gitRequest()).toBe(true);
    f.state.liveA = false;
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(await f.gitRequest()).toBe(false);
    const fresh: TransportClient = { ...f.a, id: randomUUID(), cloudActor: { ...f.a.cloudActor!, sessionId: randomUUID() }, authorized: () => true };
    await f.reattach(fresh);
    expect(await f.gitRequest()).toBe(true);
    expect(fixture.brokers).toHaveLength(1);
    expect(fixture.sources.at(-1)).toEqual({ kind: "terminal", actorSessionId: fresh.cloudActor!.sessionId });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
