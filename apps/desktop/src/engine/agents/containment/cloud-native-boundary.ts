import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import {isCloudAgentAdmissionCode,type CloudAgentAccessMaterial} from "@zeros/protocol/cloud-agent-execution";
import {CloudCommandFailureError,decodeCloudCommandFailure,type CloudCommandFailureCause} from "@zeros/protocol/cloud-commands";
import type { CloudAgentLease } from "../cloud-agent-lease";
import { assertCloudBootNativeLaunch, assertCloudBootNativePreparation, isCloudBootNativeAuthority, type CloudBootNativeAuthority,
  type CloudAgentExecutionLifetime, type CloudAgentExecutionAuth } from "../cloud-provider-execution";

import { zerosDataDir } from "../../db/paths";
import { CLOUD_CODEX_STATE_DIRECTORIES, CLOUD_NATIVE_SKILL_HOMES, createCloudNativeHome, type CloudNativeHome } from "./cloud-native-home";
import { assertCloudPreparedBoundaryLive, cloudPreparedBoundaryRequest } from "./cloud-execution-boundary";
import { resolveCloudRuntime } from "./cloud-runtime-root.mjs";
import { acquireCloudNativeHistory, CLOUD_NATIVE_HISTORY_ROOT } from "./cloud-native-history";
import { loadCloudWorkerConfiguration } from "./cloud-worker-config";
import type { BoundaryLaunchSpec, BoundaryProcess, BoundarySpawnRequest, PortRequest, PreparedBoundary } from "./types";
import {hasCloudBackgroundServers} from "./cloud-background-processes";
import { cloudComputerExecutionHistory, cloudComputerProcessEnvironment } from "../cloud-computer-environment";

import { cloudGitAuthorEnvironment } from "../../git/cloud-git-author";
import { createNativeGithubBroker } from "../../git/github-native-broker";
import { materializeCloudSkills } from "../cloud-skills";

type NativeOwner = Pick<CloudAgentLease,"customization"|"environment"|"gitAuthor"> & {
  provider:CloudAgentLease["admission"]["provider"]; model:string;
  lifetime:CloudAgentExecutionLifetime; auth:CloudAgentExecutionAuth;
};
function nativeOwner(authority:CloudAgentLease|CloudBootNativeAuthority):NativeOwner{
  return isCloudBootNativeAuthority(authority)?authority:{
    provider:authority.admission.provider,model:authority.admission.model,
    customization:authority.customization??null,environment:authority.environment??null,gitAuthor:authority.gitAuthor??null,
    lifetime:authority,auth:authority,
  };
}

const STARTUP_ENV = new Set(["CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS", "CLAUDE_CODE_STARTUP_FAILURE_RESULTS", "NODE_USE_ENV_PROXY"]);
const SDK_METADATA_ENV={CLAUDE_CODE_ENTRYPOINT:"sdk-ts"} as const;
function containmentFailure(error:unknown,category:CloudCommandFailureCause["category"]):Error{
  const code=error&&typeof error==="object"&&("code" in error)?error.code:undefined;
  const cause=decodeCloudCommandFailure(code);
  if(cause)return new CloudCommandFailureError(cause);
  if(isCloudAgentAdmissionCode(code))return Object.assign(new Error("Cloud agent authority changed"),{code});
  return new CloudCommandFailureError({stage:"containment",category});
}
/** Build only the captured provider environment. Plain per-conversation paths
 * organize native state; processes still share the engine's VM identity. */
export function cloudNativeProviderEnvironment(material: CloudAgentAccessMaterial, model: string,
  settings: Record<string, string> | undefined, values: Record<string, string> | undefined,
  nativeHome: CloudNativeHome): Record<string, string> {
  if (typeof model !== "string" || model.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/.test(model))
    throw new Error("Invalid cloud provider model");
  const runtime = resolveCloudRuntime();
  const env: Record<string,string> = { PATH: `${runtime.binRoot}:/usr/local/bin:/usr/bin:/bin`,
    LANG: "C.UTF-8", SHELL: "/bin/bash", ZEROS_REQUIRE_EXACT_MODEL: "1", ...nativeHome.environment() };
  if (["low","medium","high","xhigh","max","ultracode"].includes(settings?.ZEROS_THINKING_EFFORT ?? "")) env.ZEROS_THINKING_EFFORT = settings!.ZEROS_THINKING_EFFORT!;
  if (["auto","auto-edit","ask","default","accept-edits","plan","bypass","agent","full-access","read-only"].includes(settings?.ZEROS_PERMISSION_MODE ?? "")) env.ZEROS_PERMISSION_MODE = settings!.ZEROS_PERMISSION_MODE!;
  if (settings?.ZEROS_FAST_MODE === "1" || settings?.ZEROS_FAST_MODE === "0") env.ZEROS_FAST_MODE = settings.ZEROS_FAST_MODE;
  switch (material.kind) {
    case "claude-api-key": env.ANTHROPIC_API_KEY = material.apiKey; break;
    case "claude-setup-token": env.CLAUDE_CODE_OAUTH_TOKEN = material.accessToken; break;
    case "cursor-api-key": env.CURSOR_API_KEY = material.apiKey; break;
    case "codex-api-key": env.OPENAI_API_KEY = material.apiKey; break;
    case "codex-chatgpt": break; // Native external login remains the sole account source.
    default: throw new Error("Invalid cloud provider credential");
  }
  if (material.kind.startsWith("claude-")) { env.ANTHROPIC_MODEL = model; env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"; }
  else if (material.kind.startsWith("cursor-")) { env.CURSOR_MODEL = model; env.ZEROS_CURSOR_STATE_ROOT = `${nativeHome.paths.cursorHome}/zeros-store`; }
  else env.OPENAI_MODEL = model;
  return cloudComputerProcessEnvironment(env, values, "agent");
}

/** Initialize empty physical Cursor config for native discovery fixtures.
 * These directories are ordinary state, not immutable filesystem mounts. */
export async function prepareCloudCursorConfigView(directory: string): Promise<void> {
  for(const name of ["","/zeros-store","/skills"]){
    await mkdir(`${directory}/cursor-config${name}`,{mode:0o755});
    await chmod(`${directory}/cursor-config${name}`,0o755);
  }
}

/** Populate ordinary provider discovery folders for organization skills. */
export async function prepareCloudSkillHomes(directory: string, provider: string, _uid: number, _gid: number): Promise<void> {
  for (const home of CLOUD_NATIVE_SKILL_HOMES) {
    if (home === `.${provider}`) continue;
    await mkdir(`${directory}/home/${home}`, { mode: 0o700, recursive: true });
  }
}

function nativeTranscriptDirectory(home: CloudNativeHome, provider: NativeOwner["provider"]): string {
  return provider === "claude" ? `${home.paths.claudeConfigDir}/projects` :
    provider === "cursor" ? `${home.paths.cursorHome}/zeros-store` : `${home.paths.codexHome}/sessions`;
}

export class CloudNativeBoundary implements PreparedBoundary {
  readonly generation;
  readonly status;
  readonly attestation;
  get providerHomePath() { return this.nativeHome.paths.home; }
  private readonly owner:NativeOwner;
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
    private readonly authority: CloudAgentLease|CloudBootNativeAuthority,
    readonly workload: PreparedBoundary,
    readonly nativeHome: CloudNativeHome,
    private env: Record<string, string>,
    private readonly history: Awaited<ReturnType<typeof acquireCloudNativeHistory>>,
  ) {
    this.owner=nativeOwner(authority);
    Object.assign(this.env, cloudGitAuthorEnvironment(this.owner.gitAuthor ?? null));
    this.generation = workload.generation;
    this.status = workload.status;
    this.attestation = workload.attestation;
  }

  static async prepare(lease: CloudAgentLease, workload: PreparedBoundary, conversationId: string,
    settings?: Record<string, string>): Promise<CloudNativeBoundary> {
    return CloudNativeBoundary.prepareAuthority(lease,workload,conversationId,settings);
  }
  static async prepareBoot(authority:CloudBootNativeAuthority,workload:PreparedBoundary,conversationId:string,
    settings?:Record<string,string>):Promise<CloudNativeBoundary>{
    assertCloudBootNativePreparation(authority,workload,conversationId);
    return CloudNativeBoundary.prepareAuthority(authority,workload,conversationId,settings);
  }
  private static async prepareAuthority(authority:CloudAgentLease|CloudBootNativeAuthority,workload:PreparedBoundary,conversationId:string,
    settings?:Record<string,string>):Promise<CloudNativeBoundary>{
    const owner=nativeOwner(authority),lease=owner.lifetime;
    const configuration = loadCloudWorkerConfiguration();
    if (configuration?.version !== 4 || configuration.uid !== process.geteuid?.() || configuration.gid !== process.getegid?.())
      throw new Error("Native cloud agents require the current engine deployment");
    assertCloudPreparedBoundaryLive(workload);
    const admitted = cloudPreparedBoundaryRequest(workload);
    const executionId = isCloudBootNativeAuthority(authority) ? authority.executionId : authority.admission.executionId;
    if (executionId !== admitted.executionId) throw new Error("Native cloud execution identity does not match its workload");
    const assertLive = () => { lease.assertLive(); assertCloudPreparedBoundaryLive(workload); };
    assertLive();
    try { await workload.attestation; }
    catch(error) { throw containmentFailure(error,"attestation_failed"); }
    assertLive();
    const nativeHome = await createCloudNativeHome({ dataRoot: zerosDataDir(), conversationId, provider: owner.provider, executionId });
    let history: Awaited<ReturnType<typeof acquireCloudNativeHistory>> | undefined;
    let boundary: CloudNativeBoundary | undefined;
    try {
      if (owner.customization && !owner.customization.history) throw new Error("Cloud customization history requires an updated control plane and runtime.");
      history = await acquireCloudNativeHistory({ root: CLOUD_NATIVE_HISTORY_ROOT, conversationId,
        provider: owner.provider, uid: configuration.uid, gid: configuration.gid, nativeHome,
        customization: cloudComputerExecutionHistory(owner) });
      assertLive();
      const transcript = nativeTranscriptDirectory(nativeHome, owner.provider);
      await mkdir(transcript, { mode: 0o700 });
      await history.bind(transcript);
      if (owner.provider === "codex") {
        for (const name of CLOUD_CODEX_STATE_DIRECTORIES) await mkdir(`${nativeHome.paths.codexHome}/${name}`, { mode: 0o700 });
        await writeFile(`${nativeHome.paths.codexHome}/installation_id`, randomUUID(), { flag: "wx", mode: 0o600 });
      }
      if (owner.customization) {
        await materializeCloudSkills(nativeHome.paths.directory, owner.customization.skills);
        await prepareCloudSkillHomes(nativeHome.paths.directory, owner.provider, configuration.uid, configuration.gid);
        for (const home of CLOUD_NATIVE_SKILL_HOMES) if (home !== ".codex")
          await cp(`${nativeHome.paths.directory}/skills`, `${nativeHome.paths.home}/${home}/skills`, { recursive: true, errorOnExist: true, force: false });
      }
      assertLive();
      const env = cloudNativeProviderEnvironment(authority.takeMaterial(), owner.model, settings, owner.environment?.values, nativeHome);
      for (const key of Object.keys(env)) if (/^(GH_|GITHUB_)/.test(key)) delete env[key];
      const githubDirectory = `${nativeHome.paths.home}/.zeros-github`;
      const github = await createNativeGithubBroker({ directory: githubDirectory, visibleDirectory: githubDirectory,
        cwd: admitted.cwd, path: env.PATH!, node: configuration.toolchain.node, identity: configuration,
        source: isCloudBootNativeAuthority(authority) ? {kind:"boot-agent",contextId:authority.contextId} : {kind:"agent",leaseId:authority.leaseId}, signal: lease.signal,
        authorized: () => { try { assertLive(); return true; } catch { return false; } } });
      lease.attach(github); Object.assign(env, github.env);
      assertLive();
      boundary = new CloudNativeBoundary(authority, workload, nativeHome, env, history);
      lease.attach(boundary);
      if(isCloudBootNativeAuthority(authority))assertCloudBootNativePreparation(authority,workload,conversationId);
      else await authority.validate();
      assertLive();
      return boundary;
    } catch (error) {
      void lease.close().catch(() => {});
      if (!boundary) { await history?.release(); await rm(nativeHome.paths.directory, { recursive: true, force: true }); }
      throw error;
    }
  }

  private assertLive(): void {
    if (this.retired) throw new Error("Native cloud provider is retired");
    this.owner.lifetime.assertLive();
    assertCloudPreparedBoundaryLive(this.workload);
  }
  environment(): Record<string, string> { this.assertLive(); return { ...this.env }; }
  codexExternalAuth(): Extract<CloudAgentAccessMaterial, { kind: "codex-chatgpt" }> | null {
    this.assertLive(); return this.owner.auth.codexAuth()?.material ?? null;
  }
  private request(request: BoundarySpawnRequest): BoundarySpawnRequest {
    this.assertLive();
    const env = { ...this.env };
    for (const name of STARTUP_ENV) if (request.env[name] === "1") env[name] = "1";
    for(const [name,value] of Object.entries(SDK_METADATA_ENV))if(request.env[name]===value)env[name]=value;
    return { command: request.command, args: request.args, cwd: request.cwd,
      env, stdio: request.stdio };
  }
  wrapSpawn(request: BoundarySpawnRequest): BoundaryLaunchSpec {
    this.assertLive();
    if(isCloudBootNativeAuthority(this.authority))assertCloudBootNativeLaunch(this.authority);
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
      void this.owner.lifetime.close().catch(() => {}); throw new Error("Native cloud launch identity is invalid");
    }
    const tracked = this.workload.trackProcess(child);
    this.observeProcess(tracked);
    this.launches.delete(key);
    this.owner.lifetime.attach(tracked); this.assertLive(); return tracked;
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
    if(isCloudBootNativeAuthority(this.authority))assertCloudBootNativeLaunch(this.authority);
    const process=await this.owner.lifetime.launch(() => {
      if(isCloudBootNativeAuthority(this.authority))assertCloudBootNativeLaunch(this.authority);
      return this.workload.spawn(this.request(request));
    });
    this.observeProcess(process);return process;
  }
  requestPort(request: PortRequest) { this.assertLive(); return this.workload.requestPort(request); }
  activePorts() { return this.workload.activePorts(); }
  portDiscoveryStatus() { return this.workload.portDiscoveryStatus(); }
  onPortsChanged(listener: Parameters<PreparedBoundary["onPortsChanged"]>[0]) { return this.workload.onPortsChanged(listener); }
  revoke(): Promise<void> { return this.owner.lifetime.close(); }
  stopAndProve(): Promise<void> {
    this.retired = true; this.env = {};
    if (this.closing) return this.closing;
    const closing = (async () => {
      if (this.launches.size) throw new Error("Native cloud process retirement awaits a pending launch");
      // Transcript writes already reach durable history. Keep its lock and
      // execution HOME until the original Host group proof has completed.
      await this.workload.stopAndProve();
      await this.history.release();
      await rm(this.nativeHome.paths.directory, { recursive: true, force: true });
    })();
    this.closing = closing;
    void closing.catch(() => { if (this.closing === closing) this.closing = null; });
    return closing;
  }
}
