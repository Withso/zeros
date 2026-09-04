import { randomBytes } from "node:crypto";

import {
  designTransactionSchema,
  designTransactionSignature,
  type DesignActor,
  type DesignOperation,
  type DesignTransaction,
  DesignTransactionConflictError,
} from "@zeros/design-core";
import {
  DesignApi,
  DesignApiRepositoryConflictError,
  type DesignApiApplyResult,
  type DesignDocumentSummary,
  type DesignProjectionPage,
} from "@zeros/design-web";

import { DesignDraftStore } from "./design-api";

export const DESIGN_AGENT_CAPABILITY_VERSION = 1 as const;
const DEFAULT_TTL_MS = 60 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_CAPABILITIES = 64;
const MAX_RETAINED_TRANSACTION_SIGNATURES = 512;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type DesignAgentAction =
  | "document.open"
  | "source.read"
  | "foundation.read"
  | "projection.read"
  | "provenance.read"
  | "transaction.apply"
  | "history.undo"
  | "history.redo";

export type DesignAgentOperationType = DesignOperation["type"];

const ALL_ACTIONS = new Set<DesignAgentAction>([
  "document.open",
  "source.read",
  "foundation.read",
  "projection.read",
  "provenance.read",
  "transaction.apply",
  "history.undo",
  "history.redo",
]);

/** Public semantic mutations. `source.splice` is an internal inverse primitive
 * and is intentionally absent even though the shared schema can parse it. */
export const DESIGN_AGENT_SAFE_OPERATION_TYPES = Object.freeze<
  readonly DesignAgentOperationType[]
>([
  "node.set-styles",
  "node.set-text",
  "node.set-attribute",
  "node.set-html",
  "node.duplicate",
  "node.delete",
  "frame.set-geometry",
  "keyframes.set",
  "token.set",
  "component.create",
  "component.delete",
  "instance.create",
  "parameter.create",
  "parameter.delete",
  "parameter.set",
  "parameter.bind",
  "parameter.unbind",
  "variant.create",
  "variant.delete",
  "variant.set-parameter",
  "variant.unset-parameter",
]);

const SAFE_OPERATION_TYPES = new Set<DesignAgentOperationType>(
  DESIGN_AGENT_SAFE_OPERATION_TYPES,
);

export type DesignAgentCapabilityFailureCode =
  | "DESIGN_AGENT_CAPABILITY_INVALID"
  | "DESIGN_AGENT_CAPABILITY_EXPIRED"
  | "DESIGN_AGENT_CAPABILITY_CAPACITY";

export class DesignAgentCapabilityError extends Error {
  constructor(readonly code: DesignAgentCapabilityFailureCode) {
    super(
      code === "DESIGN_AGENT_CAPABILITY_EXPIRED"
        ? "The Design-agent capability expired."
        : code === "DESIGN_AGENT_CAPABILITY_CAPACITY"
          ? "The Design-agent capability limit was reached."
          : "The Design-agent capability is invalid or revoked.",
    );
    this.name = "DesignAgentCapabilityError";
  }
}

export interface DesignAgentCapabilityGrant {
  readonly version: typeof DESIGN_AGENT_CAPABILITY_VERSION;
  /** Opaque bearer. It must be carried only by the dedicated agent adapter and
   * must never be logged, persisted, or placed in Git/provider arguments. */
  readonly token: string;
  readonly workspaceId: string;
  readonly agentRunId: string;
  readonly documentId: string;
  readonly actor: DesignActor;
  readonly expectedRevision: string;
  readonly allowedActions: readonly DesignAgentAction[];
  readonly allowedOperationTypes: readonly DesignAgentOperationType[];
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface CreateDesignAgentCapabilityInput {
  workspaceId: string;
  /** Trusted engine coordinate; never serialized into the grant's tool
   * responses. */
  workspacePath: string;
  agentRunId: string;
  documentId: string;
  expectedRevision: string;
  ttlMs?: number;
  allowedActions?: readonly string[];
  allowedOperationTypes?: readonly string[];
}

interface CapabilityEntry {
  readonly token: string;
  readonly workspaceId: string;
  readonly agentRunId: string;
  readonly documentId: string;
  readonly actor: DesignActor;
  readonly allowedActions: ReadonlySet<DesignAgentAction>;
  readonly allowedOperationTypes: ReadonlySet<DesignAgentOperationType>;
  readonly issuedAt: number;
  expiresAt: number;
  readonly api: DesignApi;
  readonly transactionSignatures: Map<string, string>;
  expectedRevision: string;
  revoked: boolean;
}

function exactPortableId(value: string, label: string): string {
  if (!PORTABLE_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a portable bounded identifier.`);
  }
  return value;
}

function exactTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TTL_MS) {
    throw new Error("Design-agent capability TTL is invalid.");
  }
  return ttl;
}

function exactActions(
  input: readonly string[] | undefined,
): DesignAgentAction[] {
  const values = input ?? [...ALL_ACTIONS];
  if (
    values.length < 1 ||
    values.length > ALL_ACTIONS.size ||
    values.some((value) => !ALL_ACTIONS.has(value as DesignAgentAction))
  ) {
    throw new Error("Design-agent capability actions are invalid.");
  }
  return [...new Set(values as readonly DesignAgentAction[])].sort();
}

function exactOperationTypes(
  input: readonly string[] | undefined,
): DesignAgentOperationType[] {
  const values = input ?? DESIGN_AGENT_SAFE_OPERATION_TYPES;
  if (
    values.length > SAFE_OPERATION_TYPES.size ||
    values.some(
      (value) => !SAFE_OPERATION_TYPES.has(value as DesignAgentOperationType),
    )
  ) {
    throw new Error("Design-agent operation types are invalid.");
  }
  return [...new Set(values as readonly DesignAgentOperationType[])].sort();
}

function authorizeContext(
  entry: CapabilityEntry,
  operationTypes: readonly string[],
): boolean {
  if (operationTypes.length === 0) return false;
  if (operationTypes.length === 1) {
    const action = operationTypes[0] as DesignAgentAction;
    if (ALL_ACTIONS.has(action)) return entry.allowedActions.has(action);
  }
  return (
    entry.allowedActions.has("transaction.apply") &&
    operationTypes.every((operation) =>
      entry.allowedOperationTypes.has(operation as DesignAgentOperationType),
    )
  );
}

/** In-engine capability adapter for one persistent Design-agent run. The map is
 * intentionally process-local: the trusted orchestrator recreates grants after
 * an engine restart, while durable draft bytes/revisions remain in
 * DesignDraftStore. */
export class DesignAgentCapabilityManager {
  private readonly entries = new Map<string, CapabilityEntry>();
  private readonly now: () => number;
  private readonly maxCapabilities: number;

  constructor(options: { now?: () => number; maxCapabilities?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxCapabilities = options.maxCapabilities ?? DEFAULT_MAX_CAPABILITIES;
    if (
      !Number.isSafeInteger(this.maxCapabilities) ||
      this.maxCapabilities < 1 ||
      this.maxCapabilities > 256
    ) {
      throw new Error("Design-agent capability capacity is invalid.");
    }
  }

  async create(
    input: CreateDesignAgentCapabilityInput,
  ): Promise<DesignAgentCapabilityGrant> {
    this.pruneExpired();
    if (this.entries.size >= this.maxCapabilities) {
      throw new DesignAgentCapabilityError("DESIGN_AGENT_CAPABILITY_CAPACITY");
    }
    const workspaceId = exactPortableId(input.workspaceId, "workspaceId");
    const agentRunId = exactPortableId(input.agentRunId, "agentRunId");
    const issuedAt = this.now();
    const expiresAt = issuedAt + exactTtl(input.ttlMs);
    const allowedActions = exactActions(input.allowedActions);
    const allowedOperationTypes = exactOperationTypes(
      input.allowedOperationTypes,
    );
    const actor: DesignActor = { kind: "agent", id: agentRunId };
    let token: string;
    do token = randomBytes(32).toString("hex");
    while (this.entries.has(token));

    const entryRef: { current: CapabilityEntry | null } = { current: null };
    const api = new DesignApi(new DesignDraftStore(input.workspacePath), {
      authorization: {
        kind: "authorize",
        actor,
        authorize: (context) => {
          const entry = entryRef.current;
          if (!entry) return false;
          if (entry.revoked || this.now() >= entry.expiresAt) return false;
          return (
            context.documentId === entry.documentId &&
            context.actor.kind === entry.actor.kind &&
            context.actor.id === entry.actor.id &&
            authorizeContext(entry, context.operationTypes)
          );
        },
      },
      maxSessions: 1,
      maxSessionBytes: 32 * 1024 * 1024,
    });
    const entry: CapabilityEntry = {
      token,
      workspaceId,
      agentRunId,
      documentId: input.documentId,
      actor,
      allowedActions: new Set(allowedActions),
      allowedOperationTypes: new Set(allowedOperationTypes),
      issuedAt,
      expiresAt,
      api,
      transactionSignatures: new Map(),
      expectedRevision: input.expectedRevision,
      revoked: false,
    };
    entryRef.current = entry;
    this.entries.set(token, entry);
    try {
      const opened = await api.open(input.documentId);
      if (opened.revision !== input.expectedRevision) {
        throw new DesignApiRepositoryConflictError(
          input.expectedRevision,
          opened.revision,
        );
      }
    } catch (error) {
      entry.revoked = true;
      this.entries.delete(token);
      throw error;
    }
    return this.grant(entry);
  }

  async open(token: string): Promise<DesignDocumentSummary> {
    const entry = this.require(token);
    const summary = await entry.api.open(entry.documentId);
    // Explicit open/refresh is the agent's acknowledgement of a newer human
    // revision. Mutations still carry that exact revision in their transaction.
    entry.expectedRevision = summary.revision;
    return summary;
  }

  async readSource(
    token: string,
    input: { file: string; expectedRevision?: string },
  ): Promise<{ revision: string; file: string; source: string }> {
    const entry = this.require(token);
    return entry.api.readSource({
      documentId: entry.documentId,
      file: input.file,
      expectedRevision: this.boundRevision(entry, input.expectedRevision),
    });
  }

  async readFoundation(
    token: string,
    input: { expectedRevision?: string } = {},
  ): Promise<Awaited<ReturnType<DesignApi["readFoundation"]>>> {
    const entry = this.require(token);
    return entry.api.readFoundation({
      documentId: entry.documentId,
      expectedRevision: this.boundRevision(entry, input.expectedRevision),
    });
  }

  async readProjection(
    token: string,
    input: {
      expectedRevision?: string;
      cursor?: string;
      limit?: number;
      maxDepth?: number;
    } = {},
  ): Promise<DesignProjectionPage> {
    const entry = this.require(token);
    return entry.api.readProjection({
      documentId: entry.documentId,
      expectedRevision: this.boundRevision(entry, input.expectedRevision),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
    });
  }

  async readProvenance(
    token: string,
    input: Omit<Parameters<DesignApi["readProvenance"]>[0], "documentId">,
  ): Promise<Awaited<ReturnType<DesignApi["readProvenance"]>>> {
    const entry = this.require(token);
    return entry.api.readProvenance({
      ...input,
      documentId: entry.documentId,
      expectedRevision: this.boundRevision(entry, input.expectedRevision),
    });
  }

  async apply(
    token: string,
    transaction: DesignTransaction | unknown,
    options: { dryRun?: boolean } = {},
  ): Promise<DesignApiApplyResult> {
    const entry = this.require(token);
    const parsed = designTransactionSchema.parse(transaction);
    const signature = designTransactionSignature(parsed);
    const exactRetry =
      entry.transactionSignatures.get(parsed.transactionId) === signature;
    if (
      parsed.documentId === entry.documentId &&
      parsed.actor.kind === entry.actor.kind &&
      parsed.actor.id === entry.actor.id &&
      parsed.baseRevision !== entry.expectedRevision &&
      !exactRetry
    ) {
      throw new DesignTransactionConflictError(
        entry.documentId,
        parsed.baseRevision,
        entry.expectedRevision,
      );
    }
    const result = await entry.api.apply(parsed, options);
    if (!options.dryRun) {
      this.rememberTransaction(entry, parsed.transactionId, signature);
      // An exact retry can observe a newer repository revision after a human
      // edit. Preserve idempotency without silently broadening the grant; only
      // explicit document.open acknowledges that external revision.
      if (result.receipt.status !== "duplicate") {
        entry.expectedRevision = result.revision;
      }
    }
    return result;
  }

  async undo(token: string): Promise<DesignApiApplyResult | null> {
    const entry = this.require(token);
    const result = await entry.api.undo(entry.documentId, entry.actor, {
      expectedRevision: entry.expectedRevision,
    });
    if (result) entry.expectedRevision = result.revision;
    return result;
  }

  async redo(token: string): Promise<DesignApiApplyResult | null> {
    const entry = this.require(token);
    const result = await entry.api.redo(entry.documentId, entry.actor, {
      expectedRevision: entry.expectedRevision,
    });
    if (result) entry.expectedRevision = result.revision;
    return result;
  }

  /** Extend one already-live run without replacing its provider process or
   * broadening its authority. Renewal is a trusted orchestrator operation;
   * Design-agent tools never receive a renewal endpoint. */
  renew(token: string, ttlMs?: number): DesignAgentCapabilityGrant {
    const entry = this.require(token);
    entry.expiresAt = this.now() + exactTtl(ttlMs);
    return this.grant(entry);
  }

  /** Synchronous request-boundary check for the dedicated loopback transport.
   * It intentionally returns no capability metadata or bearer material. */
  assertActive(token: string): void {
    this.require(token);
  }

  revoke(token: string): boolean {
    const entry = TOKEN_PATTERN.test(token) ? this.entries.get(token) : null;
    if (!entry) return false;
    entry.revoked = true;
    this.entries.delete(token);
    return true;
  }

  activeCount(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  private require(token: string): CapabilityEntry {
    if (!TOKEN_PATTERN.test(token)) {
      throw new DesignAgentCapabilityError("DESIGN_AGENT_CAPABILITY_INVALID");
    }
    const entry = this.entries.get(token);
    if (!entry || entry.revoked) {
      throw new DesignAgentCapabilityError("DESIGN_AGENT_CAPABILITY_INVALID");
    }
    if (this.now() >= entry.expiresAt) {
      entry.revoked = true;
      this.entries.delete(token);
      throw new DesignAgentCapabilityError("DESIGN_AGENT_CAPABILITY_EXPIRED");
    }
    return entry;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (!entry.revoked && now < entry.expiresAt) continue;
      entry.revoked = true;
      this.entries.delete(token);
    }
  }

  private boundRevision(
    entry: CapabilityEntry,
    supplied: string | undefined,
  ): string {
    if (supplied !== undefined && supplied !== entry.expectedRevision) {
      throw new DesignApiRepositoryConflictError(
        supplied,
        entry.expectedRevision,
      );
    }
    return entry.expectedRevision;
  }

  private rememberTransaction(
    entry: CapabilityEntry,
    transactionId: string,
    signature: string,
  ): void {
    entry.transactionSignatures.delete(transactionId);
    entry.transactionSignatures.set(transactionId, signature);
    while (
      entry.transactionSignatures.size > MAX_RETAINED_TRANSACTION_SIGNATURES
    ) {
      const oldest = entry.transactionSignatures.keys().next().value as
        | string
        | undefined;
      if (!oldest) break;
      entry.transactionSignatures.delete(oldest);
    }
  }

  private grant(entry: CapabilityEntry): DesignAgentCapabilityGrant {
    return Object.freeze({
      version: DESIGN_AGENT_CAPABILITY_VERSION,
      token: entry.token,
      workspaceId: entry.workspaceId,
      agentRunId: entry.agentRunId,
      documentId: entry.documentId,
      actor: Object.freeze({ ...entry.actor }),
      expectedRevision: entry.expectedRevision,
      allowedActions: Object.freeze([...entry.allowedActions].sort()),
      allowedOperationTypes: Object.freeze(
        [...entry.allowedOperationTypes].sort(),
      ),
      issuedAt: entry.issuedAt,
      expiresAt: entry.expiresAt,
    });
  }
}
