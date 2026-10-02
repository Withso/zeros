import { z } from "zod";
import {
  applyConflictChoices,
  parseMergeConflicts,
  splitReviewHunks,
  untrackedReviewPatch,
  reverseReviewHunkContent,
  reviewContentRevision,
  reviewHunkKey,
  reviewHunkInputSchema,
  reviewHunksInputSchema,
  resolveConflictInputSchema,
  type ReviewHunkInput,
  type ReviewHunksInput,
  type ResolveConflictInput,
  type HunkReviewResult,
  type ConflictResolutionResult,
  type GitReviewOperation,
} from "@zeros/protocol/git-review-actions";
import { isSensitiveRepoPath } from "../files/read-file";
import {
  inspectExpectedWorkspaceContent,
  assertGuardedWorkspaceFilePath,
} from "../files/file-content-guard";
import { writeWorkspaceFile } from "../files/write-file";
import { deleteWorkspaceFileIfUnchanged } from "../files/delete-file-if-unchanged";
import type { QualifiedCloudFilePolicy } from "../files/cloud-file-policy";
import { diff, status } from "./diff";
import { resolveRepoForGitOp } from "./worktree";
import { inspectApplyPatchPaths } from "./stage";
import { withWorkspaceGitMutation } from "./mutation-lock";
import { listStoredHunkReviews, storeHunkReview } from "./hunk-review-store";
import { assertReviewSourceWriteAllowed } from "./review-source-guard";
import { GitError } from "./errors";

export interface GitReviewContext {
  /** Trusted exact root from WorkspaceService.resolveReadCwd, never wire data. */
  cwd: string;
  remote?: boolean;
  cloudPolicy?: QualifiedCloudFilePolicy;
  /** The existing dispatcher Design guard, in addition to the direct guard. */
  assertSourceWrite?: (
    paths: readonly string[],
    action: string,
  ) => Promise<void>;
}
const invalid = (message: string) =>
  new GitError({ code: "VALIDATION_FAILED", message });
const stale = () =>
  invalid("The selected hunk changed. Refresh the diff before reviewing it.");
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw invalid(
      "Invalid Git review action. Use one live workspace-relative text hunk and its original content snapshot.",
    );
  return parsed.data;
}
async function contextFor(
  workspaceId: string,
  context?: GitReviewContext,
): Promise<GitReviewContext> {
  return context ?? { cwd: (await resolveRepoForGitOp(workspaceId)).path };
}
function authorizePath(
  context: GitReviewContext,
  relative: string,
  write = false,
): void {
  context.cloudPolicy?.assertPath(relative, write);
  if (context.remote && !context.cloudPolicy && isSensitiveRepoPath(relative))
    throw invalid(
      "Refusing to review a secret/credential file over a remote connection.",
    );
  assertGuardedWorkspaceFilePath(context.cwd, relative);
}
async function authorizeWrite(
  context: GitReviewContext,
  path: string,
  prospectiveContent?: string | null,
): Promise<void> {
  authorizePath(context, path, true);
  await assertReviewSourceWriteAllowed(context.cwd, path, prospectiveContent);
  await context.assertSourceWrite?.([path], "reviewing");
}

export async function listHunkReviews(
  raw: ReviewHunksInput,
  suppliedContext?: GitReviewContext,
) {
  const input = parse(reviewHunksInputSchema, raw);
  const context = await contextFor(input.workspaceId, suppliedContext);
  authorizePath(context, input.path);
  return listStoredHunkReviews(context.cwd, input.path);
}

export async function reviewHunk(
  raw: ReviewHunkInput,
  suppliedContext?: GitReviewContext,
): Promise<HunkReviewResult> {
  const input = parse(reviewHunkInputSchema, raw);
  if (input.decision === "rejected" && input.confirm !== true)
    throw invalid(
      "Rejecting a hunk discards those changes. Confirm the rejection first.",
    );
  if (splitReviewHunks(input.patch).length !== 1)
    throw invalid(
      "Select exactly one text hunk; renames, binary files and mode changes are not hunk review targets.",
    );
  const context = await contextFor(input.workspaceId, suppliedContext);
  return withWorkspaceGitMutation(context.cwd, async () => {
    authorizePath(context, input.path);
    if (input.decision === "rejected")
      await authorizeWrite(context, input.path);
    const originalGeneration = inspectExpectedWorkspaceContent(
      context.cwd,
      input.path,
      input.expectedContent,
    );
    const paths = await inspectApplyPatchPaths({
      workspaceId: input.workspaceId,
      patch: input.patch,
    });
    if (paths.length !== 1 || paths[0] !== input.path)
      throw invalid("The patch must target only the selected file.");
    const fileStatus = await status(input.workspaceId, {
      paths: [input.path],
      includeTracking: false,
    });
    if (fileStatus.conflicted.length)
      throw invalid(
        "Resolve this file's merge conflicts before reviewing its hunks.",
      );
    const query = {
      workspaceId: input.workspaceId,
      filePath: input.path,
      mode: input.comparison,
      rawPatch: true,
      ...(input.comparison === "worktree-vs-head" ? { base: "HEAD" } : {}),
    } as const;
    const live = await diff(query);
    let matches = splitReviewHunks(live.patch ?? "").some(
      (hunk) => hunk.patch === input.patch,
    );
    if (
      !matches &&
      fileStatus.untracked.includes(input.path) &&
      input.expectedContent !== null
    ) {
      matches =
        untrackedReviewPatch(input.path, input.expectedContent) === input.patch;
    }
    if (!matches && live.patch) {
      const complete = await diff({ ...query, fullContext: true });
      matches = splitReviewHunks(complete.patch ?? "").some(
        (hunk) => hunk.patch === input.patch,
      );
    }
    if (!matches) throw stale();
    const reversed = reverseReviewHunkContent(
      input.expectedContent,
      input.patch,
    );
    // Every async Git/Design read completes before the final synchronous byte
    // check and guarded filesystem mutation. App-owned writers share this lane.
    if (input.decision === "rejected")
      await authorizeWrite(context, input.path, reversed);
    else authorizePath(context, input.path);
    if (
      inspectExpectedWorkspaceContent(
        context.cwd,
        input.path,
        input.expectedContent,
      ) !== originalGeneration
    )
      throw stale();
    if (input.decision === "rejected") {
      const result =
        reversed === null
          ? deleteWorkspaceFileIfUnchanged(
              context.cwd,
              input.path,
              input.expectedContent!,
              context,
            )
          : writeWorkspaceFile(context.cwd, input.path, reversed, {
              ...context,
              expectedContent: input.expectedContent,
            });
      if (result.kind !== "success")
        throw invalid(
          result.error ?? "The selected hunk could not be safely rejected.",
        );
    }
    const key = reviewHunkKey(
      input.path,
      input.comparison,
      input.patch,
      reviewContentRevision(input.expectedContent),
    );
    const decision = storeHunkReview(context.cwd, {
      key,
      path: input.path,
      comparison: input.comparison,
      decision: input.decision,
      updatedAt: Date.now(),
    });
    return { decision, fileChanged: input.decision === "rejected" };
  });
}

export async function resolveConflict(
  raw: ResolveConflictInput,
  suppliedContext?: GitReviewContext,
): Promise<ConflictResolutionResult> {
  const input = parse(resolveConflictInputSchema, raw);
  const parsed = parseMergeConflicts(input.expectedContent);
  if (!parsed.conflicts.length || parsed.errors.length)
    throw invalid(
      "The original file does not contain complete merge conflict blocks.",
    );
  let preview: ReturnType<typeof applyConflictChoices>;
  try {
    preview = applyConflictChoices(input.expectedContent, input.choices);
  } catch {
    throw invalid("Conflict choices belong to a different file snapshot.");
  }
  if (
    preview.remaining !== 0 ||
    preview.content !== input.content ||
    parseMergeConflicts(input.content).conflicts.length ||
    parseMergeConflicts(input.content).errors.length
  )
    throw invalid(
      "Choose a resolution for every conflict. Unrelated source must remain unchanged.",
    );
  const context = await contextFor(input.workspaceId, suppliedContext);
  return withWorkspaceGitMutation(context.cwd, async () => {
    await authorizeWrite(context, input.path, input.content);
    inspectExpectedWorkspaceContent(
      context.cwd,
      input.path,
      input.expectedContent,
    );
    const currentStatus = await status(input.workspaceId, {
      paths: [input.path],
      includeTracking: false,
    });
    if (!currentStatus.conflicted.some((file) => file.path === input.path))
      throw invalid(
        "This file is no longer a live Git conflict. Refresh it before saving.",
      );
    await authorizeWrite(context, input.path, input.content);
    const result = writeWorkspaceFile(context.cwd, input.path, input.content, {
      ...context,
      expectedContent: input.expectedContent,
    });
    if (result.kind !== "success")
      throw invalid(
        result.error ?? "The conflict resolution could not be safely saved.",
      );
    return { kind: "success", path: input.path, bytes: result.bytes };
  });
}

/** Register only these named operations behind the existing workspace write,
 * restriction, lifecycle, Design, and cloud actor policy gates. */
export function handleGitReviewOperation(
  op: GitReviewOperation,
  params: Record<string, unknown>,
  context: GitReviewContext,
): Promise<unknown> {
  switch (op) {
    case "git.reviewHunks":
      return listHunkReviews(parse(reviewHunksInputSchema, params), context);
    case "git.reviewHunk":
      return reviewHunk(parse(reviewHunkInputSchema, params), context);
    case "git.resolveConflict":
      return resolveConflict(
        parse(resolveConflictInputSchema, params),
        context,
      );
  }
}
