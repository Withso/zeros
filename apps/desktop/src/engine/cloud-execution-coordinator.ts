import { randomUUID } from "node:crypto";
import { CLOUD_COORDINATOR_READINESS_MS, type CloudCoordinatorStatus } from "@zeros/protocol/cloud-coordinator";

const PROOF_MS = 10_000, PROBE_MS = 5_000, RESTART_MS = 1_000;
export interface CloudFrontendLaunch {
  readonly frontendId: string;
  readonly signal: AbortSignal;
  message(value: unknown): void;
  exited(): void;
}
export interface CloudFrontendProcess {
  challenge(challengeId: string): void;
  /** Positive proof for the original Host process group, not VM erasure. */
  stopAndProve(): Promise<void>;
}
export interface CloudExecutionCoordinatorOptions {
  bootId: string;
  /** Construct the one writer/ledger/uplink before the first attachment. */
  initialize(): Promise<void>;
  /** Null proves no scope was created, or this exact attempt fully retired. */
  spawn(launch: CloudFrontendLaunch): Promise<CloudFrontendProcess | null>;
  changed(): void;
  now?: () => number;
  monotonic?: () => number;
}
type Frontend = {
  id: string; controller: AbortController; process: CloudFrontendProcess | null;
  starting: Promise<void>; retiring?: Promise<void>; retired: boolean;
  ready: boolean; proofUntil: number; challenge: { id: string; sentAt: number } | null;
};

/** The registered engine is the execution owner. Frontend replacement only
 * replaces this attachment; it never invokes owner initialization or teardown.
 * Provider processes remain in their existing native Host scopes. */
export class CloudExecutionCoordinator {
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private current: Frontend | null = null;
  private startFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private report: CloudCoordinatorStatus;

  constructor(private readonly options: CloudExecutionCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.report = { version: 1, bootId: options.bootId, revision: 1, frontendId: null, ready: false, expiresAtMs: 0 };
  }
  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Cloud coordinator is stopped"));
    return this.startFlight ??= this.options.initialize().then(() => this.launch());
  }
  /** This identity, captured before async admission, also fences A→B→A. */
  frontendId(): string | null { return this.isInteractiveReady() ? this.current!.id : null; }
  isInteractiveReady(): boolean {
    const current = this.current;
    if (current?.ready && this.monotonic() >= current.proofUntil) this.withdraw(current);
    return !this.stopped && current !== null && !current.retired && current.ready;
  }
  snapshot(): CloudCoordinatorStatus { this.isInteractiveReady(); return { ...this.report }; }
  private publish(current: Frontend | null, ready: boolean, notify = true): void {
    this.report = { ...this.report, revision: this.report.revision + 1, frontendId: current?.id ?? null, ready,
      expiresAtMs: ready ? this.now() + CLOUD_COORDINATOR_READINESS_MS : 0 };
    if (notify) this.options.changed();
  }
  private async launch(): Promise<void> {
    if (this.stopped || this.current) return;
    const current: Frontend = { id: randomUUID(), controller: new AbortController(), process: null,
      starting: Promise.resolve(), retired: false, ready: false, proofUntil: this.monotonic() + PROOF_MS, challenge: null };
    this.current = current;
    // Install the flight before a spawn can synchronously report exit. Its
    // late handle must join retirement before any replacement is possible.
    current.starting = Promise.resolve().then(() => this.options.spawn({ frontendId: current.id, signal: current.controller.signal,
      message: value => this.receive(current, value), exited: () => this.withdraw(current),
    })).then(async process => {
      current.process = process;
      if (!process) return;
      // Cancellation while preparation/spawn was pending must still retire the
      // exact late child; never let its ready callback restore publication.
      if (this.current !== current || current.retired || this.stopped) await process.stopAndProve();
      else if (!current.ready) this.publish(current, false);
    });
    this.schedule(PROBE_MS, () => this.probe(current));
    try { await current.starting; } catch { this.withdraw(current); return; }
    if (!current.process && this.current === current && !current.retired) {
      // Reversible Host fences can defer ingress. No scope exists, so retry
      // locally without publishing revisions or reinitializing the owner.
      current.retired = true; current.controller.abort(); this.current = null;
      if (!this.stopped) this.schedule(RESTART_MS, () => { void this.launch(); });
    }
  }
  private receive(current: Frontend, value: unknown): void {
    if (this.stopped || this.current !== current || current.retired || !value || typeof value !== "object" || Array.isArray(value)) return;
    const frame = value as Record<string, unknown>;
    if (frame.frontendId !== current.id) return;
    if (this.monotonic() >= current.proofUntil) { this.withdraw(current); return; }
    if (frame.type === "ready" && Object.keys(frame).length === 2 && !current.ready) {
      current.ready = true;
      // The private start request's random frontend id is the initial challenge.
      this.publish(current, true);
    } else if (frame.type === "pong" && Object.keys(frame).length === 3 && current.ready &&
        current.challenge !== null && current.challenge.id === frame.challengeId) {
      current.proofUntil = current.challenge.sentAt + PROOF_MS;
      current.challenge = null;
      // Keep the fixed observation deadline; only state changes trigger IO.
      this.publish(current, true, false);
    }
  }
  private probe(current: Frontend): void {
    if (this.stopped || this.current !== current || current.retired) return;
    if (this.monotonic() >= current.proofUntil) { this.withdraw(current); return; }
    if (current.ready && current.process && !current.challenge) {
      const id = randomUUID(); current.challenge = { id, sentAt: this.monotonic() };
      try { current.process.challenge(id); } catch { this.withdraw(current); return; }
    }
    this.schedule(PROBE_MS, () => this.probe(current));
  }
  private schedule(ms: number, action: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; action(); }, ms);
    this.timer.unref?.();
  }
  private withdraw(current: Frontend): void {
    if (this.current !== current || current.retired) return;
    current.retired = true; current.ready = false;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.publish(current, false);
    current.controller.abort();
    // Positive retirement precedes replacement. An unknown retirement remains
    // unavailable and busy in the Host registry; it cannot launch a duplicate.
    current.retiring = current.starting.then(() => current.process?.stopAndProve()).then(() => {
      if (this.current !== current) return;
      this.current = null;
      if (!this.stopped) this.schedule(RESTART_MS, () => { void this.launch(); });
    });
    void current.retiring.catch(() => {});
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    const current = this.current;
    if (current) { this.withdraw(current); await current.retiring; }
  }
}

export function createCloudExecutionCoordinator(options: CloudExecutionCoordinatorOptions & {
  cloud: boolean; negotiated: boolean;
}): CloudExecutionCoordinator | null {
  return options.cloud && options.negotiated ? new CloudExecutionCoordinator(options) : null;
}
