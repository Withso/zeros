import { isDeepStrictEqual } from "node:util";
import { CloudCommandFailureError } from "@zeros/protocol/cloud-commands";
import { CloudExecutionEnrollRequestSchema, CloudExecutionAuthorityReceiptSchema, CloudExecutionAuthorityCheckSchema,
  type CloudExecutionEnrollRequest, type CloudExecutionAuthorityReceipt, type CloudExecutionAuthorityOperation } from "@zeros/protocol/cloud-execution-authority";
import type { CloudActorProvenance } from "@zeros/protocol/cloud-agent-bootstrap";
import { freezeCloudSnapshot } from "./cloud-mcp";

declare const executionWork: unique symbol;
/** Genuine local ownership of one CP-accepted command, never an actor or a
 * token. A parsed receipt cannot be used to construct this object. */
export type CloudExecutionWork = Readonly<{ readonly [executionWork]: true;
  receipt: Readonly<CloudExecutionAuthorityReceipt>; signal: AbortSignal;
  assertLive(): void; close(): Promise<void> }>;
const genuine = new WeakSet<object>();
export const isCloudExecutionWork = (value: unknown): value is CloudExecutionWork =>
  !!value && typeof value === "object" && genuine.has(value);
type Clock = { wall(): number; monotonic(): number };
export type CloudExecutionAuthorityOptions = {
  runtimeId: string; engineLive(): boolean;
  enroll(request: CloudExecutionEnrollRequest, signal: AbortSignal): Promise<unknown>;
  check(request: CloudExecutionAuthorityOperation, signal: AbortSignal): Promise<unknown>;
  close(request: CloudExecutionAuthorityOperation, signal: AbortSignal): Promise<unknown>;
  time?: Clock;
};
type Record = { controller: AbortController; deadline: number; timer: ReturnType<typeof setTimeout> | null;
  poll: ReturnType<typeof setTimeout> | null; flight: Promise<void> | null; closing: Promise<void> | null;
  enrollment: Promise<CloudExecutionAuthorityReceipt> | null; receipt: CloudExecutionAuthorityReceipt | null;
  work: CloudExecutionWork | null; request: CloudExecutionEnrollRequest; detach(): void };
const failure = (category: "access_denied" | "session_expired" | "authority_timeout" | "authority_response_invalid" | "lifecycle_superseded" | "execution_limit") =>
  new CloudCommandFailureError({ stage: "admission", category });
const operation = (receipt: CloudExecutionAuthorityReceipt): CloudExecutionAuthorityOperation => ({ version: 1, scope: receipt.scope,
  acceptedWorkId: receipt.acceptedWorkId, commandId: receipt.command.commandId, claimId: receipt.claimId, executionId: receipt.command.executionId });

/** Admission is bounded by the original actor/context and ten seconds. Once
 * accepted, only the immutable work deadline, execution/runtime revocations
 * and explicit closure govern this command. Observation failures cannot grant
 * another command, extend a deadline or stop work inside that deadline. */
export class CloudExecutionAuthority {
  private readonly records = new Map<string, Record>();
  private readonly seen = new Set<string>();
  private readonly time: Clock;
  private disposed = false;
  constructor(private readonly options: CloudExecutionAuthorityOptions) {
    if (!/^r1-[a-f0-9]{64}$/.test(options.runtimeId)) throw failure("authority_response_invalid");
    this.time = options.time ?? { wall: () => Date.now(), monotonic: () => performance.now() };
  }
  private assert(record: Record): void {
    if (this.disposed || !this.options.engineLive()) this.retire(record, failure("lifecycle_superseded"));
    if (record.work && (this.time.wall() >= record.work.receipt.providerExpiresAtMs || this.time.monotonic() >= record.deadline))
      this.retire(record, failure("session_expired"));
    if (record.controller.signal.aborted) throw record.controller.signal.reason;
  }
  private retire(record: Record, error: Error): void {
    if (record.timer) { clearTimeout(record.timer); record.timer = null; }
    if (record.poll) { clearTimeout(record.poll); record.poll = null; }
    if (!record.controller.signal.aborted) record.controller.abort(error);
  }
  private scheduleDeadline(record: Record): void {
    if (record.timer) clearTimeout(record.timer);
    const remaining = Math.min(record.deadline - this.time.monotonic(), record.work!.receipt.providerExpiresAtMs - this.time.wall());
    record.timer = setTimeout(() => {
      record.timer = null;
      try { this.assert(record); this.scheduleDeadline(record); } catch { /* sticky deadline */ }
    }, Math.max(0, Math.min(remaining, 2_147_000_000)));
    record.timer.unref?.();
  }
  private scheduleCheck(record: Record): void {
    if (record.controller.signal.aborted || record.poll || record.flight) return;
    record.poll = setTimeout(() => {
      record.poll = null;
      const flight = (async () => {
        this.assert(record);
        const response = await this.options.check(operation(record.work!.receipt), AbortSignal.any([record.controller.signal, AbortSignal.timeout(10_000)]));
        this.assert(record);
        const check = CloudExecutionAuthorityCheckSchema.safeParse(response);
        // Only the exact authenticated closed revocation response is a policy
        // decision. Network errors, proxy 4xx and malformed bodies are not.
        if (check.success && check.data.acceptedWorkId === record.work!.receipt.acceptedWorkId && check.data.state === "revoked")
          this.retire(record, failure("access_denied"));
      })().catch(() => { /* Keep the original grant and its deadline. */ });
      record.flight = flight;
      void flight.finally(() => { record.flight = null; this.scheduleCheck(record); });
    }, 30_000);
    record.poll.unref?.();
  }
  async accept(value: CloudExecutionEnrollRequest, expected: { actor: CloudActorProvenance;
    credentialId: string; credentialRevision: number; revocation: AbortSignal; assertAdmission(): void }, signal: AbortSignal): Promise<CloudExecutionWork> {
    const request = CloudExecutionEnrollRequestSchema.parse(value), key = request.command.commandId;
    if (this.disposed || this.seen.has(key) || this.records.size >= 256 || this.seen.size >= 100_000)
      throw failure("execution_limit");
    if (request.runtimeId !== this.options.runtimeId || request.actorSessionId !== expected.actor.actorSessionId ||
      !isDeepStrictEqual(request.scope, expected.actor.scope)) throw failure("access_denied");
    expected.assertAdmission();
    const wall = this.time.wall(), mono = this.time.monotonic(), controller = new AbortController();
    const record: Record = { controller, deadline: mono + 10_000, timer: null, poll: null, flight: null, closing: null,
      work: null, request, detach: () => {}, enrollment: null, receipt: null };
    const revoked = () => this.retire(record, failure("access_denied"));
    const stopped = () => this.retire(record, failure("lifecycle_superseded"));
    expected.revocation.addEventListener("abort", revoked, { once: true });
    signal.addEventListener("abort", stopped, { once: true });
    record.detach = () => { expected.revocation.removeEventListener("abort", revoked); signal.removeEventListener("abort", stopped); };
    record.timer = setTimeout(() => this.retire(record, failure("authority_timeout")), 10_000); record.timer.unref?.();
    this.records.set(key, record); this.seen.add(key);
    let receipt: CloudExecutionAuthorityReceipt | null = null;
    let aborted!: () => void;
    const stoppedAdmission = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", aborted, { once: true });
    });
    void stoppedAdmission.catch(() => {});
    try {
      if (signal.aborted || expected.revocation.aborted) stopped();
      this.assert(record);
      record.enrollment = Promise.resolve().then(() => {
        this.assert(record); return this.options.enroll(request, controller.signal);
      }).then(value => {
        const result = CloudExecutionAuthorityReceiptSchema.parse(value);
        if (Object.keys(request).every(key => isDeepStrictEqual(result[key as keyof CloudExecutionEnrollRequest], request[key as keyof CloudExecutionEnrollRequest])))
          record.receipt = result;
        return result;
      });
      receipt = await Promise.race([record.enrollment, stoppedAdmission]);
      this.assert(record); expected.assertAdmission();
      if (this.time.monotonic() >= mono + 10_000 || this.time.wall() >= wall + 10_000 ||
        Object.keys(request).some(key => !isDeepStrictEqual(receipt![key as keyof CloudExecutionEnrollRequest], request[key as keyof CloudExecutionEnrollRequest])) ||
        !isDeepStrictEqual(receipt.actor, expected.actor.actor) || !isDeepStrictEqual(receipt.fundingGrant, expected.actor.fundingGrant) ||
        receipt.epochs.wa !== expected.actor.authorityEpoch || receipt.credentialId !== expected.credentialId ||
        receipt.credentialRevision !== expected.credentialRevision || this.time.wall() >= receipt.admissionExpiresAtMs)
        throw failure("authority_response_invalid");
      record.deadline = mono + receipt.providerExpiresAtMs - wall;
      const work = Object.freeze({ receipt: freezeCloudSnapshot(receipt), signal: controller.signal,
        assertLive: () => this.assert(record), close: () => this.closeRecord(record) }) as CloudExecutionWork;
      record.work = work; genuine.add(work);
      this.assert(record); this.scheduleDeadline(record); this.scheduleCheck(record);
      return work;
    } catch (error) {
      this.retire(record, failure("access_denied"));
      // Refuse within the admission budget, but retain a late transport and
      // any committed exact receipt until cleanup joins them.
      void this.closeRecord(record).catch(() => {});
      throw error;
    } finally { controller.signal.removeEventListener("abort", aborted); }
  }
  private closeRecord(record: Record): Promise<void> {
    if (record.closing) return record.closing;
    this.retire(record, failure("lifecycle_superseded")); record.detach();
    const closing = (async () => {
      // Keep the owner until the admitted observer I/O has settled.
      await record.enrollment?.catch(() => {});
      await record.flight;
      if (record.receipt) await this.options.close(operation(record.receipt), AbortSignal.timeout(10_000)).catch(() => {});
      this.records.delete(record.request.command.commandId);
    })();
    record.closing = closing; return closing;
  }
  /** The factory keeps the exact request while admission is pending, so a
   * Stop can join a late accepted receipt even when accept already refused. */
  closeCommand(value: CloudExecutionEnrollRequest): Promise<void> {
    const request = CloudExecutionEnrollRequestSchema.parse(value), record = this.records.get(request.command.commandId);
    if (!record) return Promise.resolve();
    if (!isDeepStrictEqual(request, record.request)) throw failure("access_denied");
    return this.closeRecord(record);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.records.values()].map(record => this.closeRecord(record)));
  }
}
