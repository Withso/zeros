import { designEvidenceBudget } from "./evidence-budget";
import { createDesignResult } from "./results";
import {
  DesignResultStore,
  type DesignResultArtifactName,
} from "./result-store";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ComposerModeSnapshot } from "@zeros/protocol/composer-mode";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  designTransactionSchema,
  designTransactionSignature,
  DesignTransactionConflictError,
  type DesignTransaction,
} from "@zeros/design-core";
import { DesignApi, type DesignHeadlessRenderer } from "@zeros/design-web";
import { DesignDraftStore } from "./design-api";
import { DESIGN_AGENT_SAFE_OPERATION_TYPES } from "./design-agent-capability";
import type { DesignMcpToolHandler } from "./design-agent-mcp";
import { withDesignDirectoryNameLease } from "./directory-registry";
import { withDesignWorkspaceMutation } from "./document-write-lock";
import { withDesignWriteAuthority } from "./write-authority";
import {
  createDesignFrame,
  deleteDesignFrame,
  duplicateDesignFrame,
  renameDesignFrame,
  listDesignFrames,
  lintDesignDocument,
  readDesignFrameRenderSourceFromSource,
} from "./document";
import {
  DesignRequestStore,
  designRequestIdSchema,
  designRequestSignature,
  DESIGN_REQUEST_RETENTION_MS,
  DESIGN_REQUEST_LIMIT,
  DESIGN_REQUEST_STORE_BYTES,
  type DesignRequestRecord,
} from "./request-store";

const documentId = z
  .string()
  .regex(/^frame:[A-Za-z0-9][A-Za-z0-9._-]*\.[hH][tT][mM][lL]$/)
  .max(260);
const revision = z.string().min(1).max(128);
const exactDocument = { documentId, expectedRevision: revision };
const requestId = designRequestIdSchema;
const requestEnvelope = {
  requestId,
  createdAt: z.number().int().nonnegative(),
};
const maxInputBytes = 512 * 1024;
const maxResultBytes = 2 * 1024 * 1024;
const definitions = {
  design_capabilities: {
    description:
      "Discover the exact Design authority, implemented tools, and resource/retry limits.",
    schema: z.object({}).strict(),
  },
  design_document_list: {
    description:
      "List authored frames in the admitted Design directory, independent of the visible UI.",
    schema: z
      .object({
        offset: z.number().int().min(0).max(256).default(0),
        limit: z.number().int().min(1).max(64).default(32),
      })
      .strict(),
  },
  design_document_open: {
    description:
      "Open one authored frame. Every subsequent operation names its document and exact revision.",
    schema: z.object({ documentId }).strict(),
  },
  design_source_read: {
    description:
      "Read a bounded source page. Offsets are UTF-16 string offsets; use nextOffset verbatim.",
    schema: z
      .object({
        ...exactDocument,
        file: z.string().min(1).max(512),
        offset: z
          .number()
          .int()
          .min(0)
          .max(2 * 1024 * 1024)
          .default(0),
        limit: z.number().int().min(1).max(32_768).default(16_384),
      })
      .strict(),
  },
  design_foundation_read: {
    description:
      "Read the exact revision's tokens, parameters, and component manifest.",
    schema: z.object(exactDocument).strict(),
  },
  design_projection_read: {
    description:
      "Read a bounded semantic node projection; cursors belong to this exact revision.",
    schema: z
      .object({
        ...exactDocument,
        cursor: z.string().max(1024).optional(),
        limit: z.number().int().min(1).max(200).default(100),
        maxDepth: z.number().int().min(0).max(20).default(8),
      })
      .strict(),
  },
  design_provenance_read: {
    description:
      "Read authored style provenance, without claiming browser-computed evidence.",
    schema: z
      .object({
        ...exactDocument,
        nodeId: z.string().min(1).max(256),
        property: z.string().min(1).max(128),
      })
      .strict(),
  },
  design_transaction_apply: {
    description:
      "Apply an actor-bound semantic transaction, or validate it with dryRun. Reuse the exact transaction ID/body after a lost reply; never replay an indeterminate request.",
    schema: z
      .object({
        transaction: designTransactionSchema,
        dryRun: z.boolean().default(false),
      })
      .strict(),
  },
  design_proposal_create: {
    description:
      "Persist a validated proposal without changing authored files. The transaction ID is its review identity.",
    schema: z.object({ transaction: designTransactionSchema }).strict(),
  },
  design_proposal_resolve: {
    description:
      "Apply or reject a previously stored proposal at its original revision; a stale proposal must be replaced.",
    schema: z
      .object({ requestId, decision: z.enum(["apply", "reject"]) })
      .strict(),
  },
  design_request_status: {
    description:
      "Read this actor's durable request/proposal status. Unknown or indeterminate is not permission to replay.",
    schema: z.object({ requestId }).strict(),
  },
  design_request_list: {
    description:
      "List this actor's retained proposals and request statuses, without loading source or rendering frames.",
    schema: z
      .object({
        offset: z.number().int().min(0).max(512).default(0),
        limit: z.number().int().min(1).max(32).default(16),
      })
      .strict(),
  },
  design_history_undo: {
    description:
      "Undo only the current actor's latest transaction at the exact revision. Intervening edits can invalidate local undo history.",
    schema: z.object({ ...exactDocument, ...requestEnvelope }).strict(),
  },
  design_history_redo: {
    description:
      "Redo the current actor's latest undone transaction at the exact revision.",
    schema: z.object({ ...exactDocument, ...requestEnvelope }).strict(),
  },
  design_frame_create: {
    description:
      "Create an authored frame through the Design engine. Supply a fresh durable request ID.",
    schema: z
      .object({
        ...requestEnvelope,
        title: z.string().min(1).max(120),
        width: z.number().int().min(1).max(4096).default(1440),
        height: z.number().int().min(1).max(4096).default(900),
      })
      .strict(),
  },
  design_frame_rename: {
    description:
      "Rename the display title of an exact authored revision, preserving the document ID.",
    schema: z
      .object({
        ...exactDocument,
        ...requestEnvelope,
        title: z.string().min(1).max(120),
      })
      .strict(),
  },
  design_frame_duplicate: {
    description:
      "Duplicate an exact authored revision with new node identities.",
    schema: z.object({ ...exactDocument, ...requestEnvelope }).strict(),
  },
  design_frame_delete: {
    description:
      "Delete an exact authored revision through Design. Frame lifecycle changes are outside semantic transaction undo.",
    schema: z.object({ ...exactDocument, ...requestEnvelope }).strict(),
  },
  design_lint: {
    description:
      "Read authored lint for an exact frame revision; does not heal source or use stale attached-client audits.",
    schema: z.object(exactDocument).strict(),
  },
  design_render: {
    description:
      "Return sanitized, source-bound HTML with an exact render generation. This is authored render evidence, not a screenshot or behavioral test.",
    schema: z.object(exactDocument).strict(),
  },
  design_result_create: {
    description:
      "Preserve an exact source-bound result bundle, optionally previewing this actor's pending proposal without applying it. Capture requires an available host. Evidence never establishes human approval.",
    schema: z
      .object({
        ...exactDocument,
        ...requestEnvelope,
        proposalId: requestId.optional(),
        width: z.number().int().min(1).max(2048).default(1024),
        height: z.number().int().min(1).max(2048).default(768),
        capture: z.boolean().default(false),
      })
      .strict(),
  },
  design_result_list: {
    description:
      "List this actor's retained source-bound evidence. Expired results are unavailable and must never be substituted with current source.",
    schema: z.object({}).strict(),
  },
  design_result_read: {
    description:
      "Read a bounded page of an immutable result artifact. Concatenate data pages and verify the manifest hash after decoding the declared encoding.",
    schema: z
      .object({
        resultId: z.string().regex(/^[a-f0-9]{64}$/),
        artifact: z.enum([
          "source.json",
          "before.html",
          "after.html",
          "before.png",
          "after.png",
        ]),
        offset: z
          .number()
          .int()
          .min(0)
          .max(32 * 1024 * 1024)
          .default(0),
        limit: z.number().int().min(1).max(262144).default(32768),
      })
      .strict(),
  },
  design_capture: {
    description:
      "Capture the exact authored revision using the host's qualified headless renderer.",
    schema: z
      .object({
        ...exactDocument,
        width: z.number().int().min(1).max(2048),
        height: z.number().int().min(1).max(2048),
      })
      .strict(),
  },
} as const;

const toolDefinitions: Tool[] = Object.entries(definitions).map(
  ([name, { description, schema }]) => ({
    name,
    description,
    inputSchema: z.toJSONSchema(schema) as Tool["inputSchema"],
    annotations: { readOnlyHint: !isDesignWriteTool(name, {}) },
  }),
);
const safeOperations = new Set<string>(DESIGN_AGENT_SAFE_OPERATION_TYPES);

export function designCodeToolDefinitions(capture: boolean): Tool[] {
  return toolDefinitions.filter((tool) => tool.name !== "design_capture" || capture);
}

export function isDesignWriteTool(name: string, input: unknown): boolean {
  if (name === "design_transaction_apply" && input && typeof input === "object" &&
      (input as { dryRun?: unknown }).dryRun === true) return false;
  return ["design_transaction_apply", "design_proposal_create", "design_proposal_resolve",
    "design_history_undo", "design_history_redo", "design_frame_create",
    "design_frame_rename", "design_frame_duplicate", "design_frame_delete",
    "design_result_create"].includes(name);
}

export interface DesignCodeToolTarget {
  workspaceId: string;
  workspacePath: string;
  directory: string;
  directoryId: string;
  /** Engine-owned conversation identity survives provider reconnects. */
  actorId: string;
  assertCurrent(): void;
}

/** No timers, watchers, or browser processes are allocated by this handler.
 * The owner admits a bounded number of live sessions and disposes them with
 * the Code execution. All requests name an exact document; there is no mutable
 * "currently selected frame" shared by simultaneous tool calls. */
export class DesignCodeTools implements DesignMcpToolHandler {
  readonly token = randomBytes(32).toString("hex");
  private readonly abort = new AbortController();
  private readonly api: DesignApi;
  private readonly requests: DesignRequestStore;
  private pending = 0;
  private readonly actor;
  private readonly expiresAt: number;

  constructor(
    private readonly target: DesignCodeToolTarget,
    private readonly options: {
      onChanged?: () => void;
      renderer?: DesignHeadlessRenderer;
      now?: () => number;
      mode?: () => ComposerModeSnapshot;
    } = {},
  ) {
    this.expiresAt = this.now() + 24 * 60 * 60_000;
    this.actor = {
      kind: "agent" as const,
      id: designRequestIdSchema.parse(target.actorId),
    };
    this.requests = new DesignRequestStore(
      target.workspacePath,
      target.directoryId,
      options.now,
    );
    this.api = new DesignApi(
      new DesignDraftStore(target.workspacePath, {
        directory: target.directory,
        assertAuthorized: () => this.assertActive(this.token),
      }),
      {
        maxSessions: 2,
        maxSessionBytes: 16 * 1024 * 1024,
        authorization: {
          kind: "authorize",
          actor: this.actor,
          authorize: (context) => {
            this.assertActive(this.token);
            return (
              context.actor.kind === "agent" &&
              context.actor.id === this.actor.id &&
              documentId.safeParse(context.documentId).success &&
              context.operationTypes.every(
                (type) =>
                  [
                    "document.open",
                    "source.read",
                    "foundation.read",
                    "projection.read",
                    "provenance.read",
                    "history.undo",
                    "history.redo",
                    "document.render",
                  ].includes(type) ||
                  (
                    DESIGN_AGENT_SAFE_OPERATION_TYPES as readonly string[]
                  ).includes(type),
              )
            );
          },
        },
        ...(options.renderer ? { renderer: options.renderer } : {}),
      },
    );
  }

  dispose(): void {
    this.abort.abort(new Error("Design authority was revoked."));
  }

  assertActive(token: string): void {
    const supplied = Buffer.from(token);
    const expected = Buffer.from(this.token);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new Error("Invalid Design authority.");
    this.abort.signal.throwIfAborted();
    if (this.now() >= this.expiresAt) {
      this.dispose();
      throw new Error("Design authority expired; reopen the Code session.");
    }
    try {
      this.target.assertCurrent();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  listTools(): Tool[] {
    return designCodeToolDefinitions(!!this.options.renderer);
  }

  async callTool(
    name: string,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    this.assertActive(this.token);
    if (this.pending >= 4)
      throw new Error(
        "Design request capacity reached; wait for an active request to settle.",
      );
    if (Buffer.byteLength(JSON.stringify(raw)) > maxInputBytes)
      throw new Error("Design request exceeds 512 KiB.");
    const key = name as keyof typeof definitions;
    if (
      !Object.hasOwn(definitions, key) ||
      (key === "design_capture" && !this.options.renderer)
    )
      throw new Error("This Design tool is unavailable.");
    // Validate before queueing; no arbitrary fields or filesystem roots cross
    // the boundary. Dispatch below parses the same small validated object for
    // a concrete type, avoiding unchecked transport casts.
    const validated = definitions[key].schema.parse(raw);
    const writes = isDesignWriteTool(name, validated);
    const admittedMode = this.mode();
    const assertMode = () => {
      if (!writes) return;
      const current = this.mode();
      if (current.mode !== "design" || current.revision !== admittedMode.revision)
        throw new Error("Design mode is required for this edit, and must remain unchanged until write admission. Read design_capabilities and prepare a new request.");
    };
    assertMode();
    if (
      "createdAt" in validated &&
      (validated.createdAt > this.now() + 60_000 ||
        this.now() - validated.createdAt > DESIGN_REQUEST_RETENTION_MS)
    ) {
      throw new Error("Design request is outside the retry retention window.");
    }
    const joined = AbortSignal.any([signal, this.abort.signal]);
    const assertCurrent = () => {
      joined.throwIfAborted();
      this.assertActive(this.token);
      assertMode();
    };
    this.pending += 1;
    try {
      const execute = () =>
        withDesignWriteAuthority(assertCurrent, async () => {
          assertCurrent();
          const value = await this.execute(key, validated, joined);
          assertCurrent();
          const text = JSON.stringify(value);
          if (Buffer.byteLength(text) > maxResultBytes)
            throw new Error(
              "Design result exceeds 2 MiB; request a smaller source/projection page.",
            );
          return { content: [{ type: "text" as const, text }] };
        });
      return await withDesignDirectoryNameLease(
        this.target.workspacePath,
        this.target.directory,
        () =>
          // Capture operates on immutable inputs. Browser admission and rendering
          // must never retain the workspace's source/Git write lane.
          key === "design_capture" || key === "design_result_create"
            ? designEvidenceBudget.run(execute)
            : withDesignWorkspaceMutation(this.target.workspacePath, execute),
      );
    } finally {
      this.pending -= 1;
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  private mode(): ComposerModeSnapshot {
    return this.options.mode?.() ?? { mode: "code", revision: 0 };
  }
  private async exact(id: string, expected: string): Promise<void> {
    const current = await this.api.open(id);
    if (current.revision !== expected)
      throw new Error(
        "Design revision changed. Reopen the document and prepare a new request.",
      );
  }
  private frame(id: string): string {
    return documentId.parse(id).slice("frame:".length);
  }

  private checkedTransaction(value: DesignTransaction): DesignTransaction {
    const transaction = designTransactionSchema.parse(value);
    documentId.parse(transaction.documentId);
    requestId.parse(transaction.transactionId);
    if (
      transaction.operations.some(
        (operation) => !safeOperations.has(operation.type),
      )
    ) {
      throw new Error("Design transaction contains an unavailable operation.");
    }
    if (
      transaction.actor.kind !== this.actor.kind ||
      transaction.actor.id !== this.actor.id
    )
      throw new Error(
        "Design transaction actor differs from the admitted actor.",
      );
    if (
      transaction.createdAt > this.now() + 60_000 ||
      this.now() - transaction.createdAt > DESIGN_REQUEST_RETENTION_MS
    )
      throw new Error(
        "Design transaction is outside the retry retention window.",
      );
    return transaction;
  }

  private async mutate(
    id: string,
    signature: string,
    createdAt: number,
    run: () => Promise<unknown>,
    proposed?: DesignTransaction,
  ): Promise<unknown> {
    const claim = await withDesignWorkspaceMutation(
      this.target.workspacePath,
      async () => {
        const entries = await this.requests.read();
        const record = entries.find(
          (entry) => entry.id === id && entry.actorId === this.actor.id,
        );
        if (record) {
          if (record.signature !== signature)
            throw new Error(
              "Design request ID was reused with different content.",
            );
          if (record.status === "committed")
            return { done: true as const, result: record.result };
          if (record.status !== "proposed")
            throw new Error(
              `Design request is ${record.status === "started" ? "indeterminate" : record.status}; inspect its status before further edits.`,
            );
          if (!proposed)
            throw new Error(
              "A proposal must be resolved explicitly before applying it.",
            );
          record.status = "started";
          this.requests.write(entries);
        } else {
          this.requests.add(entries, {
            id,
            actorId: this.actor.id,
            signature,
            status: "started",
            createdAt,
          });
        }
        return { done: false as const };
      },
    );
    if (claim.done) return claim.result;
    const finish = (
      status: "committed" | "rejected" | "indeterminate",
      result?: unknown,
    ) =>
      withDesignWorkspaceMutation(this.target.workspacePath, async () => {
        // Browser work may have yielded the lane. Reload before changing just
        // this receipt so concurrent proposals/edits cannot be overwritten.
        const entries = await this.requests.read();
        const record = entries.find(
          (entry) => entry.id === id && entry.actorId === this.actor.id,
        );
        if (
          !record ||
          record.signature !== signature ||
          record.status !== "started"
        )
          throw new Error(
            "Design request changed while its result was being prepared.",
          );
        record.status = status;
        if (status === "committed") record.result = result;
        if (status !== "indeterminate") delete record.transaction;
        this.requests.write(entries);
      });
    let result: unknown;
    try {
      result = await run();
      await finish("committed", result);
    } catch (error) {
      // If authority was revoked or receipt storage failed, the retained
      // started record already reports an indeterminate outcome. Never replay.
      await finish(
        error instanceof DesignTransactionConflictError
          ? "rejected"
          : "indeterminate",
      ).catch(() => {});
      throw error;
    }
    try {
      this.options.onChanged?.();
    } catch {
      /* watcher invalidation remains */
    }
    return result;
  }

  private publicRecord(record: DesignRequestRecord | undefined): unknown {
    if (!record) return { status: "unknown" };
    return {
      ...record,
      status: record.status === "started" ? "indeterminate" : record.status,
    };
  }

  private async execute(
    name: keyof typeof definitions,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    switch (name) {
      case "design_capabilities":
        return {
          version: 1,
          composerMode: this.mode(),
          workspaceId: this.target.workspaceId,
          directoryId: this.target.directoryId,
          actor: this.actor,
          serverTime: this.now(),
          expiresAt: this.expiresAt,
          tools: this.listTools().map((tool) => tool.name),
          operationTypes: DESIGN_AGENT_SAFE_OPERATION_TYPES,
          limits: {
            maxPendingRequests: 4,
            maxInputBytes,
            maxResultBytes,
            retainedDocuments: 2,
            retainedDocumentBytes: 16 * 1024 * 1024,
            retryRetentionMs: DESIGN_REQUEST_RETENTION_MS,
            maxRetainedRequests: DESIGN_REQUEST_LIMIT,
            maxRequestStoreBytes: DESIGN_REQUEST_STORE_BYTES,
          },
          retries:
            "Resolved receipts are retained for up to seven days within shared directory count/byte limits. Eviction permanently retires requests at or before its timestamp cutoff. Use serverTime for fresh requests; unknown or indeterminate status never authorizes replay.",
          review:
            "Edits apply directly to the canvas. Tool access does not establish user intent or Git approval.",
          history:
            "Semantic undo/redo is local to this session; external edits or restart invalidate it. Frame lifecycle has separate history.",
        };
      case "design_document_list": {
        const input = definitions[name].schema.parse(raw);
        const frames = await listDesignFrames(this.target.workspacePath, {
          writeBack: false,
        });
        return {
          directoryId: this.target.directoryId,
          frames: frames
            .slice(input.offset, input.offset + input.limit)
            .map((frame) => ({ ...frame, documentId: `frame:${frame.file}` })),
          nextOffset:
            input.offset + input.limit < frames.length
              ? input.offset + input.limit
              : null,
        };
      }
      case "design_document_open":
        return this.api.open(definitions[name].schema.parse(raw).documentId);
      case "design_source_read": {
        const { offset, limit, ...input } = definitions[name].schema.parse(raw);
        const result = await this.api.readSource(input);
        let end = Math.min(result.source.length, offset + limit);
        if (
          end < result.source.length &&
          /[\uD800-\uDBFF]/.test(result.source[end - 1] ?? "")
        )
          end += 1;
        if (
          offset > result.source.length ||
          /[\uDC00-\uDFFF]/.test(result.source[offset] ?? "")
        )
          throw new Error("Invalid source page offset.");
        return {
          ...result,
          source: result.source.slice(offset, end),
          offset,
          nextOffset: end < result.source.length ? end : null,
        };
      }
      case "design_foundation_read":
        return this.api.readFoundation(definitions[name].schema.parse(raw));
      case "design_projection_read":
        return this.api.readProjection(definitions[name].schema.parse(raw));
      case "design_provenance_read":
        return this.api.readProvenance(definitions[name].schema.parse(raw));
      case "design_transaction_apply": {
        const input = definitions[name].schema.parse(raw);
        const transaction = this.checkedTransaction(input.transaction);
        if (input.dryRun) return this.api.apply(transaction, { dryRun: true });
        // Do not validate a retry against today's revision before consulting
        // its durable receipt: a human may have edited after the lost reply.
        return this.mutate(
          transaction.transactionId,
          designRequestSignature(designTransactionSignature(transaction)),
          transaction.createdAt,
          async () => this.api.apply(transaction),
        );
      }
      case "design_proposal_create": {
        const transaction = this.checkedTransaction(
          definitions[name].schema.parse(raw).transaction,
        );
        const signature = designRequestSignature(
          designTransactionSignature(transaction),
        );
        const entries = await this.requests.read();
        const previous = entries.find(
          (entry) =>
            entry.id === transaction.transactionId &&
            entry.actorId === this.actor.id,
        );
        if (previous) {
          if (previous.signature !== signature)
            throw new Error(
              "Design proposal ID was reused with different content.",
            );
          return this.publicRecord(previous);
        }
        const result = await this.api.apply(transaction, { dryRun: true });
        const record: DesignRequestRecord = {
          id: transaction.transactionId,
          actorId: this.actor.id,
          signature,
          createdAt: transaction.createdAt,
          status: "proposed",
          transaction,
          proposal: {
            documentId: transaction.documentId,
            baseRevision: transaction.baseRevision,
            intent: transaction.intent ?? "Design proposal",
            operationCount: transaction.operations.length,
          },
          result,
        };
        this.requests.add(entries, record);
        this.options.onChanged?.();
        return this.publicRecord(record);
      }
      case "design_proposal_resolve": {
        const input = definitions[name].schema.parse(raw);
        const entries = await this.requests.read();
        const record = entries.find(
          (entry) =>
            entry.id === input.requestId && entry.actorId === this.actor.id,
        );
        if (record?.status === "committed" && input.decision === "apply")
          return record.result;
        if (record?.status === "rejected" && input.decision === "reject")
          return this.publicRecord(record);
        if (!record?.transaction)
          throw new Error("Design proposal was not found for this actor.");
        if (input.decision === "reject") {
          if (record.status !== "proposed" && record.status !== "rejected")
            throw new Error("This proposal can no longer be rejected.");
          record.status = "rejected";
          delete record.transaction;
          this.requests.write(entries);
          this.options.onChanged?.();
          return this.publicRecord(record);
        }
        const transaction = this.checkedTransaction(record.transaction);
        if (record.status === "proposed")
          await this.api.apply(transaction, { dryRun: true });
        return this.mutate(
          record.id,
          record.signature,
          transaction.createdAt,
          () => this.api.apply(transaction),
          transaction,
        );
      }
      case "design_request_status": {
        const input = definitions[name].schema.parse(raw);
        return this.publicRecord(
          (await this.requests.read()).find(
            (entry) =>
              entry.id === input.requestId && entry.actorId === this.actor.id,
          ),
        );
      }
      case "design_request_list": {
        const input = definitions[name].schema.parse(raw);
        const records = (await this.requests.read()).filter(
          (entry) => entry.actorId === this.actor.id,
        );
        return {
          requests: records
            .slice(input.offset, input.offset + input.limit)
            .map(({ transaction: _transaction, result: _result, ...entry }) =>
              this.publicRecord(entry),
            ),
          nextOffset:
            input.offset + input.limit < records.length
              ? input.offset + input.limit
              : null,
        };
      }
      case "design_history_undo":
      case "design_history_redo": {
        const input = definitions[name].schema.parse(raw);
        return this.mutate(
          input.requestId,
          designRequestSignature({ name, input }),
          input.createdAt,
          () =>
            name === "design_history_undo"
              ? this.api.undo(input.documentId, this.actor, {
                  expectedRevision: input.expectedRevision,
                })
              : this.api.redo(input.documentId, this.actor, {
                  expectedRevision: input.expectedRevision,
                }),
        );
      }
      case "design_frame_create": {
        const input = definitions[name].schema.parse(raw);
        return this.mutate(
          input.requestId,
          designRequestSignature({ name, input }),
          input.createdAt,
          () =>
            createDesignFrame(this.target.workspacePath, {
              title: input.title,
              geometry: { w: input.width, h: input.height },
            }),
        );
      }
      case "design_frame_rename":
      case "design_frame_duplicate":
      case "design_frame_delete": {
        const input = definitions[name].schema.parse(raw);
        return this.mutate(
          input.requestId,
          designRequestSignature({ name, input }),
          input.createdAt,
          async () => {
            await this.exact(input.documentId, input.expectedRevision);
            const frame = this.frame(input.documentId);
            if (name === "design_frame_rename")
              return renameDesignFrame(
                this.target.workspacePath,
                frame,
                definitions[name].schema.parse(raw).title,
              );
            if (name === "design_frame_duplicate")
              return duplicateDesignFrame(this.target.workspacePath, frame);
            await deleteDesignFrame(this.target.workspacePath, frame);
            return { documentId: input.documentId, deleted: true };
          },
        );
      }
      case "design_lint": {
        const input = definitions[name].schema.parse(raw);
        await this.exact(input.documentId, input.expectedRevision);
        const { workspacePath: _workspacePath, ...lint } =
          await lintDesignDocument(
            this.target.workspacePath,
            this.frame(input.documentId),
            { healOids: false, includeRuntimeAudits: false },
          );
        await this.exact(input.documentId, input.expectedRevision);
        return { ...input, ...lint };
      }
      case "design_render": {
        const input = definitions[name].schema.parse(raw);
        const frame = this.frame(input.documentId);
        const source = await this.api.readSource({ ...input, file: frame });
        const render = await readDesignFrameRenderSourceFromSource(
          this.target.workspacePath,
          frame,
          source.source,
        );
        await this.exact(input.documentId, input.expectedRevision);
        return {
          ...input,
          revision: source.revision,
          ...render,
          mimeType: "text/html",
          fidelity: "authored-sanitized",
          contentHash: createHash("sha256")
            .update(render.html, "utf8")
            .digest("hex"),
          contentHashAlgorithm: "sha256-utf8",
        };
      }
      case "design_result_create": {
        const input = definitions[name].schema.parse(raw);
        return this.mutate(
          input.requestId,
          designRequestSignature({ name, input }),
          input.createdAt,
          () =>
            createDesignResult(
              this.target.workspacePath,
              this.target.directoryId,
              this.actor.id,
              input,
              { renderer: this.options.renderer, signal },
            ),
        );
      }
      case "design_result_list":
        return new DesignResultStore(
          this.target.workspacePath,
          this.target.directoryId,
        ).list(this.actor.id);
      case "design_result_read": {
        const input = definitions[name].schema.parse(raw);
        const bundle = await new DesignResultStore(
          this.target.workspacePath,
          this.target.directoryId,
        ).read(input.resultId, this.actor.id);
        const artifact = input.artifact as DesignResultArtifactName;
        const data = bundle.content[artifact];
        if (data === undefined)
          throw new Error("This result has no requested artifact.");
        if (
          input.offset > data.length ||
          /[\uDC00-\uDFFF]/.test(data[input.offset] ?? "")
        )
          throw new Error("Invalid artifact page offset.");
        let end = Math.min(data.length, input.offset + input.limit);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1] ?? ""))
          end++;
        return {
          manifest: bundle.manifest,
          artifact,
          ...bundle.manifest.artifacts[artifact],
          offset: input.offset,
          data: data.slice(input.offset, end),
          nextOffset: end < data.length ? end : null,
        };
      }
      case "design_capture": {
        const { width, height, ...input } = definitions[name].schema.parse(raw);
        const artifact = await this.api.render({
          ...input,
          viewport: {
            width,
            height,
            deviceScaleFactor: 1,
            reducedMotion: "reduce",
          },
          signal,
        });
        if (artifact.revision !== input.expectedRevision)
          throw new Error(
            "Capture fell back to another revision; exact evidence is unavailable.",
          );
        if (artifact.bytes.byteLength > 1024 * 1024)
          throw new Error("Capture exceeds 1 MiB; use a smaller viewport.");
        return {
          ...input,
          ...artifact,
          bytes: undefined,
          data: Buffer.from(artifact.bytes).toString("base64"),
        };
      }
    }
  }
}
