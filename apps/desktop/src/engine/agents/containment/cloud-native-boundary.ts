import type { ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, chown, lstat, mkdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import type { CloudAgentAccessMaterial } from "@zeros/protocol/cloud-agent-execution";
import type { CloudAgentLease } from "../cloud-agent-lease";
import { attestCloudCoordinator } from "./cloud-coordinator-attestation";
import { cloudCoordinatorEnvironment, CLOUD_COORDINATOR_HOME } from "./cloud-coordinator-view.mjs";
import { acquireCloudNativeHistory, CLOUD_NATIVE_HISTORY_ROOT } from "./cloud-native-history";
import { CLOUD_CODEX_STATE_DIRECTORIES, CLOUD_NATIVE_HOME, CLOUD_NATIVE_SKILL_HOMES, type CloudNativeHomeView } from "./cloud-native-view.mjs";
import { loadCloudWorkerConfiguration } from "./cloud-worker-config";
import type { BoundaryLaunchSpec, BoundaryProcess, BoundarySpawnRequest, PortRequest, PreparedBoundary } from "./types";
import {hasCloudBackgroundServers} from "./cloud-background-processes";

import { cloudGitAuthorEnvironment } from "../../git/cloud-git-author";
import { createNativeGithubBroker } from "../../git/github-native-broker";
import { materializeCloudSkills } from "../cloud-skills";

const ROOT = "/run/zeros/coordinators";
const AUTH_ENV = new Set(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CURSOR_API_KEY", "OPENAI_API_KEY"]);
const STARTUP_ENV = new Set(["CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS", "CLAUDE_CODE_STARTUP_FAILURE_RESULTS", "NODE_USE_ENV_PROXY"]);
const CANARY = `const fs=require('node:fs');
if(process.getuid()!==10001||process.getgid()!==10001||!/^CapEff:\\s+0+$/m.test(fs.readFileSync('/proc/self/status','utf8')))process.exit(91);
if(fs.readlinkSync('/proc/self/ns/pid')===process.argv[1])process.exit(92);
try{fs.readFileSync(process.argv[2]);process.exit(93);}catch(error){if(!['EACCES','EPERM','ENOENT'].includes(error.code))process.exit(94);}
const file=process.env.HOME+'/.zeros-canary';fs.writeFileSync(file,'canary',{flag:'wx'});fs.unlinkSync(file);
if(!fs.statSync('/srv/zeros/workspace/.git').isDirectory()&&!fs.statSync('/srv/zeros/workspace/.git').isFile())process.exit(95);
process.stdout.write('zeros-native-provider-v1');`;

/** The provider and its native tools execute in the same admitted workspace
 * boundary. Only the active connection enters this private, disposable HOME;
 * engine authority and all other conversations remain outside its view.
 * Native tools share the active provider's trust, as on a local machine. */
/** Immutable empty native user/system config namespaces. Mutable repository
 * config is disabled by the pinned process CLI override. The directory itself
 * is bound, so a child cannot rename its parent and replace config.toml
 * between native start/resume requests. Entries below are mount points only;
 * the pinned CLI's writable state is private per process (cloud-native-view). */
export async function prepareCloudCodexConfigView(directory: string): Promise<void> {
  for (const name of ["", "/sessions", ...CLOUD_CODEX_STATE_DIRECTORIES.map(name => `/${name}`)]) {
    await mkdir(`${directory}/codex-config${name}`, { mode: 0o755 }); await chmod(`${directory}/codex-config${name}`, 0o755);
  }
  await writeFile(`${directory}/codex-config/installation_id`, "", { flag: "wx", mode: 0o444 });
  await writeFile(`${directory}/codex-installation-id`, randomUUID(), { flag: "wx", mode: 0o600 });
}

/** Each provider home that receives the organization's skills belongs to the
 * worker, like the active provider's own home, so the skills stay readable. */
export async function prepareCloudSkillHomes(directory: string, provider: string, uid: number, gid: number): Promise<void> {
  for (const home of CLOUD_NATIVE_SKILL_HOMES) {
    if (home === `.${provider}`) continue;
    await mkdir(`${directory}/home/${home}`, { mode: 0o700 }); await chown(`${directory}/home/${home}`, uid, gid);
  }
}

export class CloudNativeBoundary implements PreparedBoundary {
  readonly generation;
  readonly status;
  readonly attestation;
  readonly providerHomePath = CLOUD_NATIVE_HOME;
  private retired = false;
  private closing: Promise<void> | null = null;
  private readonly launches = new Map<string, BoundaryLaunchSpec>();
  private readonly nativeProcesses = new Set<BoundaryProcess>();
  private handoffTaken = false;
  get redactor() { return this.history.redactor; }
  get requiresFreshHistory() { return this.history.fresh; }
  async confirmHistoryBinding(): Promise<void> {
    if (!this.retired) await this.history.confirmBinding();
  }
  recordPublication(notification: Parameters<NonNullable<typeof this.history.record>>[0]) { this.history.record?.(notification); }
  takeHistoryHandoff(): string | undefined {
    if (!this.history.fresh || this.handoffTaken) return undefined;
    this.handoffTaken = true;
    return `The customization owner changed. This is a fresh native session. Earlier scrubbed conversation context (may be incomplete):\n${this.history.handoff ?? ""}`;
  }

  private constructor(
    readonly lease: CloudAgentLease,
    readonly workload: PreparedBoundary,
    private readonly view: CloudNativeHomeView,
    private env: Record<string, string>,
    private readonly history: Awaited<ReturnType<typeof acquireCloudNativeHistory>>,
  ) {
    Object.assign(this.env, cloudGitAuthorEnvironment(lease.gitAuthor ?? null));
    this.generation = workload.generation;
    this.status = workload.status;
    this.attestation = workload.attestation;
  }

  static async prepare(lease: CloudAgentLease, workload: PreparedBoundary, conversationId: string,
    settings?: Record<string, string>): Promise<CloudNativeBoundary> {
    const configuration = loadCloudWorkerConfiguration();
    if ((configuration?.version !== 3 && configuration?.version !== 4) || workload.status.backend !== "cloud-worker")
      throw new Error("Native cloud agents require a qualified cloud worker");
    lease.assertLive(); await workload.attestation; lease.assertLive();
    await mkdir(ROOT, { recursive: true, mode: 0o700 });
    const root = await lstat(ROOT);
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== 0 || (root.mode & 0o077) !== 0 || await realpath(ROOT) !== ROOT)
      throw new Error("Native cloud provider root is not engine-owned");
    const directory = `${ROOT}/${randomBytes(16).toString("hex")}`;
    await mkdir(directory, { mode: 0o700 });
    let history: Awaited<ReturnType<typeof acquireCloudNativeHistory>> | undefined;
    let boundary: CloudNativeBoundary | undefined;
    try {
      if (lease.customization && !lease.customization.history) throw new Error("Cloud customization history requires an updated control plane and runtime.");
      history = await acquireCloudNativeHistory({ root: CLOUD_NATIVE_HISTORY_ROOT, conversationId,
        provider: lease.admission.provider, uid: configuration.uid, gid: configuration.gid,
        ...(lease.customization?.history ? { customization: { authority: lease.customization.history, secrets: lease.customization.servers.flatMap(({server}) =>
          Object.values(server.transport === "stdio" ? server.env ?? {} : server.headers ?? {})) } } : {}) });
      await mkdir(`${directory}/home`, { mode: 0o700 });
      await chown(`${directory}/home`, configuration.uid, configuration.gid);
      const providerHome = `${directory}/home/.${lease.admission.provider}`;
      await mkdir(providerHome, { mode: 0o700 });
      await chown(providerHome, configuration.uid, configuration.gid);
      if (lease.customization) {
        await materializeCloudSkills(directory, lease.customization.skills);
        await prepareCloudSkillHomes(directory, lease.admission.provider, configuration.uid, configuration.gid);
      }
      if (lease.admission.provider === "codex") {
        await prepareCloudCodexConfigView(directory);
        await chown(`${directory}/codex-installation-id`, configuration.uid, configuration.gid);
      }
      const original = cloudCoordinatorEnvironment(lease.takeMaterial(), lease.admission.model, settings);
      const env = Object.fromEntries(Object.entries(original).map(([name, value]) =>
        [name, value === CLOUD_COORDINATOR_HOME || value.startsWith(`${CLOUD_COORDINATOR_HOME}/`)
          ? `${CLOUD_NATIVE_HOME}${value.slice(CLOUD_COORDINATOR_HOME.length)}` : value]));
      env.USER = env.LOGNAME = "zeros-agent";
      for (const key of Object.keys(env)) if (/^(GH_|GITHUB_)/.test(key)) delete env[key];
      {
        const github = await createNativeGithubBroker({ directory: `${directory}/home/.zeros-github`, visibleDirectory: `${CLOUD_NATIVE_HOME}/.zeros-github`,
        cwd: "/srv/zeros/workspace", path: env.PATH!, node: configuration.toolchain.node, identity: configuration,
        source: { kind: "agent", leaseId: lease.leaseId }, signal: lease.signal,
        authorized: () => { try { lease.assertLive(); return true; } catch { return false; } } });
        lease.attach(github);
        Object.assign(env, github.env);
      }
      boundary = new CloudNativeBoundary(lease, workload, { directory, history: history.mount,
        ...(lease.admission.provider === "codex" ? { codexConfig: true as const } : {}),
        ...(lease.customization ? { skills: true as const } : {}) }, env, history);
      lease.attach(boundary);
      const owned = boundary;
      const authorityCanary = `${directory}/.authority-canary`;
      await writeFile(authorityCanary, "engine-private", { flag: "wx", mode: 0o600 });
      const parentNamespace = await readlink("/proc/self/ns/pid");
      const canary = await lease.launch(() => workload.spawn(owned.request({ command: configuration.toolchain.node,
        args: ["-e", CANARY, parentNamespace, authorityCanary], cwd: "/srv/zeros/workspace", env: {}, stdio: "pipe" }, true)));
      canary.stderr?.resume();
      await attestCloudCoordinator(lease, canary, "zeros-native-provider-v1");
      await lease.validate(); lease.assertLive();
      return boundary;
    } catch (error) {
      void lease.close().catch(() => {});
      if (!boundary) { await history?.release(); await rm(directory, { recursive: true, force: true }); }
      throw error;
    }
  }

  private assertLive(): void {
    if (this.retired) throw new Error("Native cloud provider is retired");
    this.lease.assertLive();
  }
  environment(): Record<string, string> { this.assertLive(); return { ...this.env }; }
  codexExternalAuth(): Extract<CloudAgentAccessMaterial, { kind: "codex-chatgpt" }> | null {
    this.assertLive(); return this.lease.codexAuth()?.material ?? null;
  }
  private request(request: BoundarySpawnRequest, canary = false): BoundarySpawnRequest {
    this.assertLive();
    const env = Object.fromEntries(Object.entries(this.env).filter(([name]) => !canary || !AUTH_ENV.has(name)));
    for (const name of STARTUP_ENV) if (request.env[name] === "1") env[name] = "1";
    return { command: request.command, args: request.args, cwd: request.cwd,
      env, stdio: request.stdio, cloudNativeHome: this.view };
  }
  wrapSpawn(request: BoundarySpawnRequest): BoundaryLaunchSpec {
    this.assertLive();
    if (this.launches.size >= 16) throw new Error("Native cloud launch capacity exceeded");
    const launch = this.workload.wrapSpawn(this.request(request));
    const key = JSON.stringify([launch.command, ...launch.args]);
    if (this.launches.has(key)) throw new Error("Native cloud launch identity was reused");
    this.launches.set(key, launch); return launch;
  }
  cancelUnstartedLaunch(launch: BoundaryLaunchSpec): void {
    const key = JSON.stringify([launch.command, ...launch.args]);
    if (this.launches.get(key) !== launch) throw new Error("Native cloud launch identity is invalid");
    this.workload.cancelUnstartedLaunch?.(launch);
    this.launches.delete(key);
  }
  trackProcess(child: ChildProcess): BoundaryProcess {
    const key = JSON.stringify(child.spawnargs);
    const launch = this.launches.get(key);
    if (!launch || launch.command !== child.spawnfile) {
      void this.lease.close().catch(() => {}); throw new Error("Native cloud launch identity is invalid");
    }
    const tracked = this.workload.trackProcess(child);
    this.observeProcess(tracked);
    this.launches.delete(key);
    this.lease.attach(tracked); this.assertLive(); return tracked;
  }
  trackProcessGroup(): never { throw new Error("Native provider processes require an owned launch"); }
  private observeProcess(process:BoundaryProcess):void{
    this.nativeProcesses.add(process);
    void process.wait().finally(()=>this.nativeProcesses.delete(process)).catch(()=>{});
  }
  async hasBackgroundServers():Promise<boolean>{
    this.assertLive();
    const active=await hasCloudBackgroundServers([...this.nativeProcesses].map(process=>process.pid));
    this.assertLive();return active;
  }
  async spawn(request: BoundarySpawnRequest): Promise<BoundaryProcess> {
    const process=await this.lease.launch(() => this.workload.spawn(this.request(request)));
    this.observeProcess(process);return process;
  }
  requestPort(request: PortRequest) { this.assertLive(); return this.workload.requestPort(request); }
  activePorts() { return this.workload.activePorts(); }
  portDiscoveryStatus() { return this.workload.portDiscoveryStatus(); }
  onPortsChanged(listener: Parameters<PreparedBoundary["onPortsChanged"]>[0]) { return this.workload.onPortsChanged(listener); }
  revoke(): Promise<void> { return this.lease.close(); }
  stopAndProve(): Promise<void> {
    this.retired = true; this.env = {};
    if (this.closing) return this.closing;
    const closing = (async () => {
      if (this.launches.size) throw new Error("Native cloud process retirement awaits a pending launch");
      // HOME and history cannot be released while native children can still
      // use them. The existing worker domain owns descendant retirement.
      await this.workload.stopAndProve();
      await this.history.release();
      await rm(this.view.directory, { recursive: true, force: true });
    })();
    this.closing = closing;
    void closing.catch(() => { if (this.closing === closing) this.closing = null; });
    return closing;
  }
}
