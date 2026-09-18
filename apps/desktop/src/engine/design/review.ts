import { DesignResultStore } from "./result-store";
import { resolveDesignCaptureConfig } from "./capture-client";
import { createTwoFilesPatch } from "diff";
import {
  applyDesignTransaction,
  designTransactionSignature,
  DesignTransactionConflictError,
} from "@zeros/design-core";
import { designWebTransactionAdapter } from "@zeros/design-web";
import type {
  DesignProposalReview,
  DesignReviewProposal,
} from "@zeros/protocol/design-review";
import { designDirectoryEntry } from "./metadata";
import { designDirectoryNameFor, readDesignWebDocumentState } from "./document";
import { getWorkspaceDesignApi } from "./design-api";
import {
  DesignRequestStore,
  designRequestSignature,
  type DesignRequestRecord,
} from "./request-store";
import { DESIGN_AGENT_SAFE_OPERATION_TYPES } from "./design-agent-capability";
import { withDesignWorkspaceMutation } from "./document-write-lock";

const MAX_REVIEW_PATCH_BYTES = 512 * 1024;

export function assertDesignReviewDirectory(
  workspacePath: string,
  expectedId: string,
): string {
  const directory = designDirectoryNameFor(workspacePath);
  if (designDirectoryEntry(workspacePath, directory)?.id !== expectedId) {
    throw new Error(
      "The Design directory changed. Reopen review before continuing.",
    );
  }
  return directory;
}

export function designReviewProposal(
  record: DesignRequestRecord,
): DesignReviewProposal {
  const proposal =
    record.proposal ??
    (record.transaction
      ? {
          ...record.transaction,
          operationCount: record.transaction.operations.length,
        }
      : null);
  return {
    id: record.id,
    actorId: record.actorId,
    signature: record.signature,
    createdAt: record.createdAt,
    status: record.status === "started" ? "indeterminate" : record.status,
    documentId: proposal?.documentId ?? null,
    baseRevision: proposal?.baseRevision ?? null,
    intent: proposal?.intent ?? "Design request",
    operationCount: proposal?.operationCount ?? 0,
    ...(record.review ? { review: record.review } : {}),
  };
}

interface ProposalIdentity {
  directoryId: string;
  actorId: string;
  requestId: string;
}
function findProposal(entries: DesignRequestRecord[], input: ProposalIdentity) {
  const record = entries.find(
    (entry) => entry.id === input.requestId && entry.actorId === input.actorId,
  );
  if (!record)
    throw new Error(
      "This proposal has expired or is no longer available. Refresh review.",
    );
  return record;
}

/** Observational preview: run the same adapter against an immutable source
 * state. Bounded diff work keeps a pathological document off the UI thread. */
export async function readDesignProposalReview(
  workspacePath: string,
  input: ProposalIdentity,
): Promise<DesignProposalReview> {
  return withDesignWorkspaceMutation(workspacePath, async () => {
    assertDesignReviewDirectory(workspacePath, input.directoryId);
    const record = findProposal(
      await new DesignRequestStore(workspacePath, input.directoryId).read(),
      input,
    );
    const evidence = (
      await new DesignResultStore(workspacePath, input.directoryId).list(
        input.actorId,
      )
    ).find(
      (manifest) =>
        manifest.proposalId === record.id &&
        manifest.proposalSignature === record.signature &&
        manifest.artifacts["before.png"] &&
        manifest.artifacts["after.png"],
    );
    const result: DesignProposalReview = {
      captureAvailable: !!resolveDesignCaptureConfig(),
      evidence: evidence
        ? {
            id: evidence.id,
            baseRevision: evidence.baseRevision,
            revision: evidence.revision,
            createdAt: evidence.createdAt,
            viewport: evidence.viewport,
            renderer: evidence.renderer,
          }
        : null,
      proposal: designReviewProposal(record),
      currentRevision: null,
      applicable: false,
      reason: null,
      patch: "",
      truncated: false,
      operations:
        record.transaction?.operations.map((op) => ({
          type: op.type,
          ...("nodeId" in op ? { nodeId: op.nodeId } : {}),
        })) ?? [],
    };
    if (record.status !== "proposed" || !record.transaction) {
      result.reason =
        record.status === "started" || record.status === "indeterminate"
          ? "The previous write has an uncertain outcome. Inspect the source before creating a new proposal."
          : "This proposal has already been resolved.";
      return result;
    }
    try {
      const tx = record.transaction;
      const state = await readDesignWebDocumentState(
        workspacePath,
        tx.documentId.replace(/^frame:/, ""),
      );
      result.currentRevision = state.revision;
      if (state.revision !== tx.baseRevision) {
        result.reason =
          "The source changed after this proposal. Ask the agent to prepare a new proposal.";
        return result;
      }
      assertReviewTransaction(record);
      const outcome = applyDesignTransaction(
        state,
        tx,
        designWebTransactionAdapter,
      );
      const before = {
        ...state.files,
        "@foundation": JSON.stringify(state.manifest, null, 2),
        "@frames": JSON.stringify(state.frames, null, 2),
      };
      const after = {
        ...outcome.state.files,
        "@foundation": JSON.stringify(outcome.state.manifest, null, 2),
        "@frames": JSON.stringify(outcome.state.frames, null, 2),
      };
      for (const file of new Set([
        ...Object.keys(before),
        ...Object.keys(after),
      ])) {
        const previous = before[file as keyof typeof before] ?? "";
        const next = after[file as keyof typeof after] ?? "";
        if (previous === next) continue;
        if (
          Buffer.byteLength(previous) + Buffer.byteLength(next) >
          MAX_REVIEW_PATCH_BYTES
        ) {
          result.truncated = true;
          result.patch += `\n${file}: source is too large for an inline diff.\n`;
          continue;
        }
        const patch = createTwoFilesPatch(
          file,
          file,
          previous,
          next,
          "Before",
          "Proposed",
          { context: 3, timeout: 250 },
        );
        if (
          !patch ||
          Buffer.byteLength(result.patch) + Buffer.byteLength(patch) >
            MAX_REVIEW_PATCH_BYTES
        ) {
          result.truncated = true;
          break;
        }
        result.patch += patch;
      }
      result.applicable = true;
    } catch (error) {
      result.reason =
        error instanceof Error
          ? error.message
          : "The proposal could not be validated.";
    }
    return result;
  });
}

export function assertReviewTransaction(record: DesignRequestRecord): void {
  const tx = record.transaction;
  if (
    !tx ||
    tx.actor.kind !== "agent" ||
    tx.actor.id !== record.actorId ||
    tx.transactionId !== record.id ||
    designRequestSignature(designTransactionSignature(tx)) !==
      record.signature ||
    tx.operations.some(
      (op) =>
        !(DESIGN_AGENT_SAFE_OPERATION_TYPES as readonly string[]).includes(
          op.type,
        ),
    )
  ) {
    throw new Error(
      "This proposal does not contain an authorized Design transaction.",
    );
  }
}

/** Trusted human route only. The receipt keeps the originating agent actor;
 * human review is recorded separately and cannot be supplied by an MCP tool. */
export async function resolveDesignProposalReview(
  workspacePath: string,
  input: ProposalIdentity & {
    signature: string;
    decision: "accept" | "reject";
  },
): Promise<DesignReviewProposal> {
  return withDesignWorkspaceMutation(workspacePath, async () => {
    assertDesignReviewDirectory(workspacePath, input.directoryId);
    const store = new DesignRequestStore(workspacePath, input.directoryId);
    const entries = await store.read();
    const record = findProposal(entries, input);
    if (record.signature !== input.signature)
      throw new Error("The proposal changed. Refresh review.");
    if (
      record.review?.decision === input.decision &&
      record.status === (input.decision === "accept" ? "committed" : "rejected")
    )
      return designReviewProposal(record);
    if (record.status !== "proposed")
      throw new Error(
        "This proposal is already resolved or has an uncertain outcome. Refresh review.",
      );
    assertReviewTransaction(record);
    if (input.decision === "accept") {
      const api = getWorkspaceDesignApi(workspacePath);
      // Validate before marking started: a stale proposal remains inspectable.
      await api.apply(record.transaction!, { dryRun: true });
      assertDesignReviewDirectory(workspacePath, input.directoryId);
      record.status = "started";
      store.write(entries);
      try {
        record.result = await api.apply(record.transaction!);
        record.status = "committed";
      } catch (error) {
        record.status =
          error instanceof DesignTransactionConflictError
            ? "rejected"
            : "indeterminate";
        store.write(entries);
        throw error;
      }
    } else record.status = "rejected";
    record.review = {
      decision: input.decision,
      reviewerId: "desktop",
      reviewedAt: Date.now(),
    };
    delete record.transaction;
    store.write(entries);
    return designReviewProposal(record);
  });
}
