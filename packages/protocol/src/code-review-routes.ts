import {
  codeReviewCreateInputSchema, codeReviewListInputSchema,
  codeReviewReplyInputSchema, codeReviewSetResolvedInputSchema,
  type CodeReviewActor, type CodeReviewOperation,
} from "./code-review-contract";
import type { CodeReviewStoreCore } from "./code-review-store";
import { CodeReviewError, parseCodeReviewInput } from "./code-review-errors";
import type { CodeReviewPathPolicy } from "./code-review-paths";

export interface CodeReviewRouteHost {
  resolveReadCwd(workspaceId: string, remote: boolean): string;
  ownerRoots(): readonly string[];
}
export interface CodeReviewCoreRouteOptions extends CodeReviewPathPolicy {
  author(): CodeReviewActor;
  viewer: boolean;
  assertPath(root: string, relative: string, policy: CodeReviewPathPolicy, creating?: boolean): void;
}

export function handleCodeReviewRouteCore(
  host: CodeReviewRouteHost, operation: CodeReviewOperation, raw: unknown,
  options: CodeReviewCoreRouteOptions, store: CodeReviewStoreCore,
): unknown {
  // One synchronous owner snapshot per operation; listing a discussion never
  // issues a workspace-registry query for each thread or line.
  let ownerRoots: readonly string[] | undefined;
  const pathPolicy = { ...options, ownerRoots: () => ownerRoots ??= host.ownerRoots() };
  const rootFor = (workspaceId: string) => host.resolveReadCwd(workspaceId, options.remote === true);
  const author = options.author;
  const assertCodeReviewPath = options.assertPath;
  switch (operation) {
    case "codeReview.list": {
      const input = parseCodeReviewInput(codeReviewListInputSchema, raw);
      const root = rootFor(input.workspaceId);
      if (input.path) assertCodeReviewPath(root, input.path, pathPolicy);
      const result = store.list(input);
      const readablePaths = new Map<string, boolean>();
      const viewer = options.viewer ? author() : undefined;
      return { ...result, ...(viewer ? { viewerActorId: viewer.id } : {}), threads: result.threads.filter((thread) => {
        const known = readablePaths.get(thread.anchor.path);
        if (known !== undefined) return known;
        try { assertCodeReviewPath(root, thread.anchor.path, pathPolicy); readablePaths.set(thread.anchor.path, true); return true; }
        catch (error) {
          if (error instanceof CodeReviewError && error.code === "CODE_REVIEW_PATH_DENIED") { readablePaths.set(thread.anchor.path, false); return false; }
          throw error;
        }
      }) };
    }
    case "codeReview.create": {
      const input = parseCodeReviewInput(codeReviewCreateInputSchema, raw);
      assertCodeReviewPath(rootFor(input.workspaceId), input.anchor.path, pathPolicy, true);
      return store.create(input, author());
    }
    case "codeReview.reply": {
      const input = parseCodeReviewInput(codeReviewReplyInputSchema, raw);
      const root = rootFor(input.workspaceId);
      const thread = store.get(input.workspaceId, input.threadId);
      assertCodeReviewPath(root, thread.anchor.path, pathPolicy);
      return store.reply(input, author());
    }
    case "codeReview.setResolved": {
      const input = parseCodeReviewInput(codeReviewSetResolvedInputSchema, raw);
      const root = rootFor(input.workspaceId);
      const thread = store.get(input.workspaceId, input.threadId);
      assertCodeReviewPath(root, thread.anchor.path, pathPolicy);
      return store.setResolved(input, author());
    }
  }
}
