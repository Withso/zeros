import { describe, expect, it, vi } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import type { SessionNotification } from "../../../types";
import { CursorSdkTranslator } from "../translator";

function setup(manual = false) {
  const events: SessionNotification[] = [];
  const unknown = vi.fn();
  const mapper = new CursorSdkTranslator({ sessionId: "session", emit: event => events.push(event), onUnknown: unknown,
    compactionTrigger: manual ? "manual" : "auto" });
  mapper.bindRunIdentity("agent", "run");
  const stream = (status: string, extra = {}) => mapper.feed({ type: "summary", agent_id: "agent", run_id: "run", status, ...extra });
  const rows = () => events.reduce<AgentMessage[]>((rows, event) => applyUpdate(rows, event), []);
  return { mapper, events, unknown, stream, rows };
}

describe("Cursor native context compaction", () => {
  it.each([false, true])("streams one %s manual compaction row without ending the run", manual => {
    const f = setup(manual);
    f.stream("running");
    expect(f.rows()).toMatchObject([{ toolKind: "compaction", status: "in_progress", rawInput: { trigger: manual ? "manual" : "auto" } }]);
    const id = f.rows()[0].id;
    f.stream("completed");
    expect(f.rows()).toMatchObject([{ id, status: "completed", title: "Context compacted" }]);
    expect(f.mapper.sawTerminal).toBe(false);
    expect(f.unknown).not.toHaveBeenCalled();
  });

  it.each(["delta-first", "stream-first"])("reconciles $0 callback and stream mirrors without reopening settled rows", order => {
    const f = setup();
    const delta = () => { f.mapper.feedDelta({ type: "summary-started" }); f.mapper.feedDelta({ type: "summary-completed" }); };
    const stream = () => { f.stream("running"); f.stream("completed"); };
    if (order === "delta-first") { delta(); stream(); } else { stream(); delta(); }
    f.stream("completed"); f.mapper.feedDelta({ type: "summary-completed" });
    expect(f.rows()).toHaveLength(1);
    expect(f.events.map(event => event.update).filter(update => update.sessionUpdate === "tool_call")).toHaveLength(1);
    expect(f.events.map(event => event.update).filter(update => update.sessionUpdate === "tool_call_update")).toHaveLength(1);
  });

  it("keeps successive compactions distinct when stream mirrors lag callbacks", () => {
    const f = setup();
    f.mapper.feedDelta({ type: "summary-started" }); f.mapper.feedDelta({ type: "summary-completed" });
    f.mapper.feedDelta({ type: "summary-started" });
    f.stream("running"); f.stream("completed");
    expect(f.rows()).toMatchObject([{ status: "completed" }, { status: "in_progress" }]);
    f.mapper.feedDelta({ type: "summary-completed", fallback: true });
    f.stream("running"); f.stream("completed", { fallback: true });
    expect(f.rows()).toMatchObject([{ status: "completed" }, { status: "completed", rawOutput: { fallback: true } }]);
    expect(new Set(f.rows().map(row => row.id)).size).toBe(2);
  });

  it.each(["stream", "delta"])("retains completion-only and fallback detail from %s", source => {
    const f = setup();
    if (source === "stream") f.stream("completed", { fallback: true });
    else f.mapper.feedDelta({ type: "summary-completed", fallback: true });
    expect(f.rows()).toMatchObject([{ toolKind: "compaction", status: "completed", rawOutput: { fallback: true } }]);
    expect(JSON.stringify(f.rows())).toContain("trimmed transcript");
  });

  it.each(["stream", "delta"])("settles %s failure without declaring the surrounding run failed", source => {
    const f = setup();
    if (source === "stream") { f.stream("running"); f.stream("error"); }
    else { f.mapper.feedDelta({ type: "summary-started" }); f.mapper.feedDelta({ type: "summary-completed", failed: true }); }
    expect(f.rows()).toMatchObject([{ status: "failed", rawOutput: { error: expect.stringContaining("unchanged") } }]);
    expect(f.mapper.sawError).toBe(false);
    expect(f.mapper.sawTerminal).toBe(false);
  });

  it.each(["FINISHED", "CANCELLED", "ERROR", "EOF"])("does not infer a successful compaction from %s", async status => {
    const f = setup(); f.stream("running");
    if (status !== "EOF") f.mapper.feed({ type: "status", status });
    await f.mapper.flushSubagents();
    expect(f.rows()).toMatchObject([{ status: "failed", rawOutput: { error: expect.stringContaining("confirming") } }]);
    f.stream("completed");
    expect(f.rows()).toMatchObject([{ status: "failed" }]);
  });

  it("rejects foreign identities and hides the private summary text delta", () => {
    const f = setup();
    f.stream("running", { run_id: "old" });
    f.stream("completed", { agent_id: "other" });
    f.mapper.feedDelta({ type: "summary", summary: "PRIVATE_SUMMARY_CONTENT" });
    expect(f.events).toEqual([]);
  });

  it("does not settle a retired session during cleanup", async () => {
    const f = setup(); f.stream("running");
    const count = f.events.length;
    await f.mapper.flushSubagents({ ownsUpdates: () => false });
    expect(f.events).toHaveLength(count);
  });
});
