import { randomUUID } from "node:crypto";
import {
  LOCAL_COMMAND_DEVICE_HEADERS, LOCAL_COMMAND_LIMITS, LOCAL_COMMANDS_FEATURE, LOCAL_COMMANDS_REASON_FEATURE,
  type LocalCommandDevice, type LocalCommandMacResult, type LocalCommandNotice, type LocalCommandPendingNotice, type LocalCommandPresence,
} from "@zeros/protocol/local-commands";
import type { NotifyUserEvent } from "@zeros/protocol/notify-user";
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
  /** notify-user-v1: a `notify` event from the same device channel. */
  notifyUser?(event: NotifyUserEvent): void;
  sleep?(ms: number): Promise<void>;
  /** One `[local-commands]` line per state change: closed codes and id prefixes only. */
  log?(line: string): void;
}

/** The server sends a heartbeat event every 25 s; this long without one is a dead stream. */
const STREAM_SILENCE_MS = 70_000;
const codeOf = (error: unknown) => error instanceof DeviceControlError ? (error.status === 401 ? "unauthorized" : error.code.replace(/[^a-z0-9_]/gi, "").slice(0, 40) || "unavailable") : "network";
const authFailure = (code: string) => code === "unauthorized" || code === "session_revoked";
const idPrefix = (id: string) => id.slice(0, 8);

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
  private lastBeatAt = 0;
  /** A stream is open and said ready: only then is this Mac deliverable, so only then does it beat. */
  private streamLive = false;
  private loop?: Promise<void>;

  constructor(private readonly deps: LocalCommandServiceDeps) {}

  private sleep(ms: number) { return this.deps.sleep ? this.deps.sleep(ms) : new Promise<void>(resolve => setTimeout(resolve, ms)); }
  private log(line: string): void { (this.deps.log ?? (text => console.info(`[local-commands] ${text}`)))(line); }

  /** Begin for the current session; resolves once registration started. */
  async start(): Promise<void> {
    if (this.lifetime) return;
    const session = await this.deps.session();
    if (!session) return;
    const lifetime = this.lifetime = new AbortController();
    this.journal = await this.deps.journal(session.accountId);
    this.loop = this.channel(session, lifetime.signal).catch(() => {});
  }

  /** Stop without unregistering (app quit): running commands end with their group. */
  async stop(): Promise<void> {
    const lifetime = this.lifetime;
    this.lifetime = undefined;
    lifetime?.abort();
    clearInterval(this.heartbeat); this.heartbeat = undefined;
    this.presence = { presenceRequired: false, reachableUntil: null }; this.lastBeatAt = 0; this.streamLive = false;
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
    if (expired(pending.notice)) { this.log(`request decided id=${idPrefix(requestId)} decision=late`); return; }
    this.log(`request decided id=${idPrefix(requestId)} decision=${decision}`);
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

  /** Register, then stream until aborted. An expired token (401, session_revoked)
   * is not a sign-out: while the same session is signed in the channel backs off
   * and reconnects with a fresh token. It stops only when that session is gone
   * or changed (install.ts then starts it again for the new one). */
  private async channel(session: { accountId: string; sessionId: string }, signal: AbortSignal): Promise<void> {
    const { accountId } = session;
    // One request id is only ever sent with one exact body: the id and the capability set change together.
    let registration = { requestId: randomUUID(), capabilities: [LOCAL_COMMANDS_FEATURE, LOCAL_COMMANDS_REASON_FEATURE] as readonly string[] }, attempt = 0;
    const stillSignedIn = async () => {
      const current = await this.deps.session().catch(() => null);
      return !!current && current.accountId === session.accountId && current.sessionId === session.sessionId;
    };
    const backoff = async (immediate = false) => {
      const delay = immediate ? 0 : Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5));
      this.log(`reconnect scheduled attempt=${attempt} delay_ms=${delay}`);
      await this.sleep(delay);
    };
    while (!signal.aborted) {
      // Register (same request id on retry); a changed registration needs a new one.
      try {
        const reply = await this.deps.control.register(this.deps.identity.deviceId(accountId), { ...registration, name: await this.deps.identity.name() });
        if (signal.aborted) return;
        this.device = reply.device; attempt = 0;
        this.log("registered");
        this.setPresence(reply.presence);
      } catch (error) {
        if (signal.aborted) return;
        const code = codeOf(error);
        this.log(`register failed code=${code}`);
        if (authFailure(code) && !await stillSignedIn()) { this.log("channel stopped reason=signed_out"); return; }
        // A control plane from before wire v1.3 refuses the reason capability: register as v1 alone, under a new id.
        if (error instanceof DeviceControlError && error.status === 400 && registration.capabilities.length > 1) {
          registration = { requestId: randomUUID(), capabilities: [LOCAL_COMMANDS_FEATURE] }; continue;
        }
        // That id was committed with another body: never loop on it.
        if (code === "device_registration_conflict") registration = { ...registration, requestId: randomUUID() };
        await backoff(); continue;
      }
      await this.recover();
      // Stream until it ends; reconnect without registering again.
      for (;;) {
        if (signal.aborted) return;
        const opened = Date.now(), stream = new AbortController();
        let reason = "ended", watchdog: ReturnType<typeof setTimeout> | undefined, first = true;
        // A half-dead socket (sleep, network change) can hang a read forever: silence ends it.
        const pet = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { reason = "stale"; stream.abort(); }, STREAM_SILENCE_MS); watchdog.unref?.(); };
        pet();
        this.log("channel open");
        try {
          for await (const event of this.deps.events(this.device!, AbortSignal.any([signal, stream.signal]))) {
            pet();
            if (event.event === "revoked") { reason = event.data.code; break; }
            if (event.event === "ready") this.streamLive = true;
            this.onEvent(event);
            if (first) {
              first = false; attempt = 0;
              // A reconnect reports presence at once instead of 25 s later.
              if (this.presence.presenceRequired) void this.beat();
            }
          }
        } catch (error) {
          if (reason !== "stale") reason = codeOf(error);
        } finally {
          clearTimeout(watchdog);
          // A closed stream delivers nothing: stop claiming reachability until the next ready.
          this.streamLive = false; clearInterval(this.heartbeat); this.heartbeat = undefined;
        }
        if (signal.aborted) return;
        this.log(`channel closed reason=${reason} open_s=${Math.round((Date.now() - opened) / 1000)}`);
        if (reason === "device_registration_changed") { registration = { ...registration, requestId: randomUUID() }; break; }
        if (authFailure(reason) && !await stillSignedIn()) { this.log("channel stopped reason=signed_out"); return; }
        // The server ends a healthy stream cleanly just before its token expires (every few minutes):
        // reconnect at once, or a request sent in the gap misses its delivery deadline.
        await backoff(reason === "ended" && !first && Date.now() - opened >= 5_000);
      }
    }
  }

  private setPresence(presence: LocalCommandPresence): void {
    const was = this.presence.presenceRequired;
    this.presence = presence;
    if (was !== presence.presenceRequired) this.log(`presence required ${presence.presenceRequired ? "on" : "off"}`);
    // A Mac connected nowhere, or without a live stream, sends no presence heartbeat.
    if (presence.presenceRequired && this.streamLive && !this.heartbeat) {
      this.heartbeat = setInterval(() => { void this.beat(); }, 25_000);
      this.heartbeat.unref?.();
      // Becoming a command target is reported at once, not at the next tick.
      void this.beat();
    } else if (!presence.presenceRequired && this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
  }
  private async beat(): Promise<void> {
    const device = this.device;
    if (!device || !this.presence.presenceRequired || !this.streamLive) return;
    // One beat per second at most (a reconnect and a presence flip can coincide).
    if (Date.now() - this.lastBeatAt < 1_000) return;
    this.lastBeatAt = Date.now();
    try { this.setPresence(await this.deps.control.heartbeat(device)); }
    catch (error) { this.log(`heartbeat failed code=${codeOf(error)}`); /* The next beat or presence event repairs it. */ }
  }

  private onEvent(event: DeviceEvent): void {
    if (event.event === "ready" || event.event === "presence") this.setPresence(event.event === "ready" ? event.data.presence : event.data);
    else if (event.event === "heartbeat") this.setPresence(event.data.presence);
    // notify-user-v1 shares this channel; it never touches the journal or approvals.
    else if (event.event === "notify") this.deps.notifyUser?.(event.data);
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
      this.log(`request finished id=${idPrefix(notice.requestId)} outcome=${notice.outcome}`);
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
    this.log(`request received id=${idPrefix(notice.requestId)} default_target=${notice.isDefaultTarget ? "yes" : "no"}`);
    // Past its deadline: never offered or run; the server's terminal notice settles the journal.
    if (expired(notice)) return;
    if (this.deps.settings.alwaysAllow() && notice.isDefaultTarget) {
      this.log(`request decided id=${idPrefix(notice.requestId)} decision=always_allow`);
      await this.execute(notice, "approve"); return;
    }
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
    // Registered before the claim: a Stop that lands while the claim or the
    // journal write is in flight must still reach this command.
    const controller = new AbortController();
    this.lifetime?.signal.addEventListener("abort", () => controller.abort(), { once: true });
    this.running.set(notice.requestId, controller);
    let result: LocalCommandMacResult, started = Date.now();
    try {
      await journal.mark(notice.requestId, "approved");
      let claimed: LocalCommandNotice;
      try { claimed = await this.deps.control.claim(device, notice.requestId, "approve"); }
      catch { await this.reconcile(device, notice.requestId); return; }
      if (claimed.state !== "claimed") { if (claimed.state === "terminal") await journal.finish(notice.requestId, claimed.outcome); return; }
      this.log(`request claimed id=${idPrefix(notice.requestId)}`);
      await journal.mark(notice.requestId, "running");
      started = Date.now();
      const runFor = claimed.runDeadline ? Math.min(notice.input.timeoutMs ?? LOCAL_COMMAND_LIMITS.defaultTimeoutMs, Math.max(1, Date.parse(claimed.runDeadline) - Date.now()))
        : notice.input.timeoutMs ?? LOCAL_COMMAND_LIMITS.defaultTimeoutMs;
      // Stopped before it began: the process is never started.
      if (controller.signal.aborted) result = { outcome: "cancelled" };
      else try { result = await this.deps.run({ command: notice.input.command, ...(notice.input.cwd ? { cwd: notice.input.cwd } : {}), timeoutMs: runFor }, controller.signal); }
      catch { result = { outcome: "failed", error: "spawn_failed" }; }
    } finally { this.running.delete(notice.requestId); }
    this.log(`request ran id=${idPrefix(notice.requestId)} outcome=${result.outcome}${typeof result.code === "number" ? ` exit=${result.code}` : ""}${result.error ? ` error=${result.error}` : ""} duration_ms=${Date.now() - started}`);
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
