import {
  codeReviewCreateInputSchema, codeReviewListInputSchema,
  codeReviewReplyInputSchema, codeReviewSetResolvedInputSchema,
  type CodeReviewActor, type CodeReviewOperation,
} from "@zeros/protocol/code-review";
import { codeReviewStore, type CodeReviewStore } from "../db/code-review";
import { codeReviewHumanActor } from "./actors";
import { CodeReviewError, parseCodeReviewInput } from "./errors";
import { assertCodeReviewPath, type CodeReviewPathPolicy } from "./paths";

export interface CodeReviewRouteHost {
  resolveReadCwd(workspaceId: string, remote: boolean): string;
  ownerRoots(): readonly string[];
}
export interface CodeReviewRouteOptions extends CodeReviewPathPolicy {
  /** Trusted engine-side actor; never part of a public request schema. */
  actor?: CodeReviewActor;
  userId?: string;
  userName?: string;
}

export function handleCodeReviewRoute(
  host: CodeReviewRouteHost, operation: CodeReviewOperation, raw: unknown,
  options: CodeReviewRouteOptions = {}, store: CodeReviewStore = codeReviewStore,
): unknown {
  // One synchronous owner snapshot per operation; listing a discussion never
  // issues a workspace-registry query for each thread or line.
  let ownerRoots: readonly string[] | undefined;
  const pathPolicy = { ...options, ownerRoots: () => ownerRoots ??= host.ownerRoots() };
  const rootFor = (workspaceId: string) => host.resolveReadCwd(workspaceId, options.remote === true);
  const author = () => options.actor ?? codeReviewHumanActor(options.userId, options.remote, options.userName);
  switch (operation) {
    case "codeReview.list": {
      const input = parseCodeReviewInput(codeReviewListInputSchema, raw);
      const root = rootFor(input.workspaceId);
      if (input.path) assertCodeReviewPath(root, input.path, pathPolicy);
      const result = store.list(input);
      const readablePaths = new Map<string, boolean>();
      const viewer = options.actor || options.userId || !options.remote ? author() : undefined;
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
