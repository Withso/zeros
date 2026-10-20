import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { AgentMessage, AgentSessionState, AgentTextMessage } from "../../use-agent-session";
import { isCloudWorkspace } from "../../../../platform/bridge/cloud-workspace-key";

// Run AgentChat's real projection. Transport tests must prove their accepted
// row reaches the transcript, not merely that an invisible queue owns it.
const source = readFileSync(new URL("../../agent-chat.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("agent-chat.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "";
function collect(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) &&
      node.name.elements.some(element => element.name.getText(ast) === "queuedMessages") &&
      node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0]!.getText(ast);
  ts.forEachChild(node, collect);
}
collect(ast);
if (!callback) throw new Error("AgentChat transcript projection was not found");
const code = ts.transpileModule(`globalThis.project = (session) => (${callback})();`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const context: Record<string, unknown> = { isCloudWorkspace, transcriptParentId: () => undefined, computeEditBaselines: () => new Map() };
vm.runInNewContext(code, context);
export function queuedTranscriptPresentation(messages: AgentMessage[], session: Partial<AgentSessionState> = {}): { visibleMessages: AgentMessage[]; queuedMessages: AgentTextMessage[] } {
  return (context.project as (session: Partial<AgentSessionState>) => ReturnType<typeof queuedTranscriptPresentation>)({ ...session, messages });
}
