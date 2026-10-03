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

const emptyMcpSummary = () => ({ version: 1, events: 0, overflowed: false, uniqueRows: 0,
  matched: { rows: 0, completed: 0, failed: 0, pending: 0, unknownStatus: 0, nativeId: 0, missingNativeId: 0, successful: 0 } });
const exactProbe = { server: "zeros-qualification", tool: "probe" };

describe("bounded exact canary MCP diagnostics", () => {
  it("distinguishes no notifications, other tools and ignored malformed row identities", () => {
    const evidence = new NativeToolEvidence();
    expect(evidence.canaryMcpSummary()).toEqual(emptyMcpSummary());
    evidence.observe({ sessionUpdate: "agent_message_chunk", content: { text: "synthetic private prose" } });
    evidence.observe({ sessionUpdate: "tool_call", toolCallId: "other", nativeToolCallId: "native-other", status: "completed",
      rawInput: { server: "other-server", tool: "probe" } });
    evidence.observe({ sessionUpdate: "tool_call_update", toolCallId: "other", status: "completed" });
    for (const toolCallId of [undefined, "", "x".repeat(513), { private: "synthetic private identity" }])
      evidence.observe({ sessionUpdate: "tool_call", toolCallId, nativeToolCallId: "native-invalid", status: "completed", rawInput: exactProbe });
    expect(evidence.canaryMcpSummary()).toEqual({ ...emptyMcpSummary(), events: 6, uniqueRows: 1 });
    expect(() => evidence.assertMcp("zeros-qualification", "probe")).toThrow();
  });
  it.each([
    { rawInput: exactProbe, title: "zeros-qualification: probe" },
    { rawInput: { providerIdentifier: "zeros-qualification", toolName: "probe" } },
    { title: "mcp__zeros-qualification__probe" },
    { title: "zeros-qualification.probe" },
  ])("recognizes completion-only exact evidence without retaining its identity or payload", fields => {
    const evidence = new NativeToolEvidence();
    evidence.observe({ sessionUpdate: "tool_call_update", toolCallId: "canonical-private-id", nativeToolCallId: "native-private-id",
      status: "completed", rawOutput: "synthetic private output", ...fields });
    expect(evidence.canaryMcpSummary()).toEqual({ ...emptyMcpSummary(), events: 1, uniqueRows: 1,
      matched: { ...emptyMcpSummary().matched, rows: 1, completed: 1, nativeId: 1, successful: 1 } });
    expect(() => evidence.assertMcp("zeros-qualification", "probe")).not.toThrow();
    const serialized = JSON.stringify(evidence.canaryMcpSummary());
    for (const privateValue of ["private", "zeros-qualification", "probe", "rawInput", "rawOutput", "title"]) expect(serialized).not.toContain(privateValue);
  });
  it("merges defined update fields into unique rows and leaves frozen snapshots independent", () => {
    const evidence = new NativeToolEvidence();
    evidence.observe({ sessionUpdate: "tool_call", toolCallId: "probe", status: "in_progress", rawInput: exactProbe });
    const pending = evidence.canaryMcpSummary();
    expect(pending.matched).toEqual({ ...emptyMcpSummary().matched, rows: 1, pending: 1, missingNativeId: 1 });
    evidence.observe({ sessionUpdate: "tool_call_update", toolCallId: "probe", nativeToolCallId: "native-probe", status: "completed", rawInput: null });
    evidence.observe({ sessionUpdate: "tool_call_update", toolCallId: "probe", nativeToolCallId: undefined, status: "completed" });
    expect(evidence.canaryMcpSummary()).toEqual({ ...emptyMcpSummary(), events: 3, uniqueRows: 1,
      matched: { ...emptyMcpSummary().matched, rows: 1, completed: 1, nativeId: 1, successful: 1 } });
    expect(pending.matched.successful).toBe(0);
    expect(pending.matched.pending).toBe(1);
    evidence.observe({ sessionUpdate: "tool_call_update", toolCallId: "probe", status: "failed" });
    expect(evidence.canaryMcpSummary().matched).toEqual({ ...emptyMcpSummary().matched, rows: 1, failed: 1, nativeId: 1 });
    expect(() => evidence.assertMcp("zeros-qualification", "probe")).toThrow();
  });
  it("separates failed, pending, unknown-status and completed-without-native-id exact rows", () => {
    const evidence = new NativeToolEvidence();
    for (const [index, status] of ["failed", "pending", "in_progress", undefined, "private-status", "completed"].entries())
      evidence.observe({ sessionUpdate: "tool_call_update", toolCallId: `row-${index}`, status,
        nativeToolCallId: index < 5 ? `native-${index}` : "", rawInput: exactProbe });
    evidence.observe({ sessionUpdate: "tool_call_update", toolCallId: "malformed-native-id", status: "completed",
      nativeToolCallId: { private: "synthetic private identity" }, rawInput: exactProbe });
    expect(evidence.canaryMcpSummary()).toEqual({ ...emptyMcpSummary(), events: 7, uniqueRows: 7,
      matched: { rows: 7, completed: 2, failed: 1, pending: 2, unknownStatus: 2, nativeId: 5, missingNativeId: 2, successful: 0 } });
    expect(() => evidence.assertMcp("zeros-qualification", "probe")).toThrow();
  });
  it("uses the original exact predicate and whole-field composition for malformed or nonmatching input", () => {
    const evidence = new NativeToolEvidence();
    for (const [index, fields] of [
      { rawInput: { server: "zeros-qualification", tool: "probe-extra" } },
      { rawInput: { server: "zeros-qualification-extra", tool: "probe" } },
      { title: "zeros-qualification: probe" },
      { title: "mcp__zeros-qualification__probe-extra" },
      { rawInput: [exactProbe] },
      { rawInput: { private: { ...exactProbe, output: "synthetic private text" } } },
    ].entries()) evidence.observe({ sessionUpdate: "tool_call", toolCallId: `other-${index}`,
      nativeToolCallId: "native-other", status: "completed", ...fields });
    evidence.observe({ sessionUpdate: "tool_call", toolCallId: "replaced", nativeToolCallId: "native-replaced", status: "completed", rawInput: exactProbe });
    evidence.observe({ sessionUpdate: "tool_call_update", toolCallId: "replaced", rawInput: { tool: "probe" } });
    expect(evidence.canaryMcpSummary()).toEqual({ ...emptyMcpSummary(), events: 8, uniqueRows: 7 });
    expect(() => evidence.assertMcp("zeros-qualification", "probe")).toThrow();
  });
  it("bounds the diagnostic after the existing event-limit rejection without changing that rejection", () => {
    const evidence = new NativeToolEvidence();
    for (let index = 0; index < 2048; index++) evidence.observe({ sessionUpdate: "tool_call_update", toolCallId: `bounded-${index}`,
      nativeToolCallId: "native-bounded", status: "failed", rawInput: exactProbe });
    expect(() => evidence.observe({ sessionUpdate: "tool_call_update", toolCallId: "overflow", rawInput: exactProbe })).toThrow("exceeded its bound");
    expect(evidence.canaryMcpSummary()).toEqual({ version: 1, events: 2048, overflowed: true, uniqueRows: 2048,
      matched: { rows: 2048, completed: 0, failed: 2048, pending: 0, unknownStatus: 0, nativeId: 2048, missingNativeId: 0, successful: 0 } });
    expect(() => evidence.assertMcp("zeros-qualification", "probe")).toThrow();
  });
});
