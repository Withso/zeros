import { describe, expect, it } from "vitest";
import { NativeToolEvidence, nativeChallengeCommand } from "../cloud-workspace-validation/lib/native-tool-evidence";

const files = { challenge: "fixture.challenge", edited: "fixture.edited", executed: "fixture.executed" };
const calls = [
  { kind: "read", rawInput: { file_path: files.challenge } },
  { kind: "edit", rawInput: { changes: [{ path: `/srv/zeros/workspace/${files.edited}`, diff: "+unique" }] } },
  { kind: "execute", rawInput: { command: `cat '${files.challenge}' > '${files.executed}'` } },
];
function observe(evidence: NativeToolEvidence, replacements: Record<string, unknown> = {}) {
  calls.forEach((call, index) => {
    const id = `call-${index}`;
    evidence.observe({ sessionUpdate: "tool_call", toolCallId: id, nativeToolCallId: `native-${id}`, status: "in_progress", ...call, ...replacements });
    evidence.observe({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", ...(replacements.status ? { status: replacements.status } : {}) });
  });
}
describe("native workspace qualification evidence", () => {
  it("requires the selected model's native child to finish, including a later completion event", () => {
    const evidence = new NativeToolEvidence();
    evidence.observe({sessionUpdate:"tool_call",toolCallId:"child",nativeToolCallId:"native-child",kind:"subagent",status:"in_progress",rawInput:{tool:"spawnAgent",model:"qualified-model"}});
    expect(() => evidence.assertMultiAgent("qualified-model")).toThrow();
    evidence.observe({sessionUpdate:"tool_call_update",toolCallId:"unrelated",status:"completed"});
    expect(() => evidence.assertMultiAgent("qualified-model")).toThrow();
    evidence.observe({sessionUpdate:"tool_call_update",toolCallId:"child",status:"completed"});
    expect(() => evidence.assertMultiAgent("qualified-model")).not.toThrow();
    expect(() => evidence.assertMultiAgent("another-model")).toThrow();
    evidence.observe({sessionUpdate:"tool_call_update",toolCallId:"child",status:"failed"});
    expect(() => evidence.assertMultiAgent("qualified-model")).toThrow();
  });
  it("requires a completed native MCP invocation rather than prose or a shell effect", () => {
    const evidence = new NativeToolEvidence();
    expect(() => evidence.assertMcp("zeros-qualification", "probe")).toThrow();
    evidence.observe({sessionUpdate:"tool_call",toolCallId:"mcp",nativeToolCallId:"native-mcp",title:"mcp__zeros-qualification__probe",status:"in_progress",rawInput:{}});
    expect(() => evidence.assertMcp("zeros-qualification", "probe")).toThrow();
    evidence.observe({sessionUpdate:"tool_call_update",toolCallId:"mcp",status:"completed"});
    expect(() => evidence.assertMcp("zeros-qualification", "probe")).not.toThrow();
    expect(() => evidence.assertMcp("different", "probe")).toThrow();
  });
  it("recognizes the native shell launcher without accepting extra commands or expansions", () => {
    const command = `cat '${files.challenge}' > '${files.executed}'`;
    expect(nativeChallengeCommand(`/bin/bash -lc "${command}"`, files)).toBe("exec");
    expect(nativeChallengeCommand(`/bin/bash -lc '${command.replaceAll("'", `'"'"'`)}'`, files)).toBe("exec");
    expect(nativeChallengeCommand(`/bin/bash -lc "${command}; env"`, files)).toBeNull();
    expect(nativeChallengeCommand(`/bin/bash -lc "${command}"; env`, files)).toBeNull();
    expect(nativeChallengeCommand(`/bin/bash -lc "${command}$(env)"`, files)).toBeNull();
  });
  it("correlates split native starts/completions and recognizes native file changes", () => {
    const evidence = new NativeToolEvidence(); observe(evidence);
    expect(() => evidence.assertEffects("codex", files, "unique")).not.toThrow();
    expect(() => evidence.assertNoTools()).toThrow();
  });
  it.each([{ kind: "mcp" }, { title: "mcp__zeros_workspace__workspace" }, { status: "failed" }, { nativeToolCallId: "" },
    { rawInput: { server: "arbitrary", command: `cat '${files.challenge}' > '${files.executed}'` } }])("rejects non-native or failed evidence: %j", replacement => {
    const evidence = new NativeToolEvidence(); observe(evidence, replacement);
    expect(() => evidence.assertEffects("claude", files, "unique")).toThrow();
  });
  it("never treats assistant prose or a different target as file/tool proof", () => {
    const evidence = new NativeToolEvidence();
    evidence.observe({ sessionUpdate: "agent_message_chunk", content: { text: "I used native tools" } });
    evidence.assertNoTools();
    expect(() => evidence.assertEffects("cursor", files, "unique")).toThrow();
    expect(nativeChallengeCommand(`cat '${files.challenge}' > '${files.executed}'; env`, files)).toBeNull();
    expect(nativeChallengeCommand(`cat '${files.challenge}' > '../${files.executed}'`, files)).toBeNull();
    expect(nativeChallengeCommand(`cat /srv/zeros/workspace/${files.challenge}`, files)).toBe("read");
  });
});
