import {
  assertDesignTransactionInputSize,
  designTransactionSchema,
  type DesignActor,
  type DesignOperation,
  type DesignTransaction,
} from "./schema";

export type DesignTransactionStatus = "applied" | "noop" | "duplicate";

export interface DesignTransactionReceipt {
  transactionId: string;
  documentId: string;
  status: DesignTransactionStatus;
  beforeRevision: string;
  afterRevision: string;
  actor: DesignActor;
  intent: string;
  operationCount: number;
  affectedNodeIds: string[];
  affectedFiles: string[];
}

export interface DesignOperationApplyResult<State> {
  state: State;
  changed: boolean;
  /** Operations are already ordered for application during undo. */
  inverse: DesignOperation | readonly DesignOperation[];
  affectedNodeIds?: readonly string[];
  affectedFiles?: readonly string[];
}

/** The transaction engine owns ordering/history; a document adapter owns the
 * semantics of one operation and must return a new state without mutating the
 * supplied state. */
export interface DesignTransactionAdapter<State> {
  documentId(state: State): string;
  revision(state: State): string;
  apply(
    state: State,
    operation: DesignOperation,
  ): DesignOperationApplyResult<State>;
}

export interface DesignTransactionOutcome<State> {
  state: State;
  receipt: DesignTransactionReceipt;
  inverseOperations: DesignOperation[];
}

export class DesignTransactionConflictError extends Error {
  readonly code = "DESIGN_REVISION_CONFLICT";

  constructor(
    readonly documentId: string,
    readonly expectedRevision: string,
    readonly actualRevision: string,
  ) {
    super(
      `Design document ${documentId} changed: expected ${expectedRevision}, current ${actualRevision}.`,
    );
    this.name = "DesignTransactionConflictError";
  }
}

export class DesignTransactionDocumentError extends Error {
  readonly code = "DESIGN_DOCUMENT_MISMATCH";

  constructor(
    readonly expectedDocumentId: string,
    readonly actualDocumentId: string,
  ) {
    super(
      `Design transaction targets ${expectedDocumentId}, but the adapter opened ${actualDocumentId}.`,
    );
    this.name = "DesignTransactionDocumentError";
  }
}

export class DesignTransactionIdReuseError extends Error {
  readonly code = "DESIGN_TRANSACTION_ID_REUSED";

  constructor(readonly transactionId: string) {
    super(
      `Design transaction id was reused with different content: ${transactionId}.`,
    );
    this.name = "DesignTransactionIdReuseError";
  }
}

/** Stable JSON for idempotency and bounded history sizing. Inputs are schemas
 * parsed into JSON-compatible values before this is used. */
export function canonicalDesignJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const visit = (current: unknown): string => {
    if (current === null) return "null";
    if (typeof current === "string") return JSON.stringify(current);
    if (typeof current === "boolean") return current ? "true" : "false";
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(
          "Canonical design JSON cannot contain non-finite numbers.",
        );
      }
      return Object.is(current, -0) ? "0" : String(current);
    }
    if (Array.isArray(current)) {
      if (seen.has(current))
        throw new Error("Canonical design JSON cannot contain cycles.");
      seen.add(current);
      const result = `[${current.map(visit).join(",")}]`;
      seen.delete(current);
      return result;
    }
    if (typeof current === "object") {
      if (seen.has(current))
        throw new Error("Canonical design JSON cannot contain cycles.");
      seen.add(current);
      const record = current as Record<string, unknown>;
      const entries = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .map((key) => `${JSON.stringify(key)}:${visit(record[key])}`);
      seen.delete(current);
      return `{${entries.join(",")}}`;
    }
    throw new Error(`Canonical design JSON cannot contain ${typeof current}.`);
  };
  return visit(value);
}

export function designTransactionSignature(
  transaction: DesignTransaction,
): string {
  return canonicalDesignJson(transaction);
}

/** Apply an atomic transaction to an immutable adapter state. A thrown
 * operation leaves the caller's original state untouched because no partial
 * state escapes this function. */
export function applyDesignTransaction<State>(
  initialState: State,
  input: DesignTransaction | unknown,
  adapter: DesignTransactionAdapter<State>,
): DesignTransactionOutcome<State> {
  assertDesignTransactionInputSize(input);
  const transaction = designTransactionSchema.parse(input);
  const actualDocumentId = adapter.documentId(initialState);
  if (transaction.documentId !== actualDocumentId) {
    throw new DesignTransactionDocumentError(
      transaction.documentId,
      actualDocumentId,
    );
  }
  const beforeRevision = adapter.revision(initialState);
  if (transaction.baseRevision !== beforeRevision) {
    throw new DesignTransactionConflictError(
      actualDocumentId,
      transaction.baseRevision,
      beforeRevision,
    );
  }

  let state = initialState;
  let changed = false;
  const inverseOperations: DesignOperation[] = [];
  const affectedNodeIds = new Set<string>();
  const affectedFiles = new Set<string>();

  for (const operation of transaction.operations) {
    const result = adapter.apply(state, operation);
    state = result.state;
    changed = changed || result.changed;
    const inverse = Array.isArray(result.inverse)
      ? [...result.inverse]
      : [result.inverse];
    if (result.changed && inverse.length === 0) {
      throw new Error(
        `Changed design operation must provide an inverse: ${operation.operationId}.`,
      );
    }
    // Undo applies the latest operation's inverse first.
    inverseOperations.unshift(...inverse);
    for (const nodeId of result.affectedNodeIds ?? []) {
      if (affectedNodeIds.size < 512) affectedNodeIds.add(nodeId);
    }
    for (const file of result.affectedFiles ?? []) {
      if (affectedFiles.size < 512) affectedFiles.add(file);
    }
  }

  const afterRevision = adapter.revision(state);
  return {
    state,
    inverseOperations,
    receipt: {
      transactionId: transaction.transactionId,
      documentId: transaction.documentId,
      status: changed ? "applied" : "noop",
      beforeRevision,
      afterRevision,
      actor: transaction.actor,
      intent: transaction.intent,
      operationCount: transaction.operations.length,
      affectedNodeIds: [...affectedNodeIds],
      affectedFiles: [...affectedFiles],
    },
  };
}
