import { z } from "zod";

// Additive workspace operations. No canvas/Foundation/runtime format changes.
export const designReviewScopeSchema = z.enum([
  "all",
  "uncommitted",
  "staged",
  "unstaged",
  "proposals",
]);
export type DesignReviewScope = z.infer<typeof designReviewScopeSchema>;
export const designReviewRequestSchema = z
  .object({
    workspaceId: z.string().min(1).max(4096),
    scope: designReviewScopeSchema.default("uncommitted"),
    offset: z.number().int().min(0).max(100_000).default(0),
    limit: z.number().int().min(1).max(128).default(64),
  })
  .strict();
export const designReviewProposalRequestSchema = z
  .object({
    workspaceId: z.string().min(1).max(4096),
    directoryId: z.string().min(1).max(128),
    actorId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128),
  })
  .strict();
export const designReviewDecisionSchema = designReviewProposalRequestSchema
  .extend({
    signature: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(["accept", "reject"]),
  })
  .strict();
export const designReviewFileRequestSchema = z
  .object({
    workspaceId: z.string().min(1).max(4096),
    directoryId: z.string().min(1).max(128),
    scope: designReviewScopeSchema.exclude(["proposals"]),
    path: z.string().min(1).max(4096),
    oldPath: z.string().min(1).max(4096).optional(),
  })
  .strict();

export interface DesignReviewFile {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
}
export interface DesignReviewProposal {
  id: string;
  actorId: string;
  signature: string;
  createdAt: number;
  status: "proposed" | "committed" | "rejected" | "indeterminate";
  intent: string;
  documentId: string | null;
  baseRevision: string | null;
  operationCount: number;
  review?: {
    decision: "accept" | "reject";
    reviewerId: string;
    reviewedAt: number;
  };
}
export interface DesignReviewSnapshot {
  directory: string;
  directoryId: string;
  indexFingerprint: string;
  scope: DesignReviewScope;
  counts: Record<DesignReviewScope, number>;
  files: DesignReviewFile[];
  proposals: DesignReviewProposal[];
  nextOffset: number | null;
  conflict: boolean;
}
export interface DesignProposalReview {
  captureAvailable?: boolean;
  evidence?: DesignReviewEvidenceSummary | null;
  proposal: DesignReviewProposal;
  currentRevision: string | null;
  applicable: boolean;
  reason: string | null;
  patch: string;
  truncated: boolean;
  operations: Array<{ type: string; nodeId?: string }>;
}
export interface DesignReviewFileDetail {
  path: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
}

export const designReviewCaptureRequestSchema =
  designReviewProposalRequestSchema
    .extend({ signature: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict();
export const designReviewEvidenceRequestSchema =
  designReviewCaptureRequestSchema
    .extend({ resultId: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict();
export interface DesignReviewEvidenceSummary {
  id: string;
  baseRevision: string;
  revision: string;
  createdAt: number;
  viewport: { width: number; height: number; deviceScaleFactor: 1 };
  renderer: string | null;
}
export interface DesignReviewEvidence extends DesignReviewEvidenceSummary {
  before: string;
  after: string;
}
