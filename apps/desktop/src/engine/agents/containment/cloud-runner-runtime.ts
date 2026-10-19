import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CloudRunnerBoundary } from "./cloud-runner-boundary";
import { cloudRunnerBaseSupported } from "./cloud-runner-base.mjs";
import { CloudRunnerNativeClient, verifyCloudRunnerManager, type CloudRunnerManagerProof } from "./cloud-runner-native";
import { parseCloudRunnerScope, type CloudRunnerScope } from "./cloud-runner-contract";
import { cloudOwnedRegistryFor, type CloudOwnedWorkloadRegistry } from "./cloud-owned-workloads";
import { nativeCloudWorkloadIO } from "./cloud-workload-cgroup.mjs";
import type { CloudExecutionBoundary } from "./cloud-execution-boundary";
import type { BoundaryProcess, PreparedBoundary } from "./types";

const unavailable = () => new Error("cloud_runner_manager_unavailable");
const runtimes = new WeakMap<CloudOwnedWorkloadRegistry, CloudRunnerRuntime>();
export function cloudRunnerForBoundary(workload: PreparedBoundary, assertCurrent: () => void): CloudRunnerBoundary | null {
  const runtime = runtimes.get(cloudOwnedRegistryFor(workload));
  return runtime ? runtime.boundary(workload, assertCurrent) : null;
}

/** The existing composed engine is the sole owner. A new base is required;
 * old bases and unnegotiated/Local engines never create a manager or driver. */
export async function startCloudRunnerRuntime(options: { boundary: CloudExecutionBoundary | null; negotiated: boolean;
  scope: Pick<CloudRunnerScope, "organizationId" | "workspaceId" | "generation" | "engineInstanceId" | "bootId" | "writerEpoch" | "runtimeId">;
  assertCurrent(): void; failed(): void }): Promise<CloudRunnerRuntime | null> {
  if (!options.boundary || !options.negotiated) return null;
  if (!cloudRunnerBaseSupported()) return null;
  if (runtimes.has(options.boundary.workloads)) throw unavailable();
  const runtime = new CloudRunnerRuntime(options as typeof options & { boundary: CloudExecutionBoundary });
  runtimes.set(options.boundary.workloads, runtime);
  try {
    await runtime.start(); options.assertCurrent();
    runtimes.set(options.boundary.workloads, runtime); return runtime;
  } catch {
    await runtime.stop().catch(() => {});
    throw unavailable();
  }
}

export class CloudRunnerRuntime {
  private scope!: Omit<CloudRunnerScope, "executionId">;
  private directory: string | null = null;
  private prepared: PreparedBoundary | null = null;
  private process: BoundaryProcess | null = null;
  private supervisor: { pid: number; startToken: string } | null = null;
  private proof: CloudRunnerManagerProof | null = null;
  private executable: { dev: string; ino: string } | null = null;
  private client: CloudRunnerNativeClient | null = null;
  private groupFd: number | null = null;
  private closed = false;
  private lost = false;
  private stopping: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private launchAttempted = false;
  private readonly boundaries = new Set<CloudRunnerBoundary>();
  constructor(private readonly options: { boundary: CloudExecutionBoundary;
    scope: Pick<CloudRunnerScope, "organizationId" | "workspaceId" | "generation" | "engineInstanceId" | "bootId" | "writerEpoch" | "runtimeId">;
    assertCurrent(): void; failed(): void }) {}
  private assertManager(): void {
    const custody = this.options.boundary.workloads.custody;
    if (!custody || !this.proof || !this.supervisor || !this.executable || this.lost) throw unavailable();
    custody.assertLive();
    verifyCloudRunnerManager(this.proof, { scope: this.scope, supervisor: this.supervisor, executable: this.executable });
  }
  private births(): readonly { pid: number; startToken: string }[] {
    this.assertManager();
    return [this.supervisor!, this.proof!.manager];
  }
  inspect(): CloudRunnerManagerProof {
    this.current(); this.assertManager(); return this.proof!;
  }
  start(): Promise<void> {
    if (this.closed || this.starting) return Promise.reject(unavailable());
    return this.starting = this.startManager();
  }
  private current(): void { if (this.closed) throw unavailable(); this.options.assertCurrent(); }
  private async startManager(): Promise<void> {
    const custody = this.options.boundary.workloads.custody;
    this.current();
    if (!custody || custody.controller.kind !== "engine") throw unavailable();
    custody.assertLive();
    const { executionId: _id, ...scope } = parseCloudRunnerScope({ version: 1, ...this.options.scope,
      executionId: randomUUID(), owner: { pid: custody.controller.pid, startToken: custody.controller.startToken }, workload: custody.entry.workload });
    this.scope = scope;
    const root = `/opt/zeros-infra/${scope.runtimeId}`;
    const binary = lstatSync(`${root}/bin/cloud-runner-bus`);
    if (!binary.isFile() || binary.isSymbolicLink() || ![0, 65534].includes(binary.uid) || (binary.mode & 0o7777) !== 0o555) throw unavailable();
    const executable = statSync("/usr/lib/systemd/systemd", { bigint: true });
    this.executable = { dev: String(executable.dev), ino: String(executable.ino) };
    this.directory = await mkdtemp("/tmp/zeros-runners-");
    await mkdir(`${this.directory}/claims`, { mode: 0o700 });
    await mkdir(`${this.directory}/journal`, { mode: 0o700 });
    this.current();
    this.prepared = await this.options.boundary.prepareOwned({ executionId: randomUUID(), actor: "repo-code-task", cwd: "/", workspaceRoot: "/" },
      { kind: "service", role: "infrastructure", coordinatorService: () => this.births() });
    this.current();
    this.launchAttempted = true;
    this.process = await this.prepared.spawn({ command: `${root}/bin/node`,
      args: [`${root}/worker/apps/desktop/src/engine/agents/containment/cloud-runner-manager.mjs`,
        this.directory, scope.bootId, scope.workload.dev, scope.workload.ino], cwd: "/",
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: "pipe" });
    this.process.stderr?.resume();
    void this.process.wait().then(() => this.failed(), () => this.failed());
    const supervisor = nativeCloudWorkloadIO.process(this.process.pid);
    if (!supervisor || supervisor.uid !== 10003) throw unavailable();
    this.supervisor = { pid: supervisor.pid, startToken: supervisor.startToken };
    const hint = await this.readHint(this.process);
    for (let attempts = 0; attempts < 200; attempts++) {
      if (this.closed || this.lost) throw unavailable();
      this.current(); custody.assertLive();
      try {
        this.proof = verifyCloudRunnerManager(hint, { scope, supervisor: this.supervisor, executable: this.executable });
        break;
      } catch { await delay(25); }
    }
    this.assertManager();
    const groupFd = openSync(this.proof!.group.directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
      const pinned = fstatSync(groupFd, { bigint: true });
      if (String(pinned.dev) !== this.proof!.group.dev || String(pinned.ino) !== this.proof!.group.ino) throw unavailable();
    } catch (error) {
      closeSync(groupFd);
      throw error;
    }
    // Only a validated descriptor may authorize failed-start retirement.
    this.groupFd = groupFd;
    this.client = new CloudRunnerNativeClient({ directory: this.directory, scope, proof: this.proof!, custody, assertManager: () => this.assertManager() });
    // Verify the actual private peer before publishing this backend. The
    // helper has no ordinary user/session bus fallback, including on failure.
    await this.client.ping();
    this.current(); this.assertManager();
  }
  private readHint(process: BoundaryProcess): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let pending = "", ended = false;
      const finish = (error?: Error, value?: unknown) => {
        if (ended) return; ended = true; clearTimeout(timer);
        process.stdout?.off("data", data); process.stdout?.off("error", fail); process.stdout?.off("end", fail);
        if (error) reject(error); else resolve(value);
      };
      const fail = () => finish(unavailable());
      const data = (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        if (Buffer.byteLength(pending) > 4096) { fail(); return; }
        const newline = pending.indexOf("\n");
        if (newline < 0) return;
        try { if (newline !== pending.length - 1) throw unavailable(); finish(undefined, JSON.parse(pending)); }
        catch { fail(); }
      };
      const timer = setTimeout(fail, 10_000); timer.unref();
      process.stdout?.on("data", data); process.stdout?.once("error", fail); process.stdout?.once("end", fail);
      if (!process.stdout || process.stdout.destroyed || process.stdout.readableEnded) fail();
    });
  }
  private failed(): void {
    this.lost = true;
    if (!this.closed) this.options.failed();
  }
  boundary(workload: PreparedBoundary, assertCurrent: () => void): CloudRunnerBoundary {
    if (this.closed || !this.client || !this.directory || this.boundaries.size >= 1024) throw unavailable();
    this.assertManager();
    const boundary = new CloudRunnerBoundary({ workload, scope: this.scope, client: this.client,
      journalDirectory: `${this.directory}/journal`, assertCurrent: () => {
        if (this.closed) throw unavailable(); this.options.assertCurrent(); this.assertManager(); assertCurrent();
      }, retired: () => this.boundaries.delete(boundary) });
    this.boundaries.add(boundary); return boundary;
  }
  /** Checkpoint drains keep this idle manager available. Engine Stop retires
   * all attached original units, joins control IO, then kills only the pinned
   * manager cgroup before its original Host transport. Unknown stays busy. */
  stop(): Promise<void> {
    this.closed = true;
    if (this.stopping) return this.stopping;
    const stop = (async () => {
      await this.starting?.catch(() => {});
      // A failed or lost startup hint cannot prove that the manager never
      // launched. Keep its Host scope/census unresolved for the root drain.
      if (this.launchAttempted && this.groupFd === null) throw unavailable();
      const results = await Promise.allSettled([...this.boundaries].map(boundary => boundary.stopAndProve()));
      if (results.some(result => result.status === "rejected")) throw unavailable();
      await this.client?.join();
      if (this.groupFd !== null) {
        const directory = `/proc/self/fd/${this.groupFd}`;
        if (fstatSync(this.groupFd).nlink) writeFileSync(`${directory}/cgroup.kill`, "1");
        let empty = false;
        for (let attempts = 0; attempts < 200 && !empty; attempts++) {
          empty = !fstatSync(this.groupFd).nlink || /(?:^|\n)populated 0(?:\n|$)/.test(readFileSync(`${directory}/cgroup.events`, "utf8"));
          if (!empty) await delay(25);
        }
        if (!empty) throw unavailable();
      }
      await this.prepared?.stopAndProve();
      if (this.groupFd !== null) { closeSync(this.groupFd); this.groupFd = null; }
      if (this.directory) await rm(this.directory, { recursive: true, force: true });
      this.directory = null; this.proof = null;
      if (runtimes.get(this.options.boundary.workloads) === this) runtimes.delete(this.options.boundary.workloads);
    })();
    this.stopping = stop;
    void stop.catch(() => { this.stopping = null; });
    return stop;
  }
}
