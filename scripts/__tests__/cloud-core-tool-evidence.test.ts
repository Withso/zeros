import { describe, expect, it } from "vitest";
import { CursorSdkTranslator } from "../../apps/desktop/src/engine/agents/adapters/cursor-sdk/translator";
import { CoreToolEvidence } from "../cloud-workspace-validation/lib/core-tool-evidence";
const files = { challenge: "core.challenge", edited: "core.edited", executed: "core.executed" }, marker = "unique-marker";
const requests = [
  { operation: "read", path: files.challenge },
  { operation: "write", path: files.edited, content: marker, expectedSha256: null },
  { operation: "exec", command: `cat '${files.challenge}' > '${files.executed}'` },
];
const result = (ok = true, code = 0) => JSON.stringify({ ok, data: { state: "exited", exit: { code, signal: null }, timedOut: false } });
function cursorEvidence(options: { wrongServer?: boolean; wrongTool?: boolean; failedCallback?: boolean; commandExit?: number; noCompletion?: boolean } = {}) {
  const evidence = new CoreToolEvidence();
  const translator = new CursorSdkTranslator({ sessionId: "execution", emit: event => evidence.observe(event.update) });
  for (const request of requests) {
    const args = { providerIdentifier: options.wrongServer ? "untrusted-server" : "custom-user-tools", toolName: options.wrongTool ? "other" : "workspace", args: { request } };
    translator.feed({ type: "tool_call", call_id: request.operation, name: "mcp", args, status: "running" });
    if (!options.noCompletion) translator.feed({ type: "tool_call", call_id: request.operation, name: "mcp", args, status: "completed",
      result: { status: "success", value: { content: [{ text: { text: result(!options.failedCallback, options.commandExit) } }], isError: false } } });
  }
  return evidence;
}
describe("correlated native workspace tool qualification evidence", () => {
  it("accepts the pinned Cursor SDK's actual custom-tools MCP projection through the real translator", () => {
    expect(() => cursorEvidence().assertEffects("cursor", files, marker)).not.toThrow();
  });
  it.each([{ wrongServer: true }, { wrongTool: true }, { failedCallback: true }, { commandExit: 1 }, { noCompletion: true }])("fails closed on unproven Cursor callbacks: %j", options => {
    expect(() => cursorEvidence(options).assertEffects("cursor", files, marker)).toThrow(/tool callback/);
  });
  it.each(["claude", "codex"])("accepts %s native callback inputs joined to completion by row identity", provider => {
    const evidence = new CoreToolEvidence();
    for (const request of requests) {
      evidence.observe({ sessionUpdate: "tool_call", toolCallId: request.operation,
        title: provider === "claude" ? "mcp__zeros_workspace__workspace" : "zeros_workspace",
        rawInput: provider === "claude" ? { request } : { namespace: null, tool: "zeros_workspace", arguments: request }, status: "in_progress" });
      evidence.observe({ sessionUpdate: "tool_call_update", toolCallId: request.operation, status: "completed",
        rawOutput: [{ type: provider === "claude" ? "text" : "inputText", text: result() }] });
    }
    expect(() => evidence.assertEffects(provider, files, marker)).not.toThrow();
    expect(() => evidence.assertNoTools()).toThrow(/resume.*tool/i);
  });
  it("does not join successful completion of another call to the requested operation", () => {
    const evidence = new CoreToolEvidence();
    for (const request of requests) {
      evidence.observe({ sessionUpdate: "tool_call", toolCallId: request.operation, title: "mcp__zeros_workspace__workspace", rawInput: { request }, status: "in_progress" });
      evidence.observe({ sessionUpdate: "tool_call_update", toolCallId: `unrelated-${request.operation}`, status: "completed", rawOutput: [{ type: "text", text: result() }] });
    }
    expect(() => evidence.assertEffects("claude", files, marker)).toThrow(/tool callback/);
  });
});
