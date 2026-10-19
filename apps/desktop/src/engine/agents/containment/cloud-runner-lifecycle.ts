import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync,
  renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertCloudRunnerRetired, cloudRunnerUnit, freezeCloudRunnerValue, parseCloudRunnerProof, parseCloudRunnerScope,
  type CloudRunnerIntent, type CloudRunnerProof, type CloudRunnerRetirement, type CloudRunnerScope } from "./cloud-runner-contract";

export interface CloudRunnerNativeRequest { command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>> }
export interface CloudRunnerMaterial {
  request: CloudRunnerNativeRequest;
  /** Exact funding/source/credential revision and finite deadline. */
  assertCurrent(): void;
  release(): Promise<void>;
}
export interface CloudRunnerPrivateChannel {
  /** Native backend verifies peer UID, PID/start token, canonical owner-only
   * socket/descriptor and current original cgroup before returning this. */
  proof: unknown;
  /** One bounded private frame, consumed once by this invocation. No argv,
   * unit Environment, stdout/stderr journal, retry, or secondary dispatch. */
  send(request: CloudRunnerNativeRequest, signal: AbortSignal): Promise<unknown>;
  close(): void;
}
export interface CloudRunnerDriver {
  /** Persist the root/native claim before submission. An unknown ACK does not
   * authorize resubmission. All operations need bounded, joined native IO. */
  start(intent: CloudRunnerIntent, unit: ReturnType<typeof cloudRunnerUnit>, signal: AbortSignal): Promise<void>;
  inspect(intent: CloudRunnerIntent): Promise<{ state: "running" | "exited"; proof: unknown } | { state: "unknown" }>;
  connectPrivate(intent: CloudRunnerIntent, proof: CloudRunnerProof, signal: AbortSignal): Promise<CloudRunnerPrivateChannel>;
  /** Uses original native custody, including a lost start ACK. Refuse a reused
   * unit/PID. Join the original start and prove all its cgroup members gone. */
  retire(intent: CloudRunnerIntent, proof: CloudRunnerProof | null): Promise<CloudRunnerRetirement>;
}
type Phase = "starting" | "handoff" | "running" | "retiring" | "retired" | "interrupted";
const authorityError = () => new Error("cloud_runner_authority_unavailable");
const journalError = () => new Error("cloud_runner_journal_unavailable");
const MAX_PRIVATE_BYTES = 64 * 1024;

function synchronous(check: () => void): void {
  let result: unknown;
  try { result = check(); } catch { throw authorityError(); }
  if (result !== undefined) {
    if (result && (typeof result === "object" || typeof result === "function") && "then" in result)
      void Promise.resolve(result).catch(() => {});
    throw authorityError();
  }
}
function nativeRequest(value: CloudRunnerNativeRequest): CloudRunnerNativeRequest {
  if (!value || Object.keys(value).sort().join(",") !== "args,command,cwd,env" ||
    ![value.command, value.cwd].every(item => typeof item === "string" && path.isAbsolute(item) && !/[\0\r\n]/.test(item)) ||
    !Array.isArray(value.args) || value.args.length > 1024 || value.args.some(item => typeof item !== "string" || item.includes("\0")) ||
    !value.env || typeof value.env !== "object" || Array.isArray(value.env) ||
    Object.entries(value.env).some(([name, item]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || typeof item !== "string" || item.includes("\0")) ||
    Buffer.byteLength(JSON.stringify(value)) > MAX_PRIVATE_BYTES) throw authorityError();
  return freezeCloudRunnerValue(value);
}

/** A private durable no-replay receipt, containing identity/phase only. It is
 * not a continuation principal or an invitation to adopt work after restart. */
class RunnerJournal {
  private readonly directoryIdentity;
  private previous: string | null = null;
  readonly file: string;
  constructor(private readonly directory: string, executionId: string) {
    try {
      const stat = this.directoryIdentity = lstatSync(directory);
      if (!path.isAbsolute(directory) || realpathSync(directory) !== directory || !stat.isDirectory() || stat.isSymbolicLink() ||
        stat.uid !== process.geteuid?.() || (stat.mode & 0o7777) !== 0o700) throw journalError();
      this.file = path.join(directory, `${executionId}.json`);
    } catch { throw journalError(); }
  }
  private assertDirectory(): void {
    const stat = lstatSync(this.directory), original = this.directoryIdentity;
    if (realpathSync(this.directory) !== this.directory || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== original.dev ||
      stat.ino !== original.ino || stat.uid !== original.uid || (stat.mode & 0o7777) !== 0o700) throw journalError();
  }
  private syncDirectory(): void {
    const descriptor = openSync(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
  private read(): string {
    const descriptor = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid?.() || (stat.mode & 0o7777) !== 0o600 ||
        stat.size < 2 || stat.size > 16 * 1024) throw journalError();
      const bytes = Buffer.alloc(16 * 1024 + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(descriptor, bytes, size, bytes.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size !== stat.size || size > 16 * 1024) throw journalError();
      return bytes.subarray(0, size).toString("utf8");
    } finally { closeSync(descriptor); }
  }
  write(intent: CloudRunnerIntent, phase: Phase, proof: CloudRunnerProof | null, reserve = false): void {
    const encoded = JSON.stringify({ version: 1, intent, phase, proof });
    if (Buffer.byteLength(encoded) > 16 * 1024) throw journalError();
    this.assertDirectory();
    if (!reserve && (this.previous === null || this.read() !== this.previous)) throw journalError();
    const file = reserve ? this.file : `${this.file}.${randomUUID()}.tmp`;
    let descriptor: number;
    try { descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (reserve && (error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("cloud_runner_recovery_required");
      throw journalError();
    }
    let failed = false;
    try {
      writeFileSync(descriptor, encoded); fsyncSync(descriptor); this.assertDirectory();
      if (!reserve) renameSync(file, this.file);
      this.syncDirectory(); this.previous = encoded;
    } catch { failed = true;
    } finally {
      try { closeSync(descriptor); } catch { failed = true; }
      if (!reserve) { try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true; } }
    }
    if (failed) throw journalError();
  }
}

/** Dormant contract: no production factory selects this yet. A qualified
 * backend must keep units inside the existing Host resource/census/drain tree.
 * Local and legacy cloud still use their original Host implementation. */
export class CloudRunnerLifecycle {
  private readonly intent: CloudRunnerIntent;
  private readonly journal: RunnerJournal;
  private readonly cancellation = new AbortController();
  private phase: Phase | null = null;
  private proof: CloudRunnerProof | null = null;
  private channel: CloudRunnerPrivateChannel | null = null;
  private material: CloudRunnerMaterial | null = null;
  private flight: Promise<CloudRunnerProof> | null = null;
  private preparing: Promise<void> | null = null;
  private connecting: Promise<CloudRunnerPrivateChannel> | null = null;
  private acquiring: Promise<CloudRunnerMaterial> | null = null;
  private retiring: Promise<void> | null = null;
  private queued = false;
  private submitted = false;
  private stopping = false;
  private recovery = false;
  private outcome: "retired" | "interrupted" = "retired";
  constructor(private readonly options: { scope: CloudRunnerScope; journalDirectory: string; driver: CloudRunnerDriver;
    assertAuthority(): void; acquire(signal: AbortSignal): Promise<CloudRunnerMaterial> }) {
    this.intent = freezeCloudRunnerValue({ version: 1, attemptId: randomUUID(), scope: parseCloudRunnerScope(options.scope) });
    this.journal = new RunnerJournal(options.journalDirectory, this.intent.scope.executionId);
  }
  busy(): boolean { return this.queued || this.recovery || this.phase !== null && !["retired", "interrupted"].includes(this.phase); }
  private current(): void {
    if (this.stopping) throw authorityError();
    synchronous(() => this.options.assertAuthority());
    if (this.stopping) throw authorityError();
    if (this.material) synchronous(() => this.material!.assertCurrent());
    if (this.stopping) throw authorityError();
  }
  private persist(phase: Phase, reserve = false): void {
    try { this.journal.write(this.intent, phase, this.proof, reserve); this.phase = phase; }
    catch (error) {
      if (error instanceof Error && error.message === "cloud_runner_recovery_required") throw error;
      throw journalError();
    }
  }
  launch(): Promise<CloudRunnerProof> {
    if (this.stopping) return Promise.reject(new Error("cloud_runner_interrupted"));
    if (this.flight) return this.flight;
    this.queued = true;
    return this.flight = Promise.resolve().then(() => this.launchOnce()).finally(() => { this.queued = false; });
  }
  private async launchOnce(): Promise<CloudRunnerProof> {
    this.current();
    try { this.persist("starting", true); }
    catch (error) { this.recovery = true; throw error; }
    const driver = this.options.driver;
    this.preparing = Promise.resolve().then(async () => {
      this.current(); this.submitted = true;
      // Even an explicit error can conceal a submitted systemd job. Inspect
      // exactly once; never resend StartTransientUnit after an unknown ACK.
      try { await driver.start(this.intent, cloudRunnerUnit(this.intent.scope.executionId), this.cancellation.signal); } catch { /* unknown start */ }
      const observed = await driver.inspect(this.intent);
      if (observed.state === "unknown") throw authorityError();
      this.proof = parseCloudRunnerProof(observed.proof, this.intent);
      if (observed.state !== "running") { this.outcome = "interrupted"; throw authorityError(); }
    });
    try {
      await this.preparing; this.current();
      this.connecting = Promise.resolve().then(() => driver.connectPrivate(this.intent, this.proof!, this.cancellation.signal)).then(channel => {
        this.channel = channel; if (this.stopping) this.closeChannel(); return channel;
      });
      const channel = await this.connecting; this.current();
      parseCloudRunnerProof(channel.proof, this.intent, this.proof!);
      this.acquiring = Promise.resolve().then(() => this.options.acquire(this.cancellation.signal)).then(material => { this.material = material; return material; });
      const material = await this.acquiring; this.current();
      const request = nativeRequest(material.request);
      this.persist("handoff"); this.current();
      const ack = await channel.send(request, this.cancellation.signal); this.current();
      parseCloudRunnerProof(ack, this.intent, this.proof!);
      this.persist("running"); return this.proof!;
    } catch {
      await this.stop().catch(() => {});
      throw authorityError();
    }
  }
  private closeChannel(): void {
    const channel = this.channel; this.channel = null;
    try { channel?.close(); } catch { /* Native retirement still has to prove the original unit empty. */ }
  }
  async observe(): Promise<"starting" | "running" | "interrupted"> {
    if (this.stopping) return "interrupted";
    try {
      this.current();
      if (this.queued) return "starting";
      if (this.phase !== "running") throw authorityError();
      const observed = await this.options.driver.inspect(this.intent); this.current();
      if (observed.state === "unknown" || !this.proof) throw authorityError();
      parseCloudRunnerProof(observed.proof, this.intent, this.proof);
      if (observed.state === "running") return "running";
      this.outcome = "interrupted"; await this.stop(); return "interrupted";
    } catch {
      this.outcome = "interrupted"; await this.stop().catch(() => {}); throw authorityError();
    }
  }
  stop(): Promise<void> {
    this.stopping = true; this.cancellation.abort(); this.closeChannel();
    if (this.recovery) return Promise.reject(new Error("cloud_runner_recovery_required"));
    if (this.phase === null || this.phase === "retired" || this.phase === "interrupted") return Promise.resolve();
    if (this.retiring) return this.retiring;
    const flight = (async () => {
      await this.preparing?.catch(() => {});
      this.phase = "retiring";
      // A full disk or damaged receipt must never prevent revocation from
      // retiring the original native unit. Final persistence is still required
      // before reporting this record clean; uncertainty cannot authorize replay.
      try { this.persist("retiring"); } catch { /* Always attempt native retirement. */ }
      // No native operation was invoked. Once submitted, even a synchronous
      // rejection needs positive retirement of the original native custody.
      if (!this.submitted) { this.persist(this.outcome); return; }
      const retirement = Promise.resolve().then(() => this.options.driver.retire(this.intent, this.proof));
      const results = await Promise.allSettled([retirement, this.connecting, this.acquiring]);
      this.closeChannel();
      if (results[0]!.status !== "fulfilled") throw new Error("cloud_runner_retirement_unproven");
      assertCloudRunnerRetired(results[0]!.value, this.intent, this.proof);
      try { await this.material?.release(); } catch { throw new Error("cloud_runner_retirement_unproven"); }
      this.material = null;
      this.persist(this.outcome);
    })();
    this.retiring = flight;
    void flight.finally(() => { if (this.retiring === flight) this.retiring = null; }).catch(() => {});
    return flight;
  }
}
