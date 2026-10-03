import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  codeReviewCreateInputSchema, codeReviewListInputSchema,
  codeReviewReplyInputSchema, codeReviewSetResolvedInputSchema,
  type CodeReviewActor, type CodeReviewOperation,
} from "@zeros/protocol/code-review";
import { handleCodeReviewRoute, type CodeReviewRouteHost } from "../code-review/routes";
import { CodeReviewError, parseCodeReviewInput } from "../code-review/errors";
import { type CodeReviewStore, codeReviewStore } from "../db/code-review";
import type { AgentWorkspaceTools } from "./session-tools";

const definitions = {
  code_review_list: {
    operation: "codeReview.list",
    description: "Read durable review threads in this session's workspace. Optionally filter by file path or threadId; resolved threads are included by default. Results are bounded pages: follow nextCursor with the same filters and merge by thread/comment ID and sequence until partial is false. Mutation previews expose commentsCursor for missing history; read it with threadId.",
    schema: codeReviewListInputSchema.omit({ workspaceId: true }),
  },
  code_review_create: {
    operation: "codeReview.create",
    description: "Create a durable line/range review thread in this session's workspace. Anchor the original old/new/file side and viewed content revision. This records a comment without editing source. Reuse requestId with identical input after a lost response.",
    schema: codeReviewCreateInputSchema.omit({ workspaceId: true }),
  },
  code_review_reply: {
    operation: "codeReview.reply",
    description: "Append a reply to a workspace review thread as this agent. Other replies are retained. Reuse requestId with identical input after a lost response.",
    schema: codeReviewReplyInputSchema.omit({ workspaceId: true }),
  },
  code_review_set_resolved: {
    operation: "codeReview.setResolved",
    description: "Resolve or reopen a workspace review thread at its latest expectedVersion. Read the thread again if its version changed. Resolving a comment never applies or accepts source edits.",
    schema: codeReviewSetResolvedInputSchema.omit({ workspaceId: true }),
  },
} satisfies Record<string, { operation: CodeReviewOperation; description: string; schema: z.ZodType }>;

export interface CodeReviewAgentScope {
  readonly workspaceId: string;
  readonly workspacePath: string;
  assertCurrent(): void;
}

/** Included in the existing per-execution authenticated product MCP server.
 * Neither author nor workspace authority appears in a tool argument schema. */
export class CodeReviewAgentTools implements AgentWorkspaceTools {
  readonly workspaceId: string;
  readonly workspacePath: string;
  constructor(
    private readonly scope: CodeReviewAgentScope,
    private readonly host: CodeReviewRouteHost,
    private readonly actor: CodeReviewActor,
    private readonly onChanged?: (workspaceId: string) => void,
    private readonly store: CodeReviewStore = codeReviewStore,
  ) {
    this.workspaceId = scope.workspaceId;
    this.workspacePath = scope.workspacePath;
  }
  assertCurrent(): void { this.scope.assertCurrent(); }
  listTools(): Tool[] {
    this.assertCurrent();
    return Object.entries(definitions).map(([name, definition]) => ({
      name, description: definition.description,
      inputSchema: z.toJSONSchema(definition.schema) as Tool["inputSchema"],
    }));
  }
  async callTool(name: string, raw: unknown, signal: AbortSignal): Promise<CallToolResult> {
    this.assertCurrent();
    signal.throwIfAborted();
    if (!Object.hasOwn(definitions, name)) throw new CodeReviewError("CODE_REVIEW_INVALID", "Unknown workspace review tool.");
    const definition = definitions[name as keyof typeof definitions];
    const input = parseCodeReviewInput(definition.schema as z.ZodType<Record<string, unknown>>, raw);
    const result = handleCodeReviewRoute(this.host, definition.operation, {
      ...input, workspaceId: this.workspaceId,
    }, { actor: this.actor }, this.store);
    if (definition.operation !== "codeReview.list") this.onChanged?.(this.workspaceId);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
}
