import { randomUUID } from "node:crypto";
import {
  LOCAL_COMMAND_DEVICE_HEADERS, LOCAL_COMMAND_LIMITS,
  type LocalCommandDevice, type LocalCommandMacResult, type LocalCommandNotice, type LocalCommandPendingNotice, type LocalCommandPresence,
} from "@zeros/protocol/local-commands";
import type { DeviceControl, DeviceEvent } from "./control";
import { DeviceControlError } from "./control";
import type { LocalCommandJournal } from "./journal";

import type { LocalCommandApprovalView, LocalCommandDecision } from "../../shared/local-commands";
export type { LocalCommandApprovalView, LocalCommandDecision };

export interface LocalCommandServiceDeps {
  control: Pick<DeviceControl, "register" | "unregister" | "heartbeat" | "received" | "claim" | "get" | "result" | "ack">;
  events(device: LocalCommandDevice, signal: AbortSignal): AsyncIterable<DeviceEvent>;
  journal(accountId: string): Promise<LocalCommandJournal>;
  run(input: { command: string; cwd?: string; timeoutMs: number }, signal: AbortSignal): Promise<LocalCommandMacResult>;
  identity: { deviceId(accountId: string): string; name(): Promise<string> };
  settings: { alwaysAllow(): boolean; setAlwaysAllow(value: boolean): void };
  session(): Promise<{ accountId: string; sessionId: string } | null>;
  publish(approvals: LocalCommandApprovalView[]): void;
  notify(approval: LocalCommandApprovalView): void;
  sleep?(ms: number): Promise<void>;
}

const expired = (notice: LocalCommandPendingNotice) => Date.now() >= Date.parse(notice.approvalDeadline);
interface Pending { view: LocalCommandApprovalView; notice: LocalCommandPendingNotice; timer: ReturnType<typeof setTimeout> }

/** One Mac's side of local commands for the signed-in account: registration,
 * the account-level channel, and each request from notice to result. Nothing
 * runs without this Mac's own decision (or its Always allow for the chat's own
 * target), and a request runs at most once, across reconnects and restarts. */
export class LocalCommandService {
  private lifetime?: AbortController;
  private device?: LocalCommandDevice;
  private presence: LocalCommandPresence = { presenceRequired: false, reachableUntil: null };
  private journal?: LocalCommandJournal;
  private readonly pending = new Map<string, Pending>();
  private readonly running = new Map<string, AbortController>();
  private readonly chains = new Map<string, Promise<void>>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private loop?: Promise<void>;

  constructor(private readonly deps: LocalCommandServiceDeps) {}

  private sleep(ms: number) { return this.deps.sleep ? this.deps.sleep(ms) : new Promise<void>(resolve => setTimeout(resolve, ms)); }

  /** Begin for the current session; resolves once registration started. */
  async start(): Promise<void> {
    if (this.lifetime) return;
    const session = await this.deps.session();
    if (!session) return;
    const lifetime = this.lifetime = new AbortController();
    this.journal = await this.deps.journal(session.accountId);
    this.loop = this.channel(session.accountId, lifetime.signal).catch(() => {});
  }

  /** Stop without unregistering (app quit): running commands end with their group. */
  async stop(): Promise<void> {
    const lifetime = this.lifetime;
    this.lifetime = undefined;
    lifetime?.abort();
    clearInterval(this.heartbeat); this.heartbeat = undefined;
    for (const controller of this.running.values()) controller.abort();
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear(); this.publish();
    this.device = undefined;
    await this.loop?.catch(() => {});
    await Promise.allSettled([...this.chains.values()]);
  }

  /** Sign-out: unregister first, which removes connections and cancels this Mac's outstanding work. */
  async beforeSignOut(): Promise<void> {
    const device = this.device;
    for (const controller of this.running.values()) controller.abort();
    if (device) await this.deps.control.unregister(device).catch(() => {});
    await this.stop();
  }

  deviceHeaders(): Record<string, string> | null {
    const device = this.device;
    return device ? { [LOCAL_COMMAND_DEVICE_HEADERS.deviceId]: device.deviceId, [LOCAL_COMMAND_DEVICE_HEADERS.registrationId]: device.registrationId,
      [LOCAL_COMMAND_DEVICE_HEADERS.instanceId]: device.instanceId } : null;
  }
  currentDevice(): LocalCommandDevice | undefined { return this.device; }
  approvals(): LocalCommandApprovalView[] { return [...this.pending.values()].map(pending => pending.view); }

  /** This Mac's person decided. Accepted once, only for a request this Mac
   * raised and only before its approval deadline. */
  async decide(requestId: string, decision: LocalCommandDecision): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.withdraw(requestId);
    // The clock decides, not the timer: timers run late after the Mac sleeps.
    if (expired(pending.notice)) return;
    if (decision === "always") this.deps.settings.setAlwaysAllow(true);
    // Queued, not awaited: the command may run for minutes.
    void this.serial(requestId, () => this.execute(pending.notice, decision === "deny" ? "deny" : "approve"));
  }

  private publish(): void { this.deps.publish(this.approvals()); }
  private withdraw(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(requestId); this.publish();
  }
  private serial(requestId: string, task: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(requestId) ?? Promise.resolve()).then(task, task).catch(() => {});
    this.chains.set(requestId, next);
    void next.then(() => { if (this.chains.get(requestId) === next) this.chains.delete(requestId); });
    return next;
  }

  private async channel(accountId: string, signal: AbortSignal): Promise<void> {
    let registrationRequest = randomUUID(), attempt = 0;
    while (!signal.aborted) {
      // Register (same request id on retry); a changed registration needs a new one.
      try {
        const reply = await this.deps.control.register(this.deps.identity.deviceId(accountId), { requestId: registrationRequest, name: await this.deps.identity.name() });
        if (signal.aborted) return;
        this.device = reply.device; this.setPresence(reply.presence); attempt = 0;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof DeviceControlError && (error.status === 401 || error.code === "session_revoked")) return;
        await this.sleep(Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5))); continue;
      }
      await this.recover();
      // Stream until it ends; reconnect without registering again.
      for (;;) {
        if (signal.aborted) return;
        let revoked: string | undefined;
        try {
          for await (const event of this.deps.events(this.device!, signal)) {
            if (event.event === "revoked") { revoked = event.data.code; break; }
            this.onEvent(event);
          }
        } catch (error) {
          if (error instanceof DeviceControlError && error.code === "device_registration_changed") revoked = "device_registration_changed";
          else if (error instanceof DeviceControlError && (error.status === 401 || error.code === "session_revoked")) revoked = "session_revoked";
        }
        if (signal.aborted) return;
        if (revoked === "session_revoked") return;
        if (revoked === "device_registration_changed") { registrationRequest = randomUUID(); break; }
        await this.sleep(Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5)));
      }
    }
  }

  private setPresence(presence: LocalCommandPresence): void {
    this.presence = presence;
    // A Mac connected nowhere sends no presence heartbeat.
    if (presence.presenceRequired && !this.heartbeat) {
      this.heartbeat = setInterval(() => { void this.beat(); }, 25_000);
      this.heartbeat.unref?.();
    } else if (!presence.presenceRequired && this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
  }
  private async beat(): Promise<void> {
    const device = this.device;
    if (!device || !this.presence.presenceRequired) return;
    try { this.setPresence(await this.deps.control.heartbeat(device)); } catch { /* The next beat or presence event repairs it. */ }
  }

  private onEvent(event: DeviceEvent): void {
    if (event.event === "ready" || event.event === "presence") this.setPresence(event.event === "ready" ? event.data.presence : event.data);
    else if (event.event === "heartbeat") this.setPresence(event.data.presence);
    else if (event.event === "request") {
      const notice = event.data;
      // A terminal notice acts at once: it must reach a command still running in its own chain.
      if (notice.state === "terminal") { this.withdraw(notice.requestId); this.running.get(notice.requestId)?.abort(); }
      void this.serial(notice.requestId, () => this.onNotice(notice));
    }
  }

  private async onNotice(notice: LocalCommandNotice): Promise<void> {
    const device = this.device, journal = this.journal;
    if (!device || !journal) return;
    if (notice.state === "terminal") {
      // Withdraw an approval, kill a running group, record the outcome, then acknowledge.
      this.withdraw(notice.requestId);
      this.running.get(notice.requestId)?.abort();
      if (journal.state(notice.requestId) !== undefined) await journal.finish(notice.requestId, notice.outcome);
      await this.deps.control.ack(device, notice.requestId).catch(() => {});
      return;
    }
    const known = journal.state(notice.requestId);
    if (notice.state === "claimed") return; // Only this Mac claims; a restart already reported it.
    if (known === undefined) { if (!await journal.begin(notice.requestId)) return; }
    else if (known !== "prompted" || this.pending.has(notice.requestId)) return;
    await this.deps.control.received(device, notice.requestId).catch(() => {});
    // Past its deadline: never offered or run; the server's terminal notice settles the journal.
    if (expired(notice)) return;
    if (this.deps.settings.alwaysAllow() && notice.isDefaultTarget) { await this.execute(notice, "approve"); return; }
    const view = this.view(notice);
    const timer = setTimeout(() => this.withdraw(notice.requestId), Math.max(0, Date.parse(notice.approvalDeadline) - Date.now()));
    timer.unref?.();
    this.pending.set(notice.requestId, { view, notice, timer });
    this.publish(); this.deps.notify(view);
  }

  private view(notice: LocalCommandPendingNotice): LocalCommandApprovalView {
    const input = notice.input;
    return { requestId: notice.requestId, workspaceId: notice.workspace.id, workspaceName: notice.workspace.name, workspaceTitle: notice.workspace.title,
      chatId: notice.chat.id, chatTitle: notice.chat.title, macName: notice.mac, command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.description ? { description: input.description } : {}), ...(input.reason ? { reason: input.reason } : {}),
      timeoutMs: input.timeoutMs ?? LOCAL_COMMAND_LIMITS.defaultTimeoutMs, ...(input.extendedTimeoutReason ? { extendedTimeoutReason: input.extendedTimeoutReason } : {}),
      ...(!notice.isDefaultTarget ? { explicitFrom: notice.defaultMac ?? "another Mac" } : {}), approvalDeadline: notice.approvalDeadline };
  }

  /** Journal before claiming, claim before spawning, report once. */
  private async execute(notice: LocalCommandPendingNotice, decision: "approve" | "deny"): Promise<void> {
    const device = this.device, journal = this.journal;
    if (!device || !journal || journal.state(notice.requestId) !== "prompted") return;
    if (decision === "deny") {
      try { const reply = await this.deps.control.claim(device, notice.requestId, "deny"); if (reply.state === "terminal") await journal.finish(notice.requestId, reply.outcome); }
      catch { await this.reconcile(device, notice.requestId); }
      return;
    }
    await journal.mark(notice.requestId, "approved");
    let claimed: LocalCommandNotice;
    try { claimed = await this.deps.control.claim(device, notice.requestId, "approve"); }
    catch { await this.reconcile(device, notice.requestId); return; }
    if (claimed.state !== "claimed") { if (claimed.state === "terminal") await journal.finish(notice.requestId, claimed.outcome); return; }
    await journal.mark(notice.requestId, "running");
    const controller = new AbortController();
    this.lifetime?.signal.addEventListener("abort", () => controller.abort(), { once: true });
    this.running.set(notice.requestId, controller);
    const runFor = claimed.runDeadline ? Math.min(notice.input.timeoutMs ?? LOCAL_COMMAND_LIMITS.defaultTimeoutMs, Math.max(1, Date.parse(claimed.runDeadline) - Date.now()))
      : notice.input.timeoutMs ?? LOCAL_COMMAND_LIMITS.defaultTimeoutMs;
    let result: LocalCommandMacResult;
    try { result = await this.deps.run({ command: notice.input.command, ...(notice.input.cwd ? { cwd: notice.input.cwd } : {}), timeoutMs: runFor }, controller.signal); }
    catch { result = { outcome: "failed", error: "spawn_failed" }; }
    finally { this.running.delete(notice.requestId); }
    await this.report(device, notice.requestId, result);
    await journal.finish(notice.requestId, result.outcome);
  }

  /** Identical replays are inert; the first terminal result wins on the server. */
  private async report(device: LocalCommandDevice, requestId: string, result: LocalCommandMacResult): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await this.deps.control.result(device, requestId, result); return; }
      catch (error) {
        if (error instanceof DeviceControlError && error.status >= 400 && error.status < 500 && error.status !== 429) return;
        await this.sleep(Math.min(10_000, 500 * 2 ** attempt));
      }
    }
  }

  /** A lost or refused claim: read the state; never execute because of it. */
  private async reconcile(device: LocalCommandDevice, requestId: string): Promise<void> {
    try {
      const current = await this.deps.control.get(device, requestId);
      if (current.state === "terminal") await this.journal?.finish(requestId, current.outcome);
    } catch { /* The terminal notice will settle it. */ }
  }

  /** After a restart: anything approved or started before it reports interrupted and never runs. */
  private async recover(): Promise<void> {
    const device = this.device, journal = this.journal;
    if (!device || !journal) return;
    for (const { requestId } of journal.recover()) {
      await this.report(device, requestId, { outcome: "interrupted" });
      await journal.finish(requestId, "interrupted");
    }
  }
}
