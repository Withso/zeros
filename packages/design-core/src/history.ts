import {
  assertDesignTransactionInputSize,
  DESIGN_TRANSACTION_MAX_OPERATIONS,
  DESIGN_FOUNDATION_SCHEMA_VERSION,
  designTransactionSchema,
  type DesignActor,
  type DesignOperation,
  type DesignTransaction,
} from "./schema";
import {
  applyDesignTransaction,
  canonicalDesignJson,
  DesignTransactionIdReuseError,
  designTransactionSignature,
  type DesignTransactionAdapter,
  type DesignTransactionOutcome,
  type DesignTransactionReceipt,
} from "./transaction";

export interface DesignHistoryOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxReceipts?: number;
  maxReceiptBytes?: number;
  coalesceWindowMs?: number;
  now?: () => number;
}

export interface DesignHistoryStatus {
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  redoDepth: number;
  retainedBytes: number;
  retainedReceiptBytes: number;
  revision: string;
  lastReconciliationReason: string | null;
}

interface DesignHistoryEntry {
  transactionId: string;
  documentId: string;
  actor: DesignActor;
  intent: string;
  createdAt: number;
  coalesceKey?: string;
  operations: DesignOperation[];
  inverseOperations: DesignOperation[];
  beforeRevision: string;
  afterRevision: string;
  bytes: number;
}

interface RetainedReceipt {
  signature: string;
  receipt: DesignTransactionReceipt;
  bytes: number;
}

interface DesignTransactionSessionCheckpoint<State> {
  state: State;
  undoStack: DesignHistoryEntry[];
  redoStack: DesignHistoryEntry[];
  receipts: Array<[string, RetainedReceipt]>;
  retainedBytes: number;
  retainedReceiptBytes: number;
  sequence: number;
  lastReconciliationReason: string | null;
}

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_RECEIPTS = 512;
const DEFAULT_MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const DEFAULT_COALESCE_WINDOW_MS = 750;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.min(max, Math.max(min, Math.round(value)));
}

function historyEntryBytes(entry: Omit<DesignHistoryEntry, "bytes">): number {
  return canonicalDesignJson(entry).length * 2;
}

function copyReceipt(
  receipt: DesignTransactionReceipt,
  status = receipt.status,
): DesignTransactionReceipt {
  return {
    ...receipt,
    status,
    actor: { ...receipt.actor },
    affectedNodeIds: [...receipt.affectedNodeIds],
    affectedFiles: [...receipt.affectedFiles],
  };
}

function copyHistoryEntry(entry: DesignHistoryEntry): DesignHistoryEntry {
  return {
    ...entry,
    actor: { ...entry.actor },
    operations: [...entry.operations],
    inverseOperations: [...entry.inverseOperations],
  };
}

function retainedReceiptBytes(
  signature: string,
  receipt: DesignTransactionReceipt,
): number {
  return signature.length * 2 + canonicalDesignJson(receipt).length * 2;
}

/** Bounded, exact-revision editing session. It stores semantic operations and
 * inverses, never full rendered snapshots or screenshots. */
export class DesignTransactionSession<State> {
  private state: State;
  private readonly undoStack: DesignHistoryEntry[] = [];
  private readonly redoStack: DesignHistoryEntry[] = [];
  private readonly receipts = new Map<string, RetainedReceipt>();
  private retainedBytes = 0;
  private retainedReceiptBytes = 0;
  private sequence = 0;
  private lastReconciliationReason: string | null = null;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxReceipts: number;
  private readonly maxReceiptBytes: number;
  private readonly coalesceWindowMs: number;
  private readonly now: () => number;

  constructor(
    initialState: State,
    private readonly adapter: DesignTransactionAdapter<State>,
    options: DesignHistoryOptions = {},
  ) {
    this.state = initialState;
    this.maxEntries = boundedInteger(
      options.maxEntries,
      DEFAULT_MAX_ENTRIES,
      1,
      10_000,
    );
    this.maxBytes = boundedInteger(
      options.maxBytes,
      DEFAULT_MAX_BYTES,
      4_096,
      64 * 1024 * 1024,
    );
    this.maxReceipts = boundedInteger(
      options.maxReceipts,
      DEFAULT_MAX_RECEIPTS,
      1,
      10_000,
    );
    this.maxReceiptBytes = boundedInteger(
      options.maxReceiptBytes,
      DEFAULT_MAX_RECEIPT_BYTES,
      4_096,
      64 * 1024 * 1024,
    );
    this.coalesceWindowMs = boundedInteger(
      options.coalesceWindowMs,
      DEFAULT_COALESCE_WINDOW_MS,
      0,
      60_000,
    );
    this.now = options.now ?? Date.now;
  }

  currentState(): State {
    return this.state;
  }

  /** A cheap checkpoint for repository two-phase commit. Document states and
   * operations are immutable; only the bounded stack containers are copied. */
  checkpoint(): DesignTransactionSessionCheckpoint<State> {
    return {
      state: this.state,
      undoStack: this.undoStack.map(copyHistoryEntry),
      redoStack: this.redoStack.map(copyHistoryEntry),
      receipts: [...this.receipts.entries()].map(([id, retained]) => [
        id,
        {
          signature: retained.signature,
          receipt: copyReceipt(retained.receipt),
          bytes: retained.bytes,
        },
      ]),
      retainedBytes: this.retainedBytes,
      retainedReceiptBytes: this.retainedReceiptBytes,
      sequence: this.sequence,
      lastReconciliationReason: this.lastReconciliationReason,
    };
  }

  restore(checkpoint: DesignTransactionSessionCheckpoint<State>): void {
    this.state = checkpoint.state;
    this.undoStack.splice(
      0,
      this.undoStack.length,
      ...checkpoint.undoStack.map(copyHistoryEntry),
    );
    this.redoStack.splice(
      0,
      this.redoStack.length,
      ...checkpoint.redoStack.map(copyHistoryEntry),
    );
    this.receipts.clear();
    for (const [id, retained] of checkpoint.receipts) {
      this.receipts.set(id, {
        signature: retained.signature,
        receipt: copyReceipt(retained.receipt),
        bytes: retained.bytes,
      });
    }
    this.retainedBytes = checkpoint.retainedBytes;
    this.retainedReceiptBytes = checkpoint.retainedReceiptBytes;
    this.sequence = checkpoint.sequence;
    this.lastReconciliationReason = checkpoint.lastReconciliationReason;
  }

  status(): DesignHistoryStatus {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
      retainedBytes: this.retainedBytes,
      retainedReceiptBytes: this.retainedReceiptBytes,
      revision: this.adapter.revision(this.state),
      lastReconciliationReason: this.lastReconciliationReason,
    };
  }

  apply(input: DesignTransaction | unknown): DesignTransactionOutcome<State> {
    assertDesignTransactionInputSize(input);
    const transaction = designTransactionSchema.parse(input);
    const signature = designTransactionSignature(transaction);
    const retained = this.receipts.get(transaction.transactionId);
    if (retained) {
      if (retained.signature !== signature) {
        throw new DesignTransactionIdReuseError(transaction.transactionId);
      }
      this.touchReceipt(transaction.transactionId, retained);
      return {
        state: this.state,
        inverseOperations: [],
        receipt: copyReceipt(retained.receipt, "duplicate"),
      };
    }

    const outcome = applyDesignTransaction(
      this.state,
      transaction,
      this.adapter,
    );
    this.state = outcome.state;
    this.retainReceipt(transaction.transactionId, {
      signature,
      receipt: copyReceipt(outcome.receipt),
    });
    if (outcome.receipt.status === "applied") {
      this.clearRedo();
      this.record(transaction, outcome);
    }
    this.lastReconciliationReason = null;
    return outcome;
  }

  undo(actor?: DesignActor): DesignTransactionOutcome<State> | null {
    const entry = this.undoStack.at(-1);
    if (!entry) return null;
    if (
      actor &&
      (entry.actor.kind !== actor.kind || entry.actor.id !== actor.id)
    ) {
      return null;
    }
    const history = this.applyHistoryAction(
      "undo",
      entry,
      entry.inverseOperations,
      actor ?? entry.actor,
    );
    this.undoStack.pop();
    this.redoStack.push(entry);
    this.state = history.outcome.state;
    this.retainReceipt(history.outcome.receipt.transactionId, {
      signature: history.signature,
      receipt: copyReceipt(history.outcome.receipt),
    });
    return history.outcome;
  }

  redo(actor?: DesignActor): DesignTransactionOutcome<State> | null {
    const entry = this.redoStack.at(-1);
    if (!entry) return null;
    if (
      actor &&
      (entry.actor.kind !== actor.kind || entry.actor.id !== actor.id)
    ) {
      return null;
    }
    const history = this.applyHistoryAction(
      "redo",
      entry,
      entry.operations,
      actor ?? entry.actor,
    );
    this.redoStack.pop();
    this.undoStack.push(entry);
    this.state = history.outcome.state;
    this.retainReceipt(history.outcome.receipt.transactionId, {
      signature: history.signature,
      receipt: copyReceipt(history.outcome.receipt),
    });
    this.pruneHistory();
    return history.outcome;
  }

  /** Reconcile an external source generation. Exact-equal revisions retain
   * history; a different revision clears history that could no longer be
   * inverted safely. */
  reconcile(
    nextState: State,
    reason: string,
  ): { changed: boolean; historyCleared: boolean } {
    const previousRevision = this.adapter.revision(this.state);
    const nextRevision = this.adapter.revision(nextState);
    this.state = nextState;
    if (previousRevision === nextRevision) {
      return { changed: false, historyCleared: false };
    }
    const historyCleared =
      this.undoStack.length > 0 || this.redoStack.length > 0;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.retainedBytes = 0;
    this.lastReconciliationReason = reason.slice(0, 1_000);
    return { changed: true, historyCleared };
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.receipts.clear();
    this.retainedBytes = 0;
    this.retainedReceiptBytes = 0;
    this.lastReconciliationReason = null;
  }

  private record(
    transaction: DesignTransaction,
    outcome: DesignTransactionOutcome<State>,
  ): void {
    const previous = this.undoStack.at(-1);
    if (
      previous &&
      transaction.coalesceKey &&
      previous.coalesceKey === transaction.coalesceKey &&
      previous.documentId === transaction.documentId &&
      previous.actor.kind === transaction.actor.kind &&
      previous.actor.id === transaction.actor.id &&
      transaction.createdAt >= previous.createdAt &&
      transaction.createdAt - previous.createdAt <= this.coalesceWindowMs &&
      previous.operations.length + transaction.operations.length <=
        DESIGN_TRANSACTION_MAX_OPERATIONS
    ) {
      this.retainedBytes -= previous.bytes;
      previous.transactionId = transaction.transactionId;
      previous.intent = transaction.intent;
      previous.createdAt = transaction.createdAt;
      previous.operations.push(...transaction.operations);
      previous.inverseOperations.unshift(...outcome.inverseOperations);
      previous.afterRevision = outcome.receipt.afterRevision;
      previous.bytes = historyEntryBytes({
        transactionId: previous.transactionId,
        documentId: previous.documentId,
        actor: previous.actor,
        intent: previous.intent,
        createdAt: previous.createdAt,
        ...(previous.coalesceKey ? { coalesceKey: previous.coalesceKey } : {}),
        operations: previous.operations,
        inverseOperations: previous.inverseOperations,
        beforeRevision: previous.beforeRevision,
        afterRevision: previous.afterRevision,
      });
      this.retainedBytes += previous.bytes;
      this.pruneHistory();
      return;
    }

    const base: Omit<DesignHistoryEntry, "bytes"> = {
      transactionId: transaction.transactionId,
      documentId: transaction.documentId,
      actor: { ...transaction.actor },
      intent: transaction.intent,
      createdAt: transaction.createdAt,
      ...(transaction.coalesceKey
        ? { coalesceKey: transaction.coalesceKey }
        : {}),
      operations: [...transaction.operations],
      inverseOperations: [...outcome.inverseOperations],
      beforeRevision: outcome.receipt.beforeRevision,
      afterRevision: outcome.receipt.afterRevision,
    };
    const entry: DesignHistoryEntry = {
      ...base,
      bytes: historyEntryBytes(base),
    };
    this.undoStack.push(entry);
    this.retainedBytes += entry.bytes;
    this.pruneHistory();
  }

  /** Apply trusted, adapter-generated history operations in schema-bounded
   * chunks against local immutable state. Nothing is published until every
   * chunk succeeds, so an unusually wide inverse remains one atomic undo. */
  private applyHistoryAction(
    mode: "undo" | "redo",
    entry: DesignHistoryEntry,
    operations: readonly DesignOperation[],
    actor: DesignActor,
  ): {
    outcome: DesignTransactionOutcome<State>;
    signature: string;
  } {
    if (operations.length === 0) {
      throw new Error(`Design history entry cannot be ${mode}ne safely.`);
    }
    let transactionId: string;
    do {
      this.sequence += 1;
      transactionId = `history.${mode}.${this.sequence}`;
    } while (this.receipts.has(transactionId));
    const beforeRevision = this.adapter.revision(this.state);
    const intent =
      `${mode === "undo" ? "Undo" : "Redo"}: ${entry.intent}`.slice(0, 1_000);
    const rawCreatedAt = this.now();
    const createdAt = Number.isFinite(rawCreatedAt)
      ? Math.max(0, Math.round(rawCreatedAt))
      : 0;
    let state = this.state;
    let changed = false;
    const affectedNodeIds = new Set<string>();
    const affectedFiles = new Set<string>();
    for (
      let offset = 0;
      offset < operations.length;
      offset += DESIGN_TRANSACTION_MAX_OPERATIONS
    ) {
      const chunk = operations
        .slice(offset, offset + DESIGN_TRANSACTION_MAX_OPERATIONS)
        .map((operation, index) => ({
          ...operation,
          operationId: `history.${mode}.${this.sequence}.${offset + index}`,
        })) as DesignOperation[];
      const chunkOutcome = applyDesignTransaction(
        state,
        {
          schemaVersion: DESIGN_FOUNDATION_SCHEMA_VERSION,
          transactionId: `${transactionId}.${offset / DESIGN_TRANSACTION_MAX_OPERATIONS}`,
          documentId: entry.documentId,
          baseRevision: this.adapter.revision(state),
          actor,
          intent,
          createdAt,
          operations: chunk,
        },
        this.adapter,
      );
      state = chunkOutcome.state;
      changed = changed || chunkOutcome.receipt.status === "applied";
      for (const nodeId of chunkOutcome.receipt.affectedNodeIds) {
        if (affectedNodeIds.size < 512) affectedNodeIds.add(nodeId);
      }
      for (const file of chunkOutcome.receipt.affectedFiles) {
        if (affectedFiles.size < 512) affectedFiles.add(file);
      }
    }
    const afterRevision = this.adapter.revision(state);
    const outcome: DesignTransactionOutcome<State> = {
      state,
      inverseOperations: [],
      receipt: {
        transactionId,
        documentId: entry.documentId,
        status: changed ? "applied" : "noop",
        beforeRevision,
        afterRevision,
        actor,
        intent,
        operationCount: operations.length,
        affectedNodeIds: [...affectedNodeIds],
        affectedFiles: [...affectedFiles],
      },
    };
    return {
      outcome,
      signature: canonicalDesignJson({
        transactionId,
        mode,
        sourceTransactionId: entry.transactionId,
        beforeRevision,
        afterRevision,
      }),
    };
  }

  private pruneHistory(): void {
    while (
      this.undoStack.length > this.maxEntries ||
      this.retainedBytes > this.maxBytes
    ) {
      const removed = this.undoStack.shift();
      if (!removed) break;
      this.retainedBytes -= removed.bytes;
    }
    this.retainedBytes = Math.max(0, this.retainedBytes);
  }

  private clearRedo(): void {
    for (const entry of this.redoStack) {
      this.retainedBytes -= entry.bytes;
    }
    this.redoStack.length = 0;
    this.retainedBytes = Math.max(0, this.retainedBytes);
  }

  private retainReceipt(
    id: string,
    receipt: Omit<RetainedReceipt, "bytes">,
  ): void {
    const previous = this.receipts.get(id);
    if (previous) this.retainedReceiptBytes -= previous.bytes;
    this.receipts.delete(id);
    const retained = {
      ...receipt,
      bytes: retainedReceiptBytes(receipt.signature, receipt.receipt),
    };
    this.receipts.set(id, retained);
    this.retainedReceiptBytes += retained.bytes;
    while (
      this.receipts.size > this.maxReceipts ||
      this.retainedReceiptBytes > this.maxReceiptBytes
    ) {
      const oldest = this.receipts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.retainedReceiptBytes -= this.receipts.get(oldest)?.bytes ?? 0;
      this.receipts.delete(oldest);
    }
    this.retainedReceiptBytes = Math.max(0, this.retainedReceiptBytes);
  }

  private touchReceipt(id: string, receipt: RetainedReceipt): void {
    this.receipts.delete(id);
    this.receipts.set(id, receipt);
  }
}
