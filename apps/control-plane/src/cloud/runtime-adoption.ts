import { setTimeout as delay } from "node:timers/promises";
import type { CloudV2Compute } from "./boat.js";
import type { CloudV2Store, CloudV2WorkerSession, CloudV2Workspace } from "./store.js";
import { activateRuntimeCommand, completeRuntimeCommand, prepareRuntimeCommand, retireRuntimePermitCommand, type CloudV2Runtime } from "./runtime.js";
import { RuntimeHandoffStore, type RuntimeHandoff } from "./runtime-handoff-store.js";
import type { CloudRuntimeUpdateReply, CloudRuntimeUpdateRequest } from "./runtime-update-contract.js";
import type { CloudEnvironmentReport } from "./environment-contract.js";

interface Options {
  handoffs: RuntimeHandoffStore;
  store: Pick<CloudV2Store, "workerSession" | "get" | "accessEpoch" | "loginRevision">;
  compute: Pick<CloudV2Compute, "execLong">;
  runtimeForWorkspace(workspace: CloudV2Workspace): Promise<CloudV2Runtime>;
  authorizeSource(workspace: CloudV2Workspace): Promise<void>;
  drainActive?(): Promise<boolean>;
  sleep?(ms: number): Promise<void>;
  activationMs?: number;
  logger?: Pick<Console, "warn">;
}

/** Only negotiated workers initiate adoption. The configured resolver owns the
 * target; neither a client nor the worker can request an arbitrary archive. */
export class RuntimeAdoption {
  private readonly flights = new Map<string, Promise<void>>();
  private closed = false;
  constructor(private readonly options: Options) {}

  async session(token: string, bootId: string, id: string, sha256?: string): Promise<CloudV2WorkerSession | null> {
    const current = await this.options.store.workerSession(token, bootId);
    if (current) {
      return await this.options.handoffs.published(token, bootId, id, sha256) ? current : null;
    }
    const handoff = await this.options.handoffs.privateBoot(token, id, bootId, sha256);
    return handoff ? this.options.store.workerSession(token, handoff.old_boot_id) : null;
  }

  async environment(token: string, bootId: string, id: string, report: CloudEnvironmentReport): Promise<boolean> {
    const handoff = await this.options.handoffs.privateBoot(token, id, bootId);
    if (!handoff) return false;
    await this.options.handoffs.environment(token, id, bootId, report); return true;
  }

  async request(token: string, bootId: string, input: CloudRuntimeUpdateRequest): Promise<CloudRuntimeUpdateReply> {
    if (this.closed) return { status: "unavailable" };
    const { handoffs } = this.options;
    if (input.op === "ready") {
      const workspace = await this.session(token, bootId, input.id);
      if (!workspace) return { status: "unavailable" };
      await this.options.authorizeSource(workspace);
      if (this.closed) return { status: "unavailable" };
      if (await handoffs.published(token, bootId, input.id)) return { status: "completed", id: input.id };
      const h = await handoffs.inspect(token, input.id);
      if (!h) return { status: "unavailable" };
      if (h.state !== "rolling_back" && h.state !== "rolled_back" &&
          (await this.options.runtimeForWorkspace(workspace)).sha256 !== h.target_sha256) return { status: "unavailable" };
      if (this.closed) return { status: "unavailable" };
      return await handoffs.promote(token, input.id, bootId) ? { status: "completed", id: input.id } : { status: "unavailable" };
    }
    if (input.op === "cancel") return await handoffs.cancel(token, input.id, bootId) ? { status: "cancelled", id: input.id } : { status: "unavailable" };
    const workspace = await this.options.store.workerSession(token, bootId);
    if (this.closed || !workspace || workspace.state !== "running") return { status: "unavailable" };
    if (input.op === "status" && input.id) {
      const h = await handoffs.inspect(token, input.id);
      if (!h || h.workspace_id !== workspace.id || h.old_boot_id !== bootId.toLowerCase()) return { status: "unavailable" };
      await handoffs.expireUnactivated(h.id);
      const current = await handoffs.inspect(token, h.id);
      if (current?.state === "cancelled") return { status: "cancelled", id: h.id };
      if (h.state === "cancelled") return { status: "cancelled", id: h.id };
      if (h.state === "committed") return { status: "committed", id: h.id };
      if (h.state === "succeeded" || h.state === "rolled_back") return { status: "completed", id: h.id };
      return { status: "activating", id: h.id };
    }
    if (input.op !== "activate" && await this.options.drainActive?.()) return { status: "unavailable" };
    let runtime: CloudV2Runtime;
    try {
      if (input.op === "status") {
        runtime = await this.options.runtimeForWorkspace(workspace);
        const installed = await handoffs.runtime(token, bootId);
        if (this.closed) return { status: "unavailable" };
        // Matching status carries no archive or mutation authority. Adoption
        // still rechecks the source and effective pin at every admission.
        if (installed && installed === runtime.sha256) return { status: "current" };
      }
      await this.options.authorizeSource(workspace); runtime = await this.options.runtimeForWorkspace(workspace);
    }
    catch {
      if (input.op === "commit" || input.op === "activate") {
        if (await handoffs.cancel(token, input.id, bootId)) return { status: "cancelled", id: input.id };
      }
      return { status: "unavailable" };
    }
    if (this.closed) return { status: "unavailable" };
    if (input.op === "status") {
      const installed = await handoffs.runtime(token, bootId);
      return !installed ? { status: "unavailable" } : installed === runtime.sha256 ? { status: "current" } : { status: "target", sha256: runtime.sha256 };
    }
    if (input.op === "prepare") {
      const h = await handoffs.prepare(token, bootId, { ...input, target: runtime.sha256 });
      if (!h) return { status: "unavailable" };
      try {
        const result = await this.options.compute.execLong(h.sandbox_id, prepareRuntimeCommand({ sha256: runtime.sha256, url: await runtime.url() }), 300);
        if (this.closed || result.exitCode !== 0 || result.timedOut || (await this.options.runtimeForWorkspace(workspace)).sha256 !== h.target_sha256)
          throw new Error("Runtime preparation refused.");
        return { status: "prepared", id: h.id, sha256: h.target_sha256 };
      } catch {
        await handoffs.cancel(token, h.id, bootId);
        this.options.logger?.warn("[cloud-v2] runtime preparation deferred");
        return { status: "unavailable" };
      }
    }
    if (input.op === "commit") {
      return await handoffs.commit(token, bootId, input.id, input.revision, input.generation, runtime.sha256)
        ? { status: "committed", id: input.id } : { status: "unavailable" };
    }
    const pending = await handoffs.inspect(token, input.id);
    if (!pending || pending.workspace_id !== workspace.id || pending.old_boot_id !== bootId.toLowerCase() || pending.target_sha256 !== runtime.sha256) {
      return await handoffs.cancel(token, input.id, bootId) ? { status: "cancelled", id: input.id } : { status: "unavailable" };
    }
    const h = await handoffs.activate(token, input.id);
    if (h) this.track(h.id, () => this.activate(h));
    else if (await handoffs.cancel(token, input.id, bootId)) return { status: "cancelled", id: input.id };
    return { status: "activating", id: input.id };
  }

  async tick(): Promise<void> {
    if (this.closed) return;
    for (const h of await this.options.handoffs.pending()) {
      if (this.closed) return;
      if (h.state === "prepared" || h.state === "committed") { await this.options.handoffs.expireUnactivated(h.id); continue; }
      if (this.flights.has(h.id)) continue;
      // An earlier CP may have lost the provider reply. Observe the private
      // boot deadline; do not blindly issue the candidate restart a second time.
      this.track(h.id, () => this.observe(h));
    }
  }
  close(): void { this.closed = true; }
  private track(id: string, action: () => Promise<void>): void {
    if (this.flights.has(id)) return;
    const task = action().catch(() => this.options.logger?.warn("[cloud-v2] runtime adoption unsettled"))
      .finally(() => { if (this.flights.get(id) === task) this.flights.delete(id); });
    this.flights.set(id, task);
  }
  private async activate(h: RuntimeHandoff): Promise<void> {
    await this.options.compute.execLong(h.sandbox_id, activateRuntimeCommand({ sha256: h.target_sha256, previousSha256: h.previous_sha256,
      id: h.id, bootId: h.next_boot_id, instanceId: h.instance_id, tokenSha256: h.token_hash.toString("hex"), expectedBootIds: [h.old_boot_id] }), 15).catch(() => {});
    await this.observe(h);
  }
  private async observe(h: RuntimeHandoff): Promise<void> {
    if (h.state === "rolling_back" && !this.closed) await this.restore(h);
    const deadline = h.updated_at.getTime() + (this.options.activationMs ?? 25_000);
    let latest = await this.options.handoffs.get(h.id);
    while (!this.closed && latest && ["activating", "rolling_back"].includes(latest.state) && Date.now() < deadline) {
      if (latest.environment_report?.state === "failed") break;
      await (this.options.sleep?.(250) ?? delay(250));
      latest = await this.options.handoffs.get(h.id);
    }
    if (this.closed || !latest) return;
    if (latest.state === "succeeded" || latest.state === "rolled_back") {
      const current = latest.state === "succeeded" ? latest.target_sha256 : latest.previous_sha256;
      const previous = latest.state === "succeeded" ? latest.previous_sha256 : latest.target_sha256;
      const done = await this.options.compute.execLong(latest.sandbox_id, completeRuntimeCommand({ id: latest.id,
        bootId: latest.state === "succeeded" ? latest.next_boot_id : latest.rollback_boot_id, instanceId: latest.instance_id,
        sha256: current, previousSha256: previous, tokenSha256: latest.token_hash.toString("hex") }), 15);
      if (done.exitCode === 0 && !done.timedOut) await this.options.handoffs.complete(latest.id);
      return;
    }
    if (latest.state !== "activating" && latest.state !== "rolling_back") return;
    if (latest.state === "activating") {
      const retired = await this.options.compute.execLong(latest.sandbox_id, retireRuntimePermitCommand(latest.id, latest.old_boot_id), 15);
      if (retired.exitCode !== 0 || retired.timedOut) return;
      if (retired.stdout.trim() === "not-started") { await this.options.handoffs.settleUnstarted(latest.id); return; }
      if (retired.stdout.trim() !== "started") return;
    }
    const workspace = await this.options.store.get(latest.workspace_id, latest.creator_user_id);
    await this.options.authorizeSource(workspace);
    const accessEpoch = await this.options.store.accessEpoch(workspace.id), loginRevision = await this.options.store.loginRevision(workspace.id);
    if (this.closed || accessEpoch === null || loginRevision === null) return;
    const rollback = await this.options.handoffs.rollback(latest.id, { accessEpoch, loginRevision });
    if (!rollback) return;
    await this.observe(rollback);
  }
  private async restore(rollback: RuntimeHandoff): Promise<void> {
    await this.options.compute.execLong(rollback.sandbox_id, activateRuntimeCommand({ sha256: rollback.previous_sha256, previousSha256: rollback.target_sha256,
      id: rollback.id, bootId: rollback.rollback_boot_id, instanceId: rollback.instance_id,
      rollback: true,
      tokenSha256: rollback.token_hash.toString("hex"), expectedBootIds: [rollback.old_boot_id, rollback.next_boot_id,
        ...(rollback.prior_rollback_boot_id ? [rollback.prior_rollback_boot_id] : [])] }), 15).catch(() => {});
  }
}
