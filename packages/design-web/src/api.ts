import {
  applyDesignTransaction,
  assertDesignTransactionInputSize,
  designActorSchema,
  designDocumentIdSchema,
  designNodeIdSchema,
  designRelativeFileSchema,
  designRevisionSchema,
  designTransactionSchema,
  DesignTransactionSession,
  type DesignActor,
  type DesignHistoryStatus,
  type DesignTransaction,
  type DesignTransactionOutcome,
  type DesignTransactionReceipt,
  type DesignFoundationManifest,
} from "@zeros/design-core";

import {
  designWebTransactionAdapter,
  readDesignWebProjection,
} from "./adapter";
import {
  readDesignCssDiagnostics,
  readDesignKeyframes,
  readDesignStyleProvenance,
} from "./css";
import type {
  DesignAuthoredKeyframes,
  DesignRuntimeMatchedDeclaration,
  DesignStyleProvenance,
  DesignWebDiagnostic,
  DesignWebDocumentInput,
  DesignWebDocumentState,
  DesignWebNode,
} from "./model";
import { createDesignWebDocumentState } from "./revision";

export const DESIGN_API_VERSION = 1 as const;
export const DESIGN_API_DEFAULT_PAGE_SIZE = 200;
export const DESIGN_API_MAX_PAGE_SIZE = 1_000;
export const DESIGN_API_MAX_SESSIONS = 32;
export const DESIGN_API_DEFAULT_SESSION_BYTES = 64 * 1024 * 1024;
export const DESIGN_API_MAX_RENDER_PIXELS = 16_777_216;
export const DESIGN_API_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const DESIGN_API_MAX_ARTIFACT_METADATA_ENTRIES = 64;
export const DESIGN_API_MAX_ARTIFACT_METADATA_UNITS = 16 * 1024;

export interface DesignDocumentRepository {
  read(documentId: string): Promise<DesignWebDocumentInput>;
  /** Compare-and-swap commit. Implementations must write all affected durable
   * records atomically from the caller's perspective. */
  commit(input: {
    documentId: string;
    expectedRevision: string;
    state: DesignWebDocumentState;
  }): Promise<void>;
}

export interface DesignApiAuthorizationContext {
  documentId: string;
  actor: DesignActor;
  operationTypes: string[];
  dryRun: boolean;
}

export type DesignApiAuthorization =
  | {
      /** Explicit trust for the desktop's in-process human Design surface.
       * Never use this authority at a transport or agent boundary. */
      kind: "trusted-in-process";
    }
  | {
      /** Every write is delegated to the caller-supplied policy decision. */
      kind: "authorize";
      /** Authenticated identity bound by the adapter. An untrusted transaction
       * cannot obtain another actor's authority by changing its actor field. */
      actor: DesignActor;
      authorize: (
        context: DesignApiAuthorizationContext,
      ) => boolean | Promise<boolean>;
    };

export interface DesignApiOptions {
  maxSessions?: number;
  maxSessionBytes?: number;
  /** Authority is intentionally explicit. Omitting it makes every operation
   * fail closed. This runtime default protects JavaScript and future transport
   * adapters; the trusted human surface opts in with `trusted-in-process`. */
  authorization?: DesignApiAuthorization;
  renderer?: DesignHeadlessRenderer;
}

export interface DesignDocumentSummary {
  apiVersion: typeof DESIGN_API_VERSION;
  documentId: string;
  revision: string;
  entryFile: string;
  fileCount: number;
  nodeCount: number;
  valid: boolean;
  diagnostics: DesignWebDiagnostic[];
  lastValidRevision: string | null;
  history: DesignHistoryStatus;
}

export interface DesignProjectionPage {
  documentId: string;
  revision: string;
  nodes: DesignWebNode[];
  nextCursor: string | null;
  diagnostics: DesignWebDiagnostic[];
}

export interface DesignApiApplyResult {
  dryRun: boolean;
  receipt: DesignTransactionReceipt;
  revision: string;
  affectedFiles: string[];
  affectedNodeIds: string[];
}

export interface DesignRenderViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  colorScheme?: "light" | "dark";
  reducedMotion?: "reduce" | "no-preference";
}

export interface DesignRenderArtifact {
  mimeType: "image/png" | "image/webp" | "text/html" | "application/json";
  bytes: Uint8Array;
  width: number;
  height: number;
  revision: string;
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface DesignHeadlessRenderer {
  render(input: {
    state: DesignWebDocumentState;
    viewport: Required<DesignRenderViewport>;
    signal?: AbortSignal;
  }): Promise<DesignRenderArtifact>;
}

interface SessionEntry {
  session: DesignTransactionSession<DesignWebDocumentState>;
  lastValidState: DesignWebDocumentState | null;
  lastAccess: number;
}

function estimatedJsonMemory(value: unknown): number {
  const seen = new WeakSet<object>();
  const visit = (current: unknown): number => {
    if (typeof current === "string") return current.length * 2 + 16;
    if (
      current === null ||
      typeof current === "number" ||
      typeof current === "boolean" ||
      current === undefined
    ) {
      return 16;
    }
    if (typeof current !== "object" || seen.has(current)) return 32;
    seen.add(current);
    let bytes = 32;
    if (Array.isArray(current)) {
      for (const item of current) bytes += visit(item) + 8;
    } else {
      for (const [key, item] of Object.entries(current)) {
        bytes += key.length * 2 + 16 + visit(item);
      }
    }
    seen.delete(current);
    return bytes;
  };
  return visit(value);
}

function estimatedStateMemory(state: DesignWebDocumentState): number {
  return estimatedJsonMemory(state);
}

function estimatedSessionMemory(entry: SessionEntry): number {
  const current = entry.session.currentState();
  const history = entry.session.status();
  const lastValid = entry.lastValidState;
  return (
    estimatedStateMemory(current) +
    (lastValid && lastValid.revision !== current.revision
      ? estimatedStateMemory(lastValid)
      : 0) +
    history.retainedBytes +
    history.retainedReceiptBytes
  );
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function diagnostics(state: DesignWebDocumentState): DesignWebDiagnostic[] {
  return [
    ...readDesignWebProjection(state).diagnostics,
    ...readDesignCssDiagnostics(state.files),
  ].slice(0, 1_000);
}

function isValid(findings: readonly DesignWebDiagnostic[]): boolean {
  return !findings.some((finding) => finding.severity === "error");
}

function validatedDocumentId(documentId: string): string {
  return designDocumentIdSchema.parse(documentId);
}

function validatedExpectedRevision(
  revision: string | undefined,
): string | undefined {
  return revision === undefined
    ? undefined
    : designRevisionSchema.parse(revision);
}

function validatedRuntimeEvidence(
  matched: readonly DesignRuntimeMatchedDeclaration[] | undefined,
): DesignRuntimeMatchedDeclaration[] | undefined {
  if (matched === undefined) return undefined;
  if (!Array.isArray(matched) || matched.length > 256) {
    throw new Error(
      "Design provenance accepts at most 256 matched declarations.",
    );
  }
  let units = 0;
  return matched.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new Error(
        "Design provenance contains an invalid matched declaration.",
      );
    }
    const property = candidate.property;
    const value = candidate.value;
    if (
      typeof property !== "string" ||
      property.length < 1 ||
      property.length > 128 ||
      typeof value !== "string" ||
      value.length > 2_048 ||
      (candidate.selector !== undefined &&
        (typeof candidate.selector !== "string" ||
          candidate.selector.length > 1_024)) ||
      (candidate.sourceFile !== undefined &&
        (typeof candidate.sourceFile !== "string" ||
          candidate.sourceFile.length > 512)) ||
      (candidate.sourceLine !== undefined &&
        (!Number.isSafeInteger(candidate.sourceLine) ||
          candidate.sourceLine < 1)) ||
      (candidate.important !== undefined &&
        typeof candidate.important !== "boolean") ||
      (candidate.inherited !== undefined &&
        typeof candidate.inherited !== "boolean") ||
      (candidate.active !== undefined && typeof candidate.active !== "boolean")
    ) {
      throw new Error(
        "Design provenance contains an invalid matched declaration.",
      );
    }
    units +=
      property.length +
      value.length +
      (candidate.selector?.length ?? 0) +
      (candidate.sourceFile?.length ?? 0);
    if (units > 256 * 1024) {
      throw new Error("Design provenance evidence exceeds its size limit.");
    }
    return {
      property,
      value,
      ...(candidate.important !== undefined
        ? { important: candidate.important }
        : {}),
      ...(candidate.selector !== undefined
        ? { selector: candidate.selector }
        : {}),
      ...(candidate.sourceFile !== undefined
        ? { sourceFile: candidate.sourceFile }
        : {}),
      ...(candidate.sourceLine !== undefined
        ? { sourceLine: candidate.sourceLine }
        : {}),
      ...(candidate.inherited !== undefined
        ? { inherited: candidate.inherited }
        : {}),
      ...(candidate.active !== undefined ? { active: candidate.active } : {}),
    };
  });
}

function requiredViewport(
  viewport: DesignRenderViewport,
): Required<DesignRenderViewport> {
  const width = boundedInteger(viewport.width, 0, 1, 8_192);
  const height = boundedInteger(viewport.height, 0, 1, 8_192);
  const deviceScaleFactor = Math.min(
    3,
    Math.max(
      1,
      Number.isFinite(viewport.deviceScaleFactor)
        ? viewport.deviceScaleFactor!
        : 1,
    ),
  );
  if (
    width * height * deviceScaleFactor * deviceScaleFactor >
    DESIGN_API_MAX_RENDER_PIXELS
  ) {
    throw new Error("Design render exceeds the pixel budget.");
  }
  return {
    width,
    height,
    deviceScaleFactor,
    colorScheme: viewport.colorScheme ?? "light",
    reducedMotion: viewport.reducedMotion ?? "reduce",
  };
}

function assertRenderArtifact(
  artifact: DesignRenderArtifact,
  state: DesignWebDocumentState,
  viewport: Required<DesignRenderViewport>,
): void {
  if (!(artifact.bytes instanceof Uint8Array)) {
    throw new Error(
      "Headless design renderer returned invalid artifact bytes.",
    );
  }
  if (artifact.bytes.byteLength > DESIGN_API_MAX_ARTIFACT_BYTES) {
    throw new Error("Headless design artifact exceeds the byte budget.");
  }
  if (
    artifact.width !== viewport.width ||
    artifact.height !== viewport.height
  ) {
    throw new Error("Headless design renderer returned the wrong viewport.");
  }
  if (artifact.revision !== state.revision) {
    throw new Error("Headless design renderer returned the wrong revision.");
  }
  if (
    !["image/png", "image/webp", "text/html", "application/json"].includes(
      artifact.mimeType,
    )
  ) {
    throw new Error("Headless design renderer returned an invalid MIME type.");
  }
  const metadata = Object.entries(artifact.metadata ?? {});
  if (metadata.length > DESIGN_API_MAX_ARTIFACT_METADATA_ENTRIES) {
    throw new Error(
      "Headless design artifact metadata exceeds its entry limit.",
    );
  }
  let units = 0;
  for (const [key, value] of metadata) {
    if (
      key.length === 0 ||
      key.length > 128 ||
      (typeof value === "number" && !Number.isFinite(value)) ||
      (typeof value === "string" && value.length > 2_048) ||
      !["string", "number", "boolean"].includes(typeof value)
    ) {
      throw new Error("Headless design renderer returned invalid metadata.");
    }
    units += key.length + String(value).length;
    if (units > DESIGN_API_MAX_ARTIFACT_METADATA_UNITS) {
      throw new Error(
        "Headless design artifact metadata exceeds its size limit.",
      );
    }
  }
}

export class DesignApiAuthorizationError extends Error {
  readonly code = "DESIGN_API_FORBIDDEN";

  constructor() {
    super("The caller is not authorized for this Design API transaction.");
    this.name = "DesignApiAuthorizationError";
  }
}

export class DesignApiRepositoryConflictError extends Error {
  readonly code = "DESIGN_REPOSITORY_CONFLICT";

  constructor(
    readonly expectedRevision: string,
    readonly actualRevision: string,
  ) {
    super(
      `Design repository changed: expected ${expectedRevision}, current ${actualRevision}.`,
    );
    this.name = "DesignApiRepositoryConflictError";
  }
}

const TRUSTED_IN_PROCESS_ACTOR: DesignActor = {
  kind: "system",
  id: "trusted-in-process",
};

function sameDesignActor(left: DesignActor, right: DesignActor): boolean {
  return left.kind === right.kind && left.id === right.id;
}

export class DesignApi {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly documentTurns = new Map<string, Promise<void>>();
  private readonly activeDocuments = new Set<string>();
  private readonly maxSessions: number;
  private readonly maxSessionBytes: number;

  constructor(
    private readonly repository: DesignDocumentRepository,
    private readonly options: DesignApiOptions = {},
  ) {
    this.maxSessions = boundedInteger(
      options.maxSessions,
      DESIGN_API_MAX_SESSIONS,
      1,
      256,
    );
    this.maxSessionBytes = boundedInteger(
      options.maxSessionBytes,
      DESIGN_API_DEFAULT_SESSION_BYTES,
      4 * 1024 * 1024,
      512 * 1024 * 1024,
    );
  }

  async open(documentId: string): Promise<DesignDocumentSummary> {
    const exactDocumentId = validatedDocumentId(documentId);
    return this.withDocumentTurn(exactDocumentId, async () => {
      await this.authorizeRead(exactDocumentId, "document.open");
      const entry = await this.load(exactDocumentId);
      return this.summary(entry);
    });
  }

  async readSource(input: {
    documentId: string;
    file: string;
    expectedRevision?: string;
  }): Promise<{ revision: string; file: string; source: string }> {
    const documentId = validatedDocumentId(input.documentId);
    const file = designRelativeFileSchema.parse(input.file);
    const expectedRevision = validatedExpectedRevision(input.expectedRevision);
    return this.withDocumentTurn(documentId, async () => {
      await this.authorizeRead(documentId, "source.read");
      const entry = await this.load(documentId);
      const state = entry.session.currentState();
      this.assertRevision(state, expectedRevision);
      if (!Object.prototype.hasOwnProperty.call(state.files, file)) {
        throw new Error(`Design source file is missing: ${file}`);
      }
      return { revision: state.revision, file, source: state.files[file]! };
    });
  }

  async readFoundation(input: {
    documentId: string;
    expectedRevision?: string;
  }): Promise<{
    documentId: string;
    revision: string;
    manifest: DesignFoundationManifest;
    keyframes: DesignAuthoredKeyframes[];
  }> {
    const documentId = validatedDocumentId(input.documentId);
    const expectedRevision = validatedExpectedRevision(input.expectedRevision);
    return this.withDocumentTurn(documentId, async () => {
      await this.authorizeRead(documentId, "foundation.read");
      const entry = await this.load(documentId);
      const state = entry.session.currentState();
      this.assertRevision(state, expectedRevision);
      return {
        documentId: state.documentId,
        revision: state.revision,
        manifest: structuredClone(state.manifest),
        keyframes: readDesignKeyframes(state.files),
      };
    });
  }

  async readProjection(input: {
    documentId: string;
    expectedRevision?: string;
    cursor?: string;
    limit?: number;
    maxDepth?: number;
  }): Promise<DesignProjectionPage> {
    const documentId = validatedDocumentId(input.documentId);
    const expectedRevision = validatedExpectedRevision(input.expectedRevision);
    return this.withDocumentTurn(documentId, async () => {
      await this.authorizeRead(documentId, "projection.read");
      const entry = await this.load(documentId);
      const state = entry.session.currentState();
      this.assertRevision(state, expectedRevision);
      const projection = readDesignWebProjection(state);
      const depthLimit = boundedInteger(input.maxDepth, 32, 0, 64);
      const byId = new Map(projection.nodes.map((node) => [node.id, node]));
      const nodes = projection.nodes.filter((node) => {
        let depth = 0;
        let parentId = node.parentId;
        while (parentId && depth <= depthLimit) {
          depth += 1;
          parentId = byId.get(parentId)?.parentId ?? null;
        }
        return depth <= depthLimit;
      });
      const cursor = input.cursor === undefined ? 0 : Number(input.cursor);
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new Error("Invalid design cursor.");
      }
      const limit = boundedInteger(
        input.limit,
        DESIGN_API_DEFAULT_PAGE_SIZE,
        1,
        DESIGN_API_MAX_PAGE_SIZE,
      );
      const page = nodes.slice(cursor, cursor + limit);
      const next = cursor + page.length;
      return {
        documentId: state.documentId,
        revision: state.revision,
        nodes: page,
        nextCursor: next < nodes.length ? String(next) : null,
        diagnostics: projection.diagnostics,
      };
    });
  }

  async readProvenance(input: {
    documentId: string;
    nodeId: string;
    property: string;
    expectedRevision?: string;
    computedValue?: string | null;
    matched?: readonly DesignRuntimeMatchedDeclaration[];
  }): Promise<DesignStyleProvenance> {
    const documentId = validatedDocumentId(input.documentId);
    const expectedRevision = validatedExpectedRevision(input.expectedRevision);
    const nodeId = designNodeIdSchema.parse(input.nodeId);
    if (
      typeof input.property !== "string" ||
      input.property.length < 1 ||
      input.property.length > 128 ||
      (input.computedValue !== undefined &&
        input.computedValue !== null &&
        (typeof input.computedValue !== "string" ||
          input.computedValue.length > 4_096))
    ) {
      throw new Error("Design provenance request is invalid.");
    }
    const matched = validatedRuntimeEvidence(input.matched);
    return this.withDocumentTurn(documentId, async () => {
      await this.authorizeRead(documentId, "provenance.read");
      const entry = await this.load(documentId);
      const state = entry.session.currentState();
      this.assertRevision(state, expectedRevision);
      return readDesignStyleProvenance(state, {
        nodeId,
        property: input.property,
        ...(input.computedValue !== undefined
          ? { computedValue: input.computedValue }
          : {}),
        ...(matched ? { matched } : {}),
      });
    });
  }

  async apply(
    input: DesignTransaction | unknown,
    options: { dryRun?: boolean } = {},
  ): Promise<DesignApiApplyResult> {
    assertDesignTransactionInputSize(input);
    const transaction = designTransactionSchema.parse(input);
    return this.withDocumentTurn(transaction.documentId, async () => {
      await this.authorize(transaction, options.dryRun === true);
      if (
        transaction.operations.some(
          (operation) => operation.type === "source.splice",
        )
      ) {
        throw new DesignApiAuthorizationError();
      }
      const entry = await this.load(transaction.documentId);
      if (options.dryRun) {
        const outcome = applyDesignTransaction(
          entry.session.currentState(),
          transaction,
          designWebTransactionAdapter,
        );
        return this.applyResult(outcome, true);
      }
      const checkpoint = entry.session.checkpoint();
      const outcome = entry.session.apply(transaction);
      if (outcome.receipt.status === "applied") {
        await this.commitOrReconcile(entry, outcome, checkpoint);
      }
      return this.applyResult(outcome, false);
    });
  }

  async undo(
    documentId: string,
    actor?: DesignActor,
  ): Promise<DesignApiApplyResult | null> {
    const exactDocumentId = validatedDocumentId(documentId);
    const exactActor = actor ? designActorSchema.parse(actor) : undefined;
    return this.withDocumentTurn(exactDocumentId, async () => {
      const entry = await this.load(exactDocumentId);
      const checkpoint = entry.session.checkpoint();
      const outcome = entry.session.undo(exactActor);
      if (!outcome) return null;
      try {
        await this.authorizeContext({
          documentId: exactDocumentId,
          actor: outcome.receipt.actor,
          operationTypes: ["history.undo"],
          dryRun: false,
        });
      } catch (error) {
        entry.session.restore(checkpoint);
        throw error;
      }
      await this.commitOrReconcile(entry, outcome, checkpoint);
      return this.applyResult(outcome, false);
    });
  }

  async redo(
    documentId: string,
    actor?: DesignActor,
  ): Promise<DesignApiApplyResult | null> {
    const exactDocumentId = validatedDocumentId(documentId);
    const exactActor = actor ? designActorSchema.parse(actor) : undefined;
    return this.withDocumentTurn(exactDocumentId, async () => {
      const entry = await this.load(exactDocumentId);
      const checkpoint = entry.session.checkpoint();
      const outcome = entry.session.redo(exactActor);
      if (!outcome) return null;
      try {
        await this.authorizeContext({
          documentId: exactDocumentId,
          actor: outcome.receipt.actor,
          operationTypes: ["history.redo"],
          dryRun: false,
        });
      } catch (error) {
        entry.session.restore(checkpoint);
        throw error;
      }
      await this.commitOrReconcile(entry, outcome, checkpoint);
      return this.applyResult(outcome, false);
    });
  }

  async render(input: {
    documentId: string;
    expectedRevision?: string;
    viewport: DesignRenderViewport;
    signal?: AbortSignal;
  }): Promise<DesignRenderArtifact> {
    if (!this.options.renderer) {
      throw new Error("No headless design renderer is configured.");
    }
    const documentId = validatedDocumentId(input.documentId);
    const expectedRevision = validatedExpectedRevision(input.expectedRevision);
    const viewport = requiredViewport(input.viewport);
    const state = await this.withDocumentTurn(documentId, async () => {
      await this.authorizeRead(documentId, "document.render");
      const entry = await this.load(documentId);
      const current = entry.session.currentState();
      this.assertRevision(current, expectedRevision);
      const renderable = isValid(diagnostics(current))
        ? current
        : entry.lastValidState;
      if (!renderable) {
        throw new Error("The design has no valid revision to render.");
      }
      return renderable;
    });
    if (input.signal?.aborted) {
      throw (
        input.signal.reason ??
        new Error("The headless design render was cancelled.")
      );
    }
    const artifact = await this.options.renderer.render({
      state,
      viewport,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (input.signal?.aborted) {
      throw (
        input.signal.reason ??
        new Error("The headless design render was cancelled.")
      );
    }
    assertRenderArtifact(artifact, state, viewport);
    return artifact;
  }

  private async load(documentId: string): Promise<SessionEntry> {
    const state = createDesignWebDocumentState(
      await this.repository.read(documentId),
    );
    if (state.documentId !== documentId) {
      throw new Error(
        `Design repository returned ${state.documentId} for ${documentId}.`,
      );
    }
    let entry = this.sessions.get(documentId);
    if (!entry) {
      const findings = diagnostics(state);
      entry = {
        session: new DesignTransactionSession(
          state,
          designWebTransactionAdapter,
        ),
        lastValidState: isValid(findings) ? state : null,
        lastAccess: Date.now(),
      };
      this.sessions.set(documentId, entry);
    } else {
      entry.session.reconcile(
        state,
        "Authored source changed outside this Design API session.",
      );
      if (isValid(diagnostics(state))) entry.lastValidState = state;
      entry.lastAccess = Date.now();
      this.sessions.delete(documentId);
      this.sessions.set(documentId, entry);
    }
    this.pruneSessions();
    return entry;
  }

  private summary(entry: SessionEntry): DesignDocumentSummary {
    const state = entry.session.currentState();
    const projection = readDesignWebProjection(state);
    const findings = [
      ...projection.diagnostics,
      ...readDesignCssDiagnostics(state.files),
    ];
    return {
      apiVersion: DESIGN_API_VERSION,
      documentId: state.documentId,
      revision: state.revision,
      entryFile: state.entryFile,
      fileCount: Object.keys(state.files).length,
      nodeCount: projection.nodes.length,
      valid: isValid(findings),
      diagnostics: findings,
      lastValidRevision: entry.lastValidState?.revision ?? null,
      history: entry.session.status(),
    };
  }

  private assertRevision(
    state: DesignWebDocumentState,
    expectedRevision: string | undefined,
  ): void {
    if (expectedRevision && expectedRevision !== state.revision) {
      throw new DesignApiRepositoryConflictError(
        expectedRevision,
        state.revision,
      );
    }
  }

  private async authorize(
    transaction: DesignTransaction,
    dryRun: boolean,
  ): Promise<void> {
    const authorization = this.options.authorization;
    if (
      authorization?.kind === "authorize" &&
      !sameDesignActor(transaction.actor, authorization.actor)
    ) {
      throw new DesignApiAuthorizationError();
    }
    return this.authorizeContext({
      documentId: transaction.documentId,
      actor: transaction.actor,
      operationTypes: [
        ...new Set(transaction.operations.map((operation) => operation.type)),
      ],
      dryRun,
    });
  }

  private async authorizeRead(
    documentId: string,
    operationType: string,
  ): Promise<void> {
    const authorization = this.options.authorization;
    if (!authorization) throw new DesignApiAuthorizationError();
    const actor =
      authorization.kind === "authorize"
        ? designActorSchema.parse(authorization.actor)
        : TRUSTED_IN_PROCESS_ACTOR;
    return this.authorizeContext({
      documentId,
      actor,
      operationTypes: [operationType],
      dryRun: true,
    });
  }

  private async authorizeContext(
    context: DesignApiAuthorizationContext,
  ): Promise<void> {
    const authorization = this.options.authorization;
    if (authorization?.kind === "trusted-in-process") return;
    if (!authorization || authorization.kind !== "authorize") {
      throw new DesignApiAuthorizationError();
    }
    if (!sameDesignActor(context.actor, authorization.actor)) {
      throw new DesignApiAuthorizationError();
    }
    const allowed = await authorization.authorize(context);
    if (!allowed) throw new DesignApiAuthorizationError();
  }

  /** Serialize session reconciliation, mutation, and repository CAS per
   * document. Different documents remain independent; reads can never roll a
   * session back while its durable commit is in flight. */
  private async withDocumentTurn<T>(
    documentId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.documentTurns.get(documentId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    this.documentTurns.set(documentId, tail);
    await previous.catch(() => {});
    this.activeDocuments.add(documentId);
    try {
      return await work();
    } finally {
      this.activeDocuments.delete(documentId);
      release();
      void tail.finally(() => {
        if (this.documentTurns.get(documentId) === tail) {
          this.documentTurns.delete(documentId);
        }
      });
      this.pruneSessions();
    }
  }

  private pruneSessions(): void {
    let retainedBytes = [...this.sessions.values()].reduce(
      (total, entry) => total + estimatedSessionMemory(entry),
      0,
    );
    while (
      this.sessions.size > this.maxSessions ||
      retainedBytes > this.maxSessionBytes
    ) {
      const oldest = [...this.sessions.keys()].find(
        (documentId) => !this.activeDocuments.has(documentId),
      );
      if (!oldest) break;
      retainedBytes -= estimatedSessionMemory(this.sessions.get(oldest)!);
      this.sessions.delete(oldest);
    }
  }

  private async commitOrReconcile(
    entry: SessionEntry,
    outcome: DesignTransactionOutcome<DesignWebDocumentState>,
    checkpoint: ReturnType<
      DesignTransactionSession<DesignWebDocumentState>["checkpoint"]
    >,
  ): Promise<void> {
    try {
      await this.repository.commit({
        documentId: outcome.state.documentId,
        expectedRevision: outcome.receipt.beforeRevision,
        state: outcome.state,
      });
      if (isValid(diagnostics(outcome.state))) {
        entry.lastValidState = outcome.state;
      }
    } catch (error) {
      // Restore first. A repository that is temporarily unreadable after a
      // failed/uncertain commit must never leave speculative state or history
      // installed in this process.
      entry.session.restore(checkpoint);
      try {
        const current = createDesignWebDocumentState(
          await this.repository.read(outcome.state.documentId),
        );
        entry.session.reconcile(
          current,
          "Repository commit failed or lost a revision race.",
        );
        if (isValid(diagnostics(current))) entry.lastValidState = current;
      } catch {
        // Preserve the checkpoint and the original commit error. The next API
        // turn will reconcile again through load once storage is readable.
      }
      throw error;
    }
  }

  private applyResult(
    outcome: DesignTransactionOutcome<DesignWebDocumentState>,
    dryRun: boolean,
  ): DesignApiApplyResult {
    return {
      dryRun,
      receipt: outcome.receipt,
      revision: outcome.state.revision,
      affectedFiles: [...outcome.receipt.affectedFiles],
      affectedNodeIds: [...outcome.receipt.affectedNodeIds],
    };
  }
}

/** Test/embedding repository. It deliberately clones through the public state
 * constructor so callers cannot mutate durable state behind the API. */
export class InMemoryDesignDocumentRepository implements DesignDocumentRepository {
  private readonly documents = new Map<string, DesignWebDocumentState>();

  constructor(inputs: readonly DesignWebDocumentInput[]) {
    for (const input of inputs) {
      const state = createDesignWebDocumentState(input);
      this.documents.set(state.documentId, state);
    }
  }

  async read(documentId: string): Promise<DesignWebDocumentInput> {
    const state = this.documents.get(documentId);
    if (!state) throw new Error(`Design document not found: ${documentId}`);
    return {
      documentId: state.documentId,
      entryFile: state.entryFile,
      files: { ...state.files },
      manifest: structuredClone(state.manifest),
      frames: structuredClone(state.frames),
    };
  }

  async commit(input: {
    documentId: string;
    expectedRevision: string;
    state: DesignWebDocumentState;
  }): Promise<void> {
    const current = this.documents.get(input.documentId);
    if (!current) {
      throw new Error(`Design document not found: ${input.documentId}`);
    }
    if (current.revision !== input.expectedRevision) {
      throw new DesignApiRepositoryConflictError(
        input.expectedRevision,
        current.revision,
      );
    }
    this.documents.set(
      input.documentId,
      createDesignWebDocumentState({
        documentId: input.state.documentId,
        entryFile: input.state.entryFile,
        files: input.state.files,
        manifest: input.state.manifest,
        frames: input.state.frames,
      }),
    );
  }

  /** Simulates an external Git/code edit for reconciliation tests. */
  replace(input: DesignWebDocumentInput): void {
    const state = createDesignWebDocumentState(input);
    this.documents.set(state.documentId, state);
  }
}
