import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { captureNativeMcpTurn } from "../cloud-workspace-validation/lib/native-qualification-steps";
import { NativeToolEvidence } from "../cloud-workspace-validation/lib/native-tool-evidence";
import { NativeQuestionEvidence } from "../cloud-workspace-validation/lib/native-question-evidence";
import { nativeQualificationQuestion } from "../cloud-workspace-validation/lib/native-qualification-input";

// Exercise the entrypoint's actual callbacks without loading its private input
// or running a provider. The separate redaction suite owns notification wiring.
const source = ts.createSourceFile("qualify-cloud-agent.ts", readFileSync(new URL(
  "../cloud-workspace-validation/sandbox/qualify-cloud-agent.ts", import.meta.url,
), "utf8"), ts.ScriptTarget.Latest, true);
const captures: string[] = [];
let questionCallback = "";
function collect(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "captureNativeMcpTurn") captures.push(node.getText(source));
  if (ts.isMethodDeclaration(node) && node.name.getText(source) === "onQuestionRequest") questionCallback = node.getText(source);
  ts.forEachChild(node, collect);
}
collect(source);
const javascript = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

describe("qualification diagnostic consumers", () => {
  it.each(["smoke", "full"])("retains the actual %s initial prompt evidence even when that prompt rejects", async profile => {
    expect(captures).toHaveLength(2);
    const tools = new NativeToolEvidence(), error = new Error("synthetic prompt rejection");
    const prompt = vi.fn(async () => {
      tools.observe({ sessionUpdate: "tool_call_update", toolCallId: "private-probe", status: "failed",
        nativeToolCallId: "private-native", rawInput: { server: "zeros-qualification", tool: "probe" } });
      throw error;
    });
    const context = { tools, captureNativeMcpTurn, bounded: (value: Promise<unknown>) => value, gateway: { prompt },
      provider: "codex", first: { sessionId: "private-session" },
      files: { challenge: "challenge", edited: "edited", executed: "executed" }, initialMcpToolEvidence: undefined };
    await expect(runInNewContext(javascript(captures[profile === "smoke" ? 0 : 1]), context, { timeout: 1000 })).rejects.toBe(error);
    expect(prompt).toHaveBeenCalledOnce();
    expect(context.initialMcpToolEvidence).toMatchObject({ events: 1, uniqueRows: 1, matched: { rows: 1, failed: 1, successful: 0 } });
    expect(JSON.stringify(context.initialMcpToolEvidence)).not.toContain("private");
  });

  it("counts an unrelated canonical question while preserving the failed latch and dismissed answer", () => {
    expect(questionCallback).not.toBe("");
    const questions = new NativeQuestionEvidence(), answerQuestion = vi.fn();
    const context = { questions, activity: { questions: 0 }, failed: false, gateway: { answerQuestion },
      nativeQualificationQuestion, provider: "codex", phase: "native-mcp-prompt", firstSessionId: "private-session", tools: new NativeToolEvidence() };
    const callbacks = runInNewContext(javascript(`({ ${questionCallback} })`), context, { timeout: 1000 });
    callbacks.onQuestionRequest("codex", "private-resolver", { source: "native_rpc", blocking: true, allowDecline: true,
      questionId: "private-question", questions: [{ prompt: "synthetic private prompt" }] });
    expect(questions.summary()).toMatchObject({ requests: 1, sources: { native_rpc: 1 }, blocking: { yes: 1 }, elicitation: { mcp: 1 } });
    expect(context.failed).toBe(true);
    expect(context.activity.questions).toBe(1);
    expect(answerQuestion).toHaveBeenCalledExactlyOnceWith("private-resolver", { outcome: { outcome: "dismissed" } });
    expect(JSON.stringify(questions.summary())).not.toContain("private");
  });
});
