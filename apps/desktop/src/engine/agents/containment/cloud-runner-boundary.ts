import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { attachCloudOwnedNativeLifecycle, cloudOwnedRegistryFor, type CloudOwnedNativeLifecycle } from "./cloud-owned-workloads";
import { nativeCloudWorkloadIO, type CloudWorkloadKernelIO } from "./cloud-workload-cgroup.mjs";
import type { CloudWorkloadCustody } from "./cloud-workload-custody";
import { CloudRunnerLifecycle, type CloudRunnerDriver } from "./cloud-runner-lifecycle";
import { CloudRunnerPipes } from "./cloud-runner-pipes";
import type { CloudRunnerProof, CloudRunnerScope } from "./cloud-runner-contract";
import type { CloudRunnerNativeClient } from "./cloud-runner-native";
import type { BoundaryLaunchSpec, BoundaryProcess, BoundarySpawnRequest, PreparedBoundary } from "./types";

type Record = { descriptor: BoundaryLaunchSpec; life: CloudRunnerLifecycle; pipes: CloudRunnerPipes | null;
  process: BoundaryProcess | null; proof: CloudRunnerProof | null; phase: "wrapped" | "starting" | "running" | "stopping" | "failed";
  starting: Promise<unknown> | null; stopping: Promise<void> | null };
const unavailable = () => new Error("cloud_runner_authority_unavailable");
const key = (command: string, args: readonly string[]) => JSON.stringify([command, ...args]);

/** Read-only census of exact original unit inodes, including reparented and
 * double-forked children. No PID discovered here is signalling authority. */
export function cloudRunnerCensusRoots(groups: readonly CloudRunnerProof["cgroup"][], custody: CloudWorkloadCustody,
  io: CloudWorkloadKernelIO = nativeCloudWorkloadIO): readonly { pid: number; startToken: string }[] {
  const current = () => {
    custody.assertLive();
    for (const group of groups) {
      const actual = io.directory(group.directory);
      if (actual.dev !== group.dev || actual.ino !== group.ino || actual.filesystem !== 0x63677270 || actual.uid !== 10003) throw unavailable();
    }
  };
  current();
  const census = custody.inspect();
  if (!census.complete) throw unavailable();
  const members = census.processes.filter(member => groups.some(group => member.directory === group.directory || member.directory.startsWith(group.directory + "/")));
  if (members.length > 512 || members.some(member => member.uid !== 10003)) throw unavailable();
  current();
  return members.map(({ pid, startToken }) => ({ pid, startToken })).sort((a, b) => a.pid - b.pid);
}

/** One attachment per admitted provider boundary, with a fresh native UUID
 * per actual SDK child. Both synchronous callbacks and async spawn use it. */
export class CloudRunnerBoundary implements CloudOwnedNativeLifecycle {
  private readonly records = new Map<string, Record>();
  private closed = false;
  constructor(private readonly options: { workload: PreparedBoundary; scope: Omit<CloudRunnerScope, "executionId">;
    journalDirectory: string; client: CloudRunnerNativeClient; assertCurrent(): void; retired?(): void;
    createPipes?: (child: ChildProcess, record: CloudRunnerLifecycle, interrupted: () => void) => CloudRunnerPipes }) {
    attachCloudOwnedNativeLifecycle(options.workload, this);
  }
  private current(): void { if (this.closed) throw unavailable(); this.options.assertCurrent(); }
  snapshot() {
    const records = [...this.records.values()];
    return { complete: !records.some(record => record.phase === "failed"),
      pendingLaunches: records.filter(record => record.phase === "wrapped" || record.phase === "starting" || record.phase === "stopping").length,
      failedRetirements: records.filter(record => record.phase === "failed").length };
  }
  wrapSpawn(capture: () => BoundarySpawnRequest): BoundaryLaunchSpec {
    this.current();
    if (this.records.size >= 16) throw unavailable();
    const executionId = randomUUID(), { scope, client, workload } = this.options;
    const driver: CloudRunnerDriver = {
      start: async () => { if (!record.pipes) throw unavailable(); await record.pipes.start(); },
      inspect: intent => client.inspect(intent),
      connectPrivate: async (_intent, proof) => {
        if (!record.pipes) throw unavailable();
        return record.pipes.connect(proof);
      },
      retire: (intent, proof) => client.retire(intent, proof),
    };
    const current = () => { this.current(); if (record && !["starting", "running"].includes(record.phase)) throw unavailable(); };
    const life = new CloudRunnerLifecycle({ scope: { ...scope, executionId }, driver,
      journalDirectory: this.options.journalDirectory, assertAuthority: current,
      acquire: async signal => {
        current(); if (signal.aborted) throw unavailable();
        const request = capture();
        if (request.stdio === "inherit") throw unavailable();
        return { request: { command: request.command, args: [...request.args], cwd: request.cwd, env: { ...request.env } },
          assertCurrent: current, release: async () => {} };
      } });
    const root = `/opt/zeros-infra/${scope.runtimeId}`;
    const descriptor = workload.wrapSpawn({ command: `${root}/bin/node`,
      args: [`${root}/worker/apps/desktop/src/engine/agents/containment/cloud-runner-transport.mjs`, ...client.arguments(executionId)],
      cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: "pipe" });
    const record: Record = { descriptor, life, pipes: null, process: null, proof: null, phase: "wrapped", starting: null, stopping: null };
    this.records.set(key(descriptor.command, descriptor.args), record);
    return descriptor;
  }
  cancelUnstartedLaunch(descriptor: BoundaryLaunchSpec): void {
    const record = this.records.get(key(descriptor.command, descriptor.args));
    if (!record || record.descriptor !== descriptor || record.phase !== "wrapped") throw unavailable();
    this.options.workload.cancelUnstartedLaunch?.(descriptor);
    this.records.delete(key(descriptor.command, descriptor.args));
  }
  trackProcess(child: ChildProcess): BoundaryProcess {
    const record = this.records.get(JSON.stringify(child.spawnargs));
    if (!record || record.phase !== "wrapped" || child.spawnfile !== record.descriptor.command) throw unavailable();
    record.phase = "starting";
    // Host wait observes process exit. Capture close before any asynchronous
    // work so native retirement cannot tear down still-draining output pipes.
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    const interrupted = () => { void this.stopRecord(record).catch(() => {}); };
    record.pipes = this.options.createPipes?.(child, record.life, interrupted) ??
      new CloudRunnerPipes({ child, intent: record.life.launchIntent, interrupted,
        assertCurrent: () => {
          this.current();
          if (!["starting", "running"].includes(record.phase)) throw unavailable();
        } });
    const transport = record.process = this.options.workload.trackProcess(child);
    const starting = record.starting = record.life.launch().then(proof => {
      record.proof = proof;
      if (record.phase !== "starting" || this.closed) throw unavailable();
      record.phase = "running";
    });
    void starting.catch(interrupted);
    return { requiresOwnedSignals: true,
      get pid() { return record.proof?.pid ?? transport.pid; }, child,
      stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
      wait: async () => {
        await starting;
        const exit = await transport.wait();
        await closed;
        await this.stopRecord(record);
        return exit;
      },
      signal: () => this.stopRecord(record), stopAndProve: () => this.stopRecord(record) };
  }
  async spawn(capture: () => BoundarySpawnRequest): Promise<BoundaryProcess> {
    const descriptor = this.wrapSpawn(capture);
    const child = spawn(descriptor.command, [...descriptor.args], { cwd: descriptor.cwd, env: { ...descriptor.env }, detached: true, stdio: "pipe" });
    child.once("error", () => {});
    if (!child.pid) { this.cancelUnstartedLaunch(descriptor); throw unavailable(); }
    return this.trackProcess(child);
  }
  private stopRecord(record: Record): Promise<void> {
    if (!this.records.has(key(record.descriptor.command, record.descriptor.args))) return Promise.resolve();
    if (record.stopping) return record.stopping;
    record.phase = "stopping";
    record.pipes?.close();
    const stop = (async () => {
      await record.life.stop();
      await record.process?.stopAndProve();
      this.records.delete(key(record.descriptor.command, record.descriptor.args));
    })();
    record.stopping = stop;
    void stop.catch(() => { record.phase = "failed"; record.stopping = null; });
    return stop;
  }
  /** The Host registry first joins/cancels original untracked transports.
   * A late tracking callback then fails without ever submitting a unit. */
  async joinPending(): Promise<void> {
    await Promise.all([...this.records.values()].filter(record => record.phase !== "running").map(record => this.stopRecord(record)));
  }
  async stopAndProve(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.records.values()].map(record => this.stopRecord(record)));
    this.options.retired?.();
  }
  originalGroups(): readonly CloudRunnerProof["cgroup"][] {
    return this.originalProofs().map(proof => proof.cgroup);
  }
  originalProofs(): readonly CloudRunnerProof[] {
    return [...this.records.values()].flatMap(record => record.proof ? [record.proof] : []);
  }
  backgroundRoots(): readonly { pid: number; startToken: string }[] {
    this.current();
    const snapshot = this.snapshot(), custody = cloudOwnedRegistryFor(this.options.workload).custody;
    if (!custody || !snapshot.complete || snapshot.pendingLaunches) throw unavailable();
    return cloudRunnerCensusRoots(this.originalGroups(), custody);
  }
}
