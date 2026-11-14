import { randomBytes, randomUUID } from "node:crypto";
import type { CloudV2Compute } from "./boat.js";
import { BoatBootPendingError, BoatCreateRejectedError } from "./boat-client.js";
import { CLOUD_V2_CHECKPOINT_SECONDS, cloudV2CheckpointObject, parseCheckpointResult, parseRestoreResult,
  restoreCommand } from "./checkpoint.js";
import { CLOUD_V2_HOME, deliverWorkerTokenCommand, type CloudV2LifecycleDeps } from "./lifecycle.js";
import { CLOUD_V2_WORKER_PORT } from "./contract.js";
import { GIT_LFS_INSTALL_COMMAND } from "./computer.js";
import { pruneCloudRepositories } from "./source-authority.js";
import { installRuntimeCommand, type CloudV2Runtime } from "./runtime.js";
import { newCloudV2Token } from "./tokens.js";
import type { CloudV2LifecycleWorkspace } from "./store.js";
import { CloudRecoveryStore, RECOVERY_WAIT_MS, RECOVERY_RETENTION_MS, type RecoveryAttempt } from "./recovery-store.js";
import { recoveryCheckpointCommand, recoveryShutdownCommand, recoveryShutdownResult } from "./recovery-command.js";

const STEP_LEASE_MS = (CLOUD_V2_CHECKPOINT_SECONDS + 180) * 1000;
const UPLOAD_HORIZON_MS = 25 * 60_000;
const SEAL_WAIT_MS = 90_000;
const SCAN_MS = 60_000;
const fail = (code: string) => Object.assign(new Error(code), { code });
const terminal = (a: RecoveryAttempt) => a.completed_at !== null;
const reason = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "recovery_failed";
};

export type CloudRecoveryDeps = {
  store: CloudRecoveryStore;
  compute: CloudV2Compute;
  runtime: CloudV2Runtime;
  publicKeys: readonly string[];
  checkpoints: NonNullable<CloudV2LifecycleDeps["checkpoints"]>;
  authorize(workspace: CloudV2LifecycleWorkspace): Promise<void>;
  githubToken(workspace: CloudV2LifecycleWorkspace): Promise<{ token: string }>;
  bootEnv(workspace: CloudV2LifecycleWorkspace, runtime: CloudV2Runtime): Promise<Record<string, string>>;
  sandboxName(workspace: CloudV2LifecycleWorkspace, attempt: string): string;
  sealToken(token: string, workspaceId: string): unknown;
  openToken(envelope: unknown, workspaceId: string): string;
  ready(workspace: CloudV2LifecycleWorkspace, attempt: RecoveryAttempt): Promise<boolean>;
  logger?: Pick<Console, "warn">;
  now?: () => number;
};

export class CloudRecovery {
  private timer: NodeJS.Timeout | undefined;
  private closed = true;
  private scanning = false;
  private notified = false;
  private scan: Promise<void> | undefined;
  private readonly flights = new Map<string, Promise<void>>();
  constructor(readonly deps: CloudRecoveryDeps) {}
  private now() { return this.deps.now?.() ?? Date.now(); }

  start(): () => Promise<void> {
    this.closed = false; this.schedule(0);
    return async () => {
      this.closed = true; clearTimeout(this.timer); await this.scan; await Promise.all(this.flights.values());
    };
  }
  wake(): void {
    if (this.closed) return;
    if (this.scanning) this.notified = true;
    else this.schedule(0);
  }
  private schedule(ms: number) {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.scan = this.poll(); }, ms); this.timer.unref();
  }
  private async poll(): Promise<void> {
    this.scanning = true;
    let next = SCAN_MS;
    try {
      for (const row of await this.deps.store.due(8)) {
        if (this.flights.has(row.id)) continue;
        next = Math.min(next, Math.max(1000, row.delay));
        if (row.delay > 0 || this.flights.size >= 2) continue;
        const flight = this.run(row.id).catch(() => this.log(undefined, "recovery_poll_failed"))
          .finally(() => { this.flights.delete(row.id); this.wake(); });
        this.flights.set(row.id, flight);
      }
    } catch { this.log(undefined, "recovery_poll_failed"); }
    this.scanning = false;
    this.schedule(this.notified ? 0 : next); this.notified = false;
  }
  private log(id: string | undefined, code: string) {
    this.deps.logger?.warn("[cloud-v2] recovery", { workspaceId: id?.slice(0, 8), reason: code });
  }
  private async current(a: RecoveryAttempt): Promise<CloudV2LifecycleWorkspace> {
    const w = await this.deps.store.workspace(a.id, a.lease_id!, STEP_LEASE_MS);
    if (!w) throw fail("recovery_binding_changed");
    await this.deps.authorize(w);
    return w;
  }
  private async read(id: string): Promise<RecoveryAttempt> {
    const a = await this.deps.store.read(id); if (!a) throw fail("recovery_binding_changed"); return a;
  }

  async run(id: string): Promise<void> {
    const { store } = this.deps, a = await store.claim(id, STEP_LEASE_MS);
    if (!a?.lease_id) return;
    let delay = terminal(a) ? SCAN_MS : 2000;
    try {
      if (terminal(a)) { delay = await this.cleanup(a); return; }
      if (a.deadline_at.getTime() <= this.now()) throw fail("recovery_deadline");
      const w = await this.current(a);
      switch (a.phase) {
        case "waiting":
          if (this.now() - a.created_at.getTime() >= RECOVERY_WAIT_MS) throw fail("recovery_busy");
          if (!await store.canFence(id)) return;
          await this.deps.githubToken(w); await this.current(a);
          await store.fence(id); return;
        case "sealing":
          if (this.now() - a.updated_at.getTime() >= SEAL_WAIT_MS) throw fail("recovery_seal_unconfirmed");
          return;
        case "sealed":
          await this.deps.githubToken(w); await this.current(a);
          await store.startCapture(id, a.lease_id); return;
        case "capturing": await this.capture(a, w); return;
        case "restoring": await this.restore(a, w); return;
        case "booting": await this.boot(a, w); return;
        case "verifying":
          if (a.first_error_code) throw fail(a.first_error_code);
          if (!a.replacement_boot_id) throw fail("recovery_binding_changed");
          if (!a.worker_ready_at && await this.deps.ready(w, a)) {
            await this.current(a); await store.ready(id, a.lease_id, a.replacement_boot_id);
          }
          await store.succeed(id, a.lease_id); return;
      }
    } catch (error) {
      // A confirmed fresh VM may still be booting. No credential has been
      // sent yet; only that closed provider outcome permits this retry.
      if (error instanceof BoatBootPendingError) delay = 2000;
      else {
        this.log(a.workspace_id, reason(error));
        if (!terminal(a)) await store.fail(id, reason(error), a.lease_id);
        delay = SCAN_MS;
      }
    } finally { await store.defer(id, a.lease_id, delay); }
  }

  private async capture(a: RecoveryAttempt, w: CloudV2LifecycleWorkspace) {
    const { store, compute, checkpoints } = this.deps;
    const binding = { id: a.id, bootId: a.source_boot_id, deadline: a.deadline_at.getTime() };
    if (a.checkpoint_object) throw fail("recovery_capture_unconfirmed");
    if (!a.source_stopped_at) {
      const stopped = await compute.exec(a.source_sandbox_id, recoveryShutdownCommand(binding), 90);
      await this.current(a);
      if (!recoveryShutdownResult(stopped) || !await store.stopped(a.id, a.lease_id!)) throw fail("recovery_shutdown_unconfirmed");
    }
    const object = cloudV2CheckpointObject(w.id, randomUUID()), key = randomBytes(32);
    try {
      if (!await store.upload(a.id, a.lease_id!, { object, key: checkpoints.seal(key, w.id, object), until: new Date(this.now() + UPLOAD_HORIZON_MS) }))
        throw fail("recovery_binding_changed");
      const command = recoveryCheckpointCommand({ ...binding, checkoutPath: `${CLOUD_V2_HOME}/${w.repository}`, home: CLOUD_V2_HOME,
        baseBranch: w.baseBranch, key, uploadUrl: await checkpoints.storage.uploadUrl(w.id, object) });
      await this.current(a);
      const result = await compute.exec(a.source_sandbox_id, command, CLOUD_V2_CHECKPOINT_SECONDS);
      const saved = parseCheckpointResult(result.stdout);
      await this.current(a);
      if (!saved.ok || saved.unchanged || result.exitCode !== 0 || result.timedOut) throw fail("recovery_capture_unconfirmed");
      if (await checkpoints.storage.size(w.id, object) !== saved.bytes) throw fail("checkpoint_upload_failed");
      if (!await store.captured(a.id, a.lease_id!, { object, sha256: saved.sha256, bytes: saved.bytes })) throw fail("recovery_binding_changed");
    } finally { key.fill(0); }
  }

  private async restore(initial: RecoveryAttempt, w: CloudV2LifecycleWorkspace) {
    const { store, compute, checkpoints } = this.deps;
    let a = initial;
    if (a.replacement_create?.restoreClaimedAt) throw fail("checkpoint_restore_unconfirmed");
    await compute.stop(a.source_sandbox_id); await this.current(a);
    if (!a.replacement_create) {
      const issued = newCloudV2Token("worker"), runtime = { ...this.deps.runtime, sha256: a.source_runtime_sha256 };
      const prepared = await store.prepare(a.id, a.lease_id!, { name: this.deps.sandboxName(w, a.id),
        env: await this.deps.bootEnv(w, runtime), runtime: runtime.sha256, tokenHash: issued.hash,
        token: this.deps.sealToken(issued.token, w.id) });
      if (!prepared) throw fail("recovery_binding_changed");
      a = await this.read(a.id);
    }
    const request = a.replacement_create!;
    if (!a.replacement_sandbox_id) {
      if (!await store.creating(a.id, a.lease_id!)) throw fail("recovery_binding_changed");
      try {
        const created = await compute.create({ key: `${a.id}:recovery`, name: request.name, env: request.env, ...(request.from ? { from: request.from } : {}) });
        await store.created(a.id, created.sandboxId);
      } catch (error) {
        if (error instanceof BoatCreateRejectedError) await store.createRejected(a.id);
        throw error;
      }
      a = await this.read(a.id); await this.current(a);
    }
    const sandbox = a.replacement_sandbox_id!;
    const installed = await compute.exec(sandbox, installRuntimeCommand({ sha256: a.replacement_runtime_sha256!,
      url: await this.deps.runtime.url(a.replacement_runtime_sha256!), publicKeys: this.deps.publicKeys }), 300);
    await this.current(a);
    if (installed.exitCode !== 0 || installed.timedOut) throw fail("worker_runtime_install_failed");
    if (request.prune?.length) {
      const pruned = await compute.exec(sandbox, pruneCloudRepositories(request.prune), 120);
      await this.current(a); if (pruned.exitCode !== 0 || pruned.timedOut) throw fail("cloud_source_prune_failed");
    }
    if (!request.from) { await compute.exec(sandbox, GIT_LFS_INSTALL_COMMAND, 300).catch(() => {}); await this.current(a); }
    if (!await store.claimRestore(a.id, a.lease_id!)) throw fail("checkpoint_restore_unconfirmed");
    const github = await this.deps.githubToken(w), object = a.checkpoint_object!;
    const key = checkpoints.open(a.checkpoint_key, w.id, object);
    try {
      const command = restoreCommand({ checkoutPath: `${CLOUD_V2_HOME}/${w.repository}`, home: CLOUD_V2_HOME, key,
        sha256: a.checkpoint_sha256!, downloadUrl: await checkpoints.storage.downloadUrl(w.id, object),
        repositoryUrl: `https://github.com/${w.repository}.git`, githubToken: github.token, active: true, recovery: true });
      await this.current(a);
      const result = await compute.exec(sandbox, command, CLOUD_V2_CHECKPOINT_SECONDS);
      await this.current(a);
      const restored = parseRestoreResult(result.stdout);
      if (!restored.ok || result.exitCode !== 0 || result.timedOut) throw fail("checkpoint_restore_unconfirmed");
      if (!await store.restored(a.id, a.lease_id!)) throw fail("recovery_binding_changed");
    } finally { key.fill(0); }
  }

  private async boot(initial: RecoveryAttempt, w: CloudV2LifecycleWorkspace) {
    const { store, compute } = this.deps;
    let a = initial;
    if (!a.published_at) {
      const hosted = await compute.hostPort(a.replacement_sandbox_id!, { port: CLOUD_V2_WORKER_PORT, localhost: true,
        title: "Zeros worker", key: `${a.id}:recovery:host` });
      await this.current(a);
      if (!await store.publish(a.id, a.lease_id!, { url: hosted.url, token: this.deps.sealToken(hosted.token, w.id) })) throw fail("recovery_binding_changed");
      a = await this.read(a.id);
    }
    if (a.replacement_create?.bootDeliveredAt) return;
    if (!await store.delivered(a.id, a.lease_id!)) return;
    const token = this.deps.openToken(a.replacement_token, w.id);
    await this.current(a);
    // A lost reply may still have started the worker. Its bound hello is the
    // receipt; repeating this command would interrupt the replacement's setup.
    await compute.exec(a.replacement_sandbox_id!, deliverWorkerTokenCommand(token, a.replacement_create!.env), 30).catch(() => {});
  }

  private async cleanup(a: RecoveryAttempt) {
    const { store, compute, checkpoints } = this.deps;
    if (a.replacement_create?.createIssuedAt && !a.replacement_sandbox_id && !a.replacement_create.createRejectedAt) {
      const found = await compute.findSandbox(a.replacement_create.name, new Date(a.replacement_create.requestedAt));
      if (found) await store.created(a.id, found);
      return SCAN_MS;
    }
    let retainedSource = false;
    for (const [sandbox, deleted] of [[a.source_sandbox_id, a.source_deleted_at], [a.replacement_sandbox_id, a.replacement_deleted_at]] as const) {
      if (!sandbox || deleted || await store.ownedSandbox(sandbox)) continue;
      // Stop can win after publication, leaving the unproven candidate on the
      // workspace row. The original still belongs to this retained receipt.
      if (sandbox === a.source_sandbox_id && !await store.sourceDisposable(a.id)) { retainedSource = true; continue; }
      await compute.delete(sandbox); await store.deletedSandbox(a.id, sandbox);
    }
    if (a.checkpoint_upload_until && a.checkpoint_upload_until.getTime() > this.now()) return SCAN_MS;
    const deleted: string[] = [];
    for (const object of new Set([a.checkpoint_object, a.replacement_create?.priorCheckpointObject])) {
      if (!object || await store.ownedCheckpoint(a.workspace_id, object)) continue;
      await checkpoints.storage.delete(a.workspace_id, object); deleted.push(object);
    }
    await store.purge(a.id, a.lease_id!, deleted);
    return retainedSource ? SCAN_MS : Math.max(SCAN_MS, RECOVERY_RETENTION_MS - (this.now() - a.completed_at!.getTime()));
  }
}
