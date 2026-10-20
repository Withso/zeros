import { z } from "zod";
import { CompleteCheckpointAttemptSchema, CompleteCheckpointSourceSchema, CompleteCheckpointReceiptSchema,
  completeCheckpointScopeKey, sameCompleteCheckpointSource, type CompleteCheckpointAttempt,
  type CompleteCheckpointSource, type CompleteCheckpointReceipt } from "./cloud-complete-checkpoint-contract";
import type { CompleteCheckpointOptions, CompleteCheckpointOutcome } from "./cloud-complete-checkpoint-coordinator";
import type { CloudDurabilityAuthority } from "./cloud-durability-runtime";

const sequence = z.number().int().nonnegative().safe(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const cutSchema = z.object({ attemptId: z.string().uuid(), source: CompleteCheckpointSourceSchema, cutAtMs: sequence,
  inventorySha256: digest }).strict();
const exportSchema = cutSchema.extend({ manifestSha256: digest, nativeExportSha256: digest }).strict();
export type CompleteCut = z.infer<typeof cutSchema>;
export type CompleteExport = z.infer<typeof exportSchema>;
const retiredSchema = z.object({ status: z.literal("retired"), operationId: z.string().uuid(), attemptId: z.string().uuid(),
  source: CompleteCheckpointSourceSchema }).strict();
type Retired = z.infer<typeof retiredSchema>;

/** Local trusted ports, not schemas that authenticate a remote helper. The
 * qualified Host adapter owns original process/FD/channel and persistent
 * custody. prepare publishes its handle before starting any asynchronous IO.
 * retire joins every operation, including uncertain publication; it keeps
 * immutable original reference guards until verify/close. It never treats a
 * timeout, cancellation, child exit or HTTP ACK alone as positive retirement.
 * No implementation or passing default of these ports is installed here. */
export interface CompleteCheckpointOperation<T> {
  readonly operationId: string;
  readonly attemptId: string;
  readonly source: CompleteCheckpointSource;
  run(signal: AbortSignal): Promise<T>;
  retire(): Promise<Retired>;
  verify(): void;
  close(): void;
}
type Context = { attempt: CompleteCheckpointAttempt; authority: CloudDurabilityAuthority; guard(): void };
export type CompleteCaptureAdapters = {
  source: CompleteCheckpointSource;
  currentSource(): CompleteCheckpointSource | null;
  now(): number;
  monotonicNow(): number;
  /** Cheap support probe only. The Host still verifies original qualified
   * support and all-writer admission before any native freeze. */
  qualified(): boolean;
  cleanupRetryMs: number;
  cut: { prepare(context: Context): CompleteCheckpointOperation<CompleteCut> };
  /** Must prove exhaustive scope/Git closure and the periodic native policy
   * from immutable staging, after positive writer thaw. Raw managed state can
   * never pass directly to privateStore. No default scope policy is supplied. */
  export: { prepare(context: Context, cut: CompleteCut): CompleteCheckpointOperation<CompleteExport> };
  privateStore: { prepare(context: Context, exported: CompleteExport): CompleteCheckpointOperation<CompleteCheckpointReceipt> };
  observeUnknown(evidence: { attemptId: string; reason: "retirement_unknown" }): void;
};
type Failure = Extract<CompleteCheckpointOutcome, { status: "failed" }>["reason"];
function unconfirmed(): never { throw new Error("complete checkpoint capture unconfirmed"); }

/** Dormant adapter for the 1a coordinator. An uncertain owned operation keeps
 * its original handle and a referenced cleanup wait; only confirmed retirement
 * permits settlement. Attempts and deadline never change during cleanup. */
export function createCompleteCheckpointCapture(adapters: CompleteCaptureAdapters): CompleteCheckpointOptions["capture"] {
  const original = CompleteCheckpointSourceSchema.parse(adapters.source);
  const key = completeCheckpointScopeKey(original);
  if (!Number.isSafeInteger(adapters.cleanupRetryMs) || adapters.cleanupRetryMs < 1 || adapters.cleanupRetryMs > 60_000
    || !adapters.cut || !adapters.export || !adapters.privateStore) unconfirmed();
  let retained: CompleteCheckpointOperation<unknown>[] | null = null;
  return async (rawAttempt, authority, signal) => {
    if (retained) unconfirmed();
    const attempt = CompleteCheckpointAttemptSchema.parse(rawAttempt);
    Object.freeze(attempt.source); Object.freeze(attempt);
    if (completeCheckpointScopeKey(attempt.source) !== key
      || (["organizationId", "workspaceId", "generation", "engineInstanceId"] as const).some(name => attempt.source[name] !== authority[name])) unconfirmed();
    const startWall = adapters.now(), startMono = adapters.monotonicNow();
    if (!Number.isSafeInteger(startWall) || startWall < attempt.startedAtMs || !Number.isFinite(startMono) || startMono < 0) unconfirmed();
    const remaining = attempt.deadlineAtMs - startWall;
    if (remaining > 2 ** 31 - 1) unconfirmed();
    const operations: CompleteCheckpointOperation<unknown>[] = [];
    retained = operations;
    let first: Failure | null = null, previousMono = startMono, receipt: CompleteCheckpointReceipt | null = null;
    let unknownReported = false, closed = false;
    const controller = new AbortController();
    const fail = (reason: Failure) => { first ??= reason; };
    const cancel = () => { controller.abort(); };
    signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
    const timer = setTimeout(cancel, Math.max(0, remaining));
    const guard = () => {
      const now = adapters.now(), mono = adapters.monotonicNow();
      if (!Number.isSafeInteger(now) || !Number.isFinite(mono) || now < attempt.startedAtMs || mono < previousMono) fail("clock_invalid");
      else if (now >= attempt.deadlineAtMs || mono - startMono >= remaining) fail("deadline");
      previousMono = mono;
      if (controller.signal.aborted) fail("capture_failed");
      const current = CompleteCheckpointSourceSchema.safeParse(adapters.currentSource());
      if (!current.success || completeCheckpointScopeKey(current.data) !== key
        || current.data.changeSequence < attempt.source.changeSequence || current.data.reconcileSequence < attempt.source.reconcileSequence) fail("coverage_unknown");
      if (first !== null) throw new Error("complete capture refused");
    };
    const context: Context = { attempt, authority: { ...authority }, guard };
    const owned = <T>(operation: CompleteCheckpointOperation<T>): CompleteCheckpointOperation<T> => {
      operations.push(operation);
      if (!z.string().uuid().safeParse(operation.operationId).success || operation.attemptId !== attempt.id
        || !sameCompleteCheckpointSource(CompleteCheckpointSourceSchema.parse(operation.source), attempt.source)
        || operations.slice(0, -1).some(prior => prior.operationId === operation.operationId)) unconfirmed();
      return operation;
    };
    const boundCut = (cut: CompleteCut) => {
      if (cut.attemptId !== attempt.id || !sameCompleteCheckpointSource(cut.source, attempt.source)
        || cut.cutAtMs < attempt.startedAtMs || cut.cutAtMs > adapters.now() || cut.cutAtMs >= attempt.deadlineAtMs) throw new Error("complete cut refused");
    };
    const reportUnknown = () => {
      fail("coverage_unknown");
      if (!unknownReported) {
        unknownReported = true;
        try { adapters.observeUnknown({ attemptId: attempt.id, reason: "retirement_unknown" }); } catch { /* Cannot release custody. */ }
      }
    };
    const retired = new Set<CompleteCheckpointOperation<unknown>>();
    const retire = async (operation: CompleteCheckpointOperation<unknown>) => {
      if (retired.has(operation)) return;
      for (;;) {
        try {
          const result = retiredSchema.parse(await operation.retire());
          if (result.operationId !== operation.operationId || result.attemptId !== attempt.id
            || !sameCompleteCheckpointSource(result.source, attempt.source)) throw new Error("retirement differs");
          retired.add(operation); return;
        } catch {
          reportUnknown(); controller.abort();
          await new Promise<void>(resolve => { setTimeout(resolve, adapters.cleanupRetryMs); });
        }
      }
    };
    try {
      try {
        guard();
        if (!adapters.qualified()) { fail("admission_deferred"); throw new Error("complete support unavailable"); }
        const cutOp = owned(adapters.cut.prepare(context)); guard();
        const cut = cutSchema.parse(await cutOp.run(controller.signal)); guard(); boundCut(cut); cutOp.verify();
        // Native thaw/join precedes semantic export and every remote operation.
        // Retirement retains immutable references until final verification.
        await retire(cutOp); cutOp.verify(); guard();
        const exportOp = owned(adapters.export.prepare(context, cut)); guard();
        const exported = exportSchema.parse(await exportOp.run(controller.signal)); guard(); boundCut(exported);
        if (exported.cutAtMs !== cut.cutAtMs || exported.inventorySha256 !== cut.inventorySha256) throw new Error("complete export differs");
        await retire(exportOp); exportOp.verify(); guard();
        const storeOp = owned(adapters.privateStore.prepare(context, exported)); guard();
        receipt = CompleteCheckpointReceiptSchema.parse(await storeOp.run(controller.signal)); guard();
        if (receipt.attemptId !== attempt.id || !sameCompleteCheckpointSource(receipt.source, attempt.source)
          || receipt.cutAtMs !== exported.cutAtMs || receipt.ackAtMs > adapters.now()
          || receipt.ackAtMs >= attempt.deadlineAtMs || receipt.manifestSha256 !== exported.manifestSha256
          || receipt.inventorySha256 !== exported.inventorySha256 || receipt.nativeExportSha256 !== exported.nativeExportSha256) throw new Error("private receipt differs");
      } catch { fail("capture_failed"); controller.abort(); }
      // Reverse acquisition order: immutable sources remain held until all
      // dependent upload/export IO is joined. No deadline race settles this.
      for (const operation of [...operations].reverse()) await retire(operation);
      // The selected immutable artifacts and exact source are checked after
      // child/stream/remote retirement IO, with original anchors still held.
      for (const operation of operations) try { operation.verify(); } catch { fail("coverage_unknown"); }
      try { guard(); } catch { fail("capture_failed"); }
      let closeFailed = false;
      for (const operation of [...operations].reverse()) try { operation.close(); } catch { closeFailed = true; }
      if (closeFailed) { reportUnknown(); return unconfirmed(); }
      closed = true;
      try { guard(); } catch { fail("capture_failed"); }
      if (first !== null || receipt === null) return { status: "failed", retirement: "confirmed", reason: first ?? "capture_failed" };
      return { status: "committed", retirement: "confirmed", receipt };
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", cancel);
      if (closed) retained = null;
    }
  };
}
