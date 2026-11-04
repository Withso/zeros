import { CodeReviewAgentToolsCore, type CodeReviewActor, type CodeReviewAgentScope } from "@zeros/protocol/code-review";
import { handleCodeReviewRoute, type CodeReviewRouteHost } from "../code-review/routes";
import { type CodeReviewStore, codeReviewStore } from "../db/code-review";
import type { AgentWorkspaceTools } from "./session-tools";
export type { CodeReviewAgentScope } from "@zeros/protocol/code-review";

export class CodeReviewAgentTools extends CodeReviewAgentToolsCore implements AgentWorkspaceTools {
  constructor(scope: CodeReviewAgentScope, host: CodeReviewRouteHost, actor: CodeReviewActor,
    onChanged?: (workspaceId: string) => void, store: CodeReviewStore = codeReviewStore) {
    super(scope, (operation, raw, author) => handleCodeReviewRoute(host, operation, raw, { actor: author }, store), actor, onChanged);
  }
}
