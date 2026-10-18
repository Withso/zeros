import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CloudAcceptedWorkEnrollRequestSchema, CloudAcceptedWorkReceiptSchema,
  type CloudAcceptedWorkEnrollRequest, type CloudAcceptedWorkReceipt } from "@zeros/protocol/cloud-accepted-work";
import { CloudBootCommandMutationSchema, type CloudBootCommandMutation, type CloudBootCommandSnapshot } from "@zeros/protocol/cloud-commands";
import type { CloudAcceptedWorkLedger, AcceptedReservation } from "../cloud-accepted-work-ledger";
import type { EngineCapabilityAuth, EngineClientAuth, CapabilityRoute } from "../cloud-capability-auth";
import type { CapabilityVerifySuccess } from "../cloud-capability-verifier";
import { freezeCloudSnapshot } from "./cloud-mcp";

declare const accepted: unique symbol;
export type CloudAcceptedWork = Readonly<{ readonly [accepted]: true; receipt: Readonly<CloudAcceptedWorkReceipt>;
  signal: AbortSignal; assertLive(operation?: "run" | "context" | "native-git"): void }>;
export type AcceptedWorkAuthorityOptions = { ledger: CloudAcceptedWorkLedger; auth: EngineCapabilityAuth; runtimeId: string;
  engineLive(): boolean; enabled(): boolean;
  enroll(request: CloudAcceptedWorkEnrollRequest, signal: AbortSignal): Promise<unknown>;
  time?: { wall(): number; monotonic(): number }; maxEntries?: number };
export type AcceptedWorkInput = { mutation: CloudBootCommandMutation; cwd: string; executionId: string;
  clientSessionId: string; actorSessionId: string; auth: EngineClientAuth; route: CapabilityRoute };
type Lifetime = { commandId: string; sessionId: string; stop: AbortController; deadline: number; wallDeadline: number;
  timer: ReturnType<typeof setTimeout> | null; reserved: boolean; ioPending: boolean; done: boolean; work?: CloudAcceptedWork };
const genuine = new WeakSet<object>();
const time = { wall: () => Date.now(), monotonic: () => performance.now() };
const ENROLLMENT_BOUND_MS = 10_000;
function rejected(): never { throw new Error("accepted_work_rejected"); }
function immutable(claims: CapabilityVerifySuccess["claims"]) {
  const { jti: _jti, iat: _iat, nbf: _nbf, exp: _exp, ...binding } = claims;
  return { ...binding, scp: [...binding.scp].sort() };
}

/** Distinct from the short-lived legacy actor principal. Never grants another
 * command, a generic repository grant, or client/session renewal. */
export class CloudAcceptedWorkAuthority {
  private readonly records = new Map<string, Lifetime>();
  private readonly attempts = new Map<string, Lifetime>();
  private readonly sessions = new Map<string, Lifetime>();
  private readonly time: typeof time;
  private readonly maxEntries: number;
  private readonly unsubscribe: () => void;
  private disposed = false;
  constructor(private readonly options: AcceptedWorkAuthorityOptions) {
    this.time = options.time ?? time;
    this.maxEntries = options.maxEntries ?? 256;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > 256 ||
      !/^r1-[a-f0-9]{64}$/.test(options.runtimeId)) rejected();
    const unsubscribeAuth = options.auth.observeSessionClosures(closures => {
      for (const { sessionId } of closures) {
        const lifetime = this.sessions.get(sessionId);
        if (lifetime) this.retire(lifetime);
      }
    });
    let unsubscribeLedger: () => void;
    try {
      unsubscribeLedger = options.ledger.observeChanges(() => {
        if (this.disposed) return;
        try {
          this.assertEngine();
          for (const lifetime of new Set([...this.records.values(), ...this.attempts.values()])) {
            if (lifetime.reserved && !lifetime.stop.signal.aborted && options.ledger.get(lifetime.commandId)?.state === "closed")
              this.retire(lifetime);
          }
        } catch { this.dispose(); }
      });
    } catch (error) { unsubscribeAuth(); throw error; }
    this.unsubscribe = () => { unsubscribeAuth(); unsubscribeLedger(); };
  }

  private assertEngine(): void {
    let live = false;
    try {
      live = !this.disposed && this.options.auth.active() && this.options.engineLive() && this.options.enabled();
      if (live) this.options.ledger.assertCurrent();
    } catch { live = false; }
    if (!live) { this.dispose(); rejected(); }
  }
  private assertLifetime(lifetime: Lifetime): void {
    this.assertEngine();
    if (lifetime.stop.signal.aborted || this.time.wall() >= lifetime.wallDeadline || this.time.monotonic() >= lifetime.deadline) {
      this.retire(lifetime); rejected();
    }
    this.options.auth.verifier.recheck();
    if (lifetime.stop.signal.aborted || !this.options.auth.verifier.sessionClaims(lifetime.sessionId)) {
      this.retire(lifetime); rejected();
    }
  }
  private assertClient(input: AcceptedWorkInput, verified: CapabilityVerifySuccess): void {
    this.assertEngine();
    this.options.auth.verifier.recheck();
    const current = this.options.auth.verifier.sessionClaims(input.clientSessionId);
    const claims = verified.claims;
    if (!current || !isDeepStrictEqual(immutable(current), immutable(claims)) || claims.knd !== "client" ||
      claims.role !== "owner" || claims.sub !== `user:${this.options.ledger.scope.fundingOwnerUserId}` ||
      !claims.sid || !claims.did || !claims.cnf || !claims.scp.includes("ws:prompt") || this.time.wall() >= claims.exp * 1000) rejected();
  }
  private schedule(lifetime: Lifetime, bound?: number): void {
    if (lifetime.timer) clearTimeout(lifetime.timer);
    const remaining = Math.min(lifetime.deadline - this.time.monotonic(), lifetime.wallDeadline - this.time.wall(), bound ?? Infinity);
    lifetime.timer = setTimeout(() => this.retire(lifetime), Math.max(0, remaining));
    lifetime.timer.unref?.();
  }
  private retire(lifetime: Lifetime): void {
    if (lifetime.timer) { clearTimeout(lifetime.timer); lifetime.timer = null; }
    this.sessions.delete(lifetime.sessionId);
    this.options.auth.closeClient(lifetime.sessionId);
    if (this.records.get(lifetime.commandId) === lifetime) this.records.delete(lifetime.commandId);
    if (!lifetime.stop.signal.aborted) lifetime.stop.abort(new Error("accepted_work_rejected"));
    if (lifetime.reserved) {
      lifetime.reserved = false;
      try { this.options.ledger.close(lifetime.commandId); } catch { /* local authority is already terminal; reopen quarantines it */ }
    }
  }

  async accept(input: AcceptedWorkInput): Promise<{ work: CloudAcceptedWork; snapshot: CloudBootCommandSnapshot }> {
    this.assertEngine();
    const mutation = CloudBootCommandMutationSchema.parse(input.mutation);
    if (mutation.action.kind !== "enqueue") rejected();
    const commandId = mutation.action.commandId;
    if (this.attempts.has(commandId)) throw new Error("accepted_work_busy");
    if (!this.records.has(commandId) && new Set([...this.records.keys(), ...this.attempts.keys()]).size >= this.maxEntries)
      throw new Error("accepted_work_limit");
    // Copy the transient proof before the first await. The durable ledger
    // stores only the immutable command/authority identities, never this pair.
    const auth = { capability: input.auth.capability, proof: { ...input.auth.proof } };
    input = { ...input, mutation, auth };
    const wall = this.time.wall(), mono = this.time.monotonic();
    const lifetime: Lifetime = { commandId, sessionId: randomUUID(), stop: new AbortController(), wallDeadline: wall + ENROLLMENT_BOUND_MS,
      deadline: mono + ENROLLMENT_BOUND_MS, timer: null, reserved: false, ioPending: false, done: false };
    this.attempts.set(commandId, lifetime);
    this.schedule(lifetime);
    try {
      const verified = await this.options.auth.verifyClient(auth, input.route);
      if (!verified.ok || lifetime.stop.signal.aborted) rejected();
      this.assertClient(input, verified);
      const reservation = this.options.ledger.reserve({ mutation, actorSessionId: input.actorSessionId, cwd: input.cwd, executionId: input.executionId,
        capabilityId: verified.claims.jti, kid: verified.header.kid, capabilityExpiresAtMs: verified.claims.exp * 1000 });
      // Own cleanup immediately, including a binding failure before CP I/O.
      // An immutable retry must never acquire ownership of the prior lifetime.
      lifetime.reserved = !reservation.receipt;
      this.assertReservation(reservation, verified);
      if (reservation.receipt) {
        const existing = this.records.get(commandId)?.work;
        if (!existing || !isDeepStrictEqual(existing.receipt, reservation.receipt)) rejected();
        existing.assertLive();
        return { work: existing, snapshot: this.options.ledger.commit(commandId, reservation.receipt, () => existing.assertLive()) };
      }
      lifetime.wallDeadline = verified.claims.exp * 1000;
      lifetime.deadline = mono + lifetime.wallDeadline - wall;
      this.sessions.set(lifetime.sessionId, lifetime);
      this.options.auth.admit(lifetime.sessionId, verified, input.route);
      this.assertLifetime(lifetime);
      const request = CloudAcceptedWorkEnrollRequestSchema.parse({ version: 1, scope: this.options.ledger.scope,
        runtimeId: this.options.runtimeId, actorSessionId: input.actorSessionId, command: reservation.command, ...auth, route: input.route });
      const receipt = CloudAcceptedWorkReceiptSchema.parse(await this.enroll(lifetime, request));
      if (!isDeepStrictEqual(receipt.scope, this.options.ledger.scope) || !isDeepStrictEqual(receipt.command, reservation.command) ||
        !isDeepStrictEqual(receipt.actor, reservation.actor.actor) || receipt.actorSessionId !== input.actorSessionId ||
        receipt.runtimeId !== this.options.runtimeId || receipt.sourceSessionId !== verified.claims.sid || receipt.kid !== verified.header.kid ||
        receipt.capabilityId !== verified.claims.jti || receipt.capabilityExpiresAtMs !== verified.claims.exp * 1000 ||
        receipt.devicePublicKey !== verified.claims.cnf!.jwk.x || !isDeepStrictEqual(receipt.epochs, verified.claims.ep) ||
        !isDeepStrictEqual([...receipt.scopes].sort(), [...verified.claims.scp].sort())) rejected();
      lifetime.wallDeadline = Math.min(lifetime.wallDeadline, receipt.providerExpiresAtMs);
      lifetime.deadline = Math.min(lifetime.deadline, mono + lifetime.wallDeadline - wall);
      const recheck = () => { this.assertLifetime(lifetime); this.assertClient(input, verified); };
      const snapshot = this.options.ledger.commit(commandId, receipt, recheck);
      const work = Object.freeze({ receipt: freezeCloudSnapshot(receipt), signal: lifetime.stop.signal,
        assertLive: (operation: "run" | "context" | "native-git" = "run") => this.assertWork(lifetime, operation) }) as CloudAcceptedWork;
      lifetime.work = work; this.records.set(commandId, lifetime); genuine.add(work);
      this.schedule(lifetime); work.assertLive();
      return { work, snapshot };
    } catch (error) {
      this.retire(lifetime); throw error;
    } finally {
      lifetime.done = true;
      if (!lifetime.work && lifetime.timer) { clearTimeout(lifetime.timer); lifetime.timer = null; }
      if (!lifetime.ioPending && this.attempts.get(commandId) === lifetime) this.attempts.delete(commandId);
    }
  }

  private assertReservation(reservation: AcceptedReservation, verified: CapabilityVerifySuccess): void {
    const { actor, authorityEpoch } = reservation.actor, { claims } = verified;
    if (actor.userId !== claims.sub.slice(5) || actor.deviceId !== claims.did || actor.deviceKeyVersion !== claims.ep.dk ||
      actor.role !== claims.role || authorityEpoch !== claims.ep.wa) rejected();
  }
  private enroll(lifetime: Lifetime, request: CloudAcceptedWorkEnrollRequest): Promise<unknown> {
    lifetime.ioPending = true;
    return new Promise((resolve, reject) => {
      const aborted = () => reject(new Error("accepted_work_rejected"));
      lifetime.stop.signal.addEventListener("abort", aborted, { once: true });
      const finished = () => {
        lifetime.stop.signal.removeEventListener("abort", aborted); lifetime.ioPending = false;
        if (lifetime.done && this.attempts.get(lifetime.commandId) === lifetime) this.attempts.delete(lifetime.commandId);
      };
      void Promise.resolve().then(() => {
        this.assertLifetime(lifetime);
        return this.options.enroll(request, lifetime.stop.signal);
      }).then(value => { finished(); resolve(value); }, error => { finished(); reject(error); });
      if (lifetime.stop.signal.aborted) aborted();
    });
  }
  private assertWork(lifetime: Lifetime, operation: "run" | "context" | "native-git"): void {
    this.assertLifetime(lifetime);
    const work = lifetime.work, row = this.options.ledger.get(lifetime.commandId);
    if (!work || this.records.get(lifetime.commandId) !== lifetime || row?.state !== "accepted" ||
      !isDeepStrictEqual(row.receipt, work.receipt)) { this.retire(lifetime); rejected(); }
    if (!["run", "context", "native-git"].includes(operation) || !work.receipt.scopes.includes(operation === "native-git" ? "ws:edit" : "ws:prompt")) rejected();
  }
  get(commandId: string): CloudAcceptedWork | undefined {
    const work = this.records.get(commandId)?.work;
    if (!work) return undefined;
    try { work.assertLive(); return work; } catch { return undefined; }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.unsubscribe();
    for (const lifetime of new Set([...this.records.values(), ...this.attempts.values()])) this.retire(lifetime);
  }
}
export function isCloudAcceptedWork(value: unknown): value is CloudAcceptedWork {
  return !!value && typeof value === "object" && genuine.has(value);
}
