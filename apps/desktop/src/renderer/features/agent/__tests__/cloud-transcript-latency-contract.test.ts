import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";
import { BLANK } from "../sessions-store";
import * as retention from "../transcript-retention";
import { cloudScopedId, isCloudWorkspace, parseCloudScopedId } from "../../../platform/bridge/cloud-workspace-key";
const source = readFileSync(new URL("../agent-chat.tsx", import.meta.url), "utf8");
it("measures visible archived history without requiring an interactive composer", () => {
  expect(source).toMatch(/useCloudTranscriptLatency\([^;]+chatId, surfaceActive,/s);
});
it("measures an eligible cached paint without promoting loading authority or treating missing/queued rows as history", () => {
  const ast = ts.createSourceFile("agent-chat.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let selector = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "transcriptPaintReady" && node.initializer && ts.isCallExpression(node.initializer))
      selector = node.initializer.arguments[0]!.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const context: Record<string, unknown> = { chatId: "cloud-chat", ...retention };
  vm.runInNewContext(ts.transpileModule(`globalThis.select = ${selector}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const select = context.select as (state: { sessions: Record<string, unknown> }) => boolean;
  const cached = { ...BLANK, transcriptState: "loading", transcriptPresentation: { source: "cache" },
    messages: [{ id: "m", kind: "text", role: "agent", text: "cached reply", createdAt: 1 }] };
  expect(select({ sessions: { "cloud-chat": cached } })).toBe(true);
  expect(cached.transcriptState).toBe("loading");
  expect(select({ sessions: {} })).toBe(false);
  expect(select({ sessions: { "cloud-chat": { ...BLANK, transcriptState: "loading", messages: [] } } })).toBe(false);
  expect(select({ sessions: { "cloud-chat": { ...BLANK, transcriptState: "loading", messages: [{ kind: "text", queued: true }] } } })).toBe(false);
  expect(source).toMatch(/useCloudTranscriptLatency\([^;]+transcriptPaintReady, hasSessionMessages\)/s);
});
it("does not promote cloud intent peers by reading files from a hidden prepared transcript", () => {
  const start = source.indexOf("const cwd = chatFileOpenCwd");
  const effect = source.slice(start, source.indexOf("const updateChatSettings", start));
  expect(effect).toContain("surfaceActive || !isCloudWorkspace(cwd)");
});
it("gates cached row actions by the cloud chat identity even before folder metadata is present", () => {
  const expression = source.match(/const provisionalTranscript = ([\s\S]*?);/)![1];
  const chatId = cloudScopedId({ organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" }, "chat");
  const context: Record<string, unknown> = { chatId, chatThread: undefined, isCloudWorkspace, parseCloudScopedId,
    session: { ...BLANK, transcriptState: "loading", transcriptPresentation: { source: "cache" } } };
  const code = ts.transpileModule(`globalThis.provisional = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, context);
  expect(context.provisional).toBe(true);
  for (const folder of ["/personal/local", "/organization/local"]) {
    context.chatId = "local-chat"; context.chatThread = { folder }; context.session = { ...BLANK, cwd: folder };
    vm.runInNewContext(code, context); expect(context.provisional).toBe(false);
  }
});
