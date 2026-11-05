import { z } from "zod";
import {
  applyConflictChoices,
  parseMergeConflicts,
  resolveConflictInputSchema,
  type ResolveConflictInput,
  type ConflictResolutionResult,
  type GitReviewOperation,
} from "@zeros/protocol/git-review-actions";
import { isSensitiveRepoPath } from "../files/read-file";
import {
  inspectExpectedWorkspaceContent,
  assertGuardedWorkspaceFilePath,
} from "../files/file-content-guard";
import { writeWorkspaceFile } from "../files/write-file";
import { status } from "./diff";
import { resolveRepoForGitOp } from "./worktree";
import { withWorkspaceGitMutation } from "./mutation-lock";
import { assertReviewSourceWriteAllowed } from "./review-source-guard";
import { GitError } from "./errors";

export interface GitReviewContext {
  /** Trusted exact root from WorkspaceService.resolveReadCwd, never wire data. */
  cwd: string;
  remote?: boolean;
  /** The existing dispatcher Design guard, in addition to the direct guard. */
  assertSourceWrite?: (
    paths: readonly string[],
    action: string,
  ) => Promise<void>;
}
const invalid = (message: string) =>
  new GitError({ code: "VALIDATION_FAILED", message });
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw invalid(
      "Invalid conflict resolution. Use one workspace-relative text file and its original content snapshot.",
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
): void {
  if (context.remote && isSensitiveRepoPath(relative))
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
  authorizePath(context, path);
  await assertReviewSourceWriteAllowed(context.cwd, path, prospectiveContent);
  await context.assertSourceWrite?.([path], "reviewing");
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
    case "git.resolveConflict":
      return resolveConflict(
        parse(resolveConflictInputSchema, params),
        context,
      );
  }
}
