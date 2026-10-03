import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@zeros/protocol/agent-events";
import { CloudCustomizationRedactor } from "../../apps/desktop/src/engine/agents/cloud-customization-redaction";
import { CodexAppServerTranslator } from "../../apps/desktop/src/engine/agents/adapters/codex/app-server-translator";
import { NativeToolEvidence } from "../cloud-workspace-validation/lib/native-tool-evidence";
import { qualificationPhrase, rawSecretObserver } from "../cloud-workspace-validation/lib/native-qualification-steps";

// Execute the qualification entrypoint's actual two notification consumers,
// without importing its credential-consuming main or starting a provider.
const source = ts.createSourceFile("qualify-cloud-agent.ts", readFileSync(new URL(
  "../cloud-workspace-validation/sandbox/qualify-cloud-agent.ts", import.meta.url,
), "utf8"), ts.ScriptTarget.Latest, true);
const observers: { raw?: string; published?: string } = {};
function collect(node: ts.Node): void {
  if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) &&
      node.expression.left.getText(source) === "redactor.notification") observers.raw = node.getText(source);
  if (ts.isMethodDeclaration(node) && node.name.getText(source) === "onSessionUpdate") observers.published = node.getText(source);
  ts.forEachChild(node, collect);
}
collect(source);
assert(observers.raw && observers.published, "qualification notification consumers must remain covered");
const consumers = ts.transpileModule(`({
  install(redactor) { const redact = redactor.notification.bind(redactor); ${observers.raw} },
  ${observers.published}
})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(firstWord: string) {
  // Every fixture comes from the real phrase generator's supported input.
  const phrases = Array.from({ length: 64 }, (_, index) => qualificationPhrase(() => Buffer.from([index, 0, 0, 0, 0, 0, 0, 0])));
  const secret = phrases.find(phrase => phrase.startsWith(`${firstWord}-`));
  assert(secret);
  const tools = new NativeToolEvidence(), observe = vi.spyOn(tools, "observe");
  const activity = { permissions: 0, rejectedPermissions: 0, questions: 0, messageChunks: 0, toolEvents: 0 };
  const context = { assert, tools, activity, historicalSecret: rawSecretObserver(secret), rawHistoricalSecretObservations: 0,
    mcpSecret: secret, rotatedMcpSecret: "willow-anchor-apple-arbor-aspen-atlas-0", reply: "", qualificationProfile: "full" };
  const callbacks = runInNewContext(consumers, context, { timeout: 1000 }) as {
    install(redactor: CloudCustomizationRedactor): void;
    onSessionUpdate(agent: string, notification: SessionNotification): void;
  };
  const redactor = new CloudCustomizationRedactor([secret]);
  callbacks.install(redactor);
  const published: SessionNotification[] = [];
  const deliver = (notification: SessionNotification) => {
    // AgentGateway publishes exactly this post-redaction notification.
    const safe = redactor.notification(notification);
    published.push(safe);
    callbacks.onSessionUpdate("codex", safe);
  };
  const translator = new CodexAppServerTranslator({ sessionId: "qualification", emit: deliver });
  return { tools, observe, activity, context, published, deliver, translator, secret };
}

describe("qualification evidence before public redaction", () => {
  it.each(["ember", "nectar", "willow"])("accepts a successful native probe with a legal %s phrase", firstWord => {
    const f = fixture(firstWord);
    const item = { type: "mcpToolCall", id: "native-probe", server: "zeros-qualification", tool: "probe", arguments: {} };
    f.translator.handle("item/started", { item: { ...item, status: "inProgress", result: null, error: null } });
    f.translator.handle("item/completed", { item: { ...item, status: "completed", error: null,
      result: { content: [{ type: "text", text: `MCP_MARKER\n${f.secret}` }] } } });
    expect(() => f.tools.assertMcp("zeros-qualification", "probe")).not.toThrow();
    expect(f.observe).toHaveBeenCalledTimes(2);
    expect(f.activity.toolEvents).toBe(2);
    expect(f.context.rawHistoricalSecretObservations).toBe(1);
    expect(JSON.stringify(f.published)).not.toContain(f.secret.slice(0, -1));
    if (firstWord !== "willow") {
      const scrubbed = new NativeToolEvidence();
      for (const notification of f.published) scrubbed.observe(notification.update);
      expect(() => scrubbed.assertMcp("zeros-qualification", "probe")).toThrow();
    }
  });

  it.each([
    { status: "failed" as const, nativeToolCallId: "native-probe" },
    { status: "in_progress" as const, nativeToolCallId: "native-probe" },
    { status: "completed" as const, nativeToolCallId: "" },
  ])("still rejects failed, pending or missing-native-ID evidence: %j", fields => {
    const f = fixture("ember");
    f.deliver({ sessionId: "qualification", update: { sessionUpdate: "tool_call", toolCallId: "probe", kind: "mcp",
      title: "zeros-qualification:probe", rawInput: { server: "zeros-qualification", tool: "probe", arguments: {} }, ...fields } });
    expect(() => f.tools.assertMcp("zeros-qualification", "probe")).toThrow("Qualification lacks a successful native MCP tool call");
    expect(f.observe).toHaveBeenCalledTimes(1);
    expect(f.activity.toolEvents).toBe(1);
  });

  it("keeps evidence attached to the current turn accumulator", () => {
    const f = fixture("willow"), next = new NativeToolEvidence();
    f.context.tools = next;
    f.deliver({ sessionId: "qualification", update: { sessionUpdate: "tool_call", toolCallId: "probe", nativeToolCallId: "native-probe",
      kind: "mcp", title: "zeros-qualification:probe", status: "completed", rawInput: { server: "zeros-qualification", tool: "probe", arguments: {} } } });
    expect(() => next.assertMcp("zeros-qualification", "probe")).not.toThrow();
    expect(() => f.tools.assertMcp("zeros-qualification", "probe")).toThrow();
  });
});
