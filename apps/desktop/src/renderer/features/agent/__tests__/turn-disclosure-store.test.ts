import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import { createTurnDisclosureStore } from "../turn-disclosure-store";

const tool = (id: string): AgentToolMessage => ({
  id, toolCallId: `call-${id}`, kind: "tool", toolKind: "subagent",
  title: "Agent", status: "completed", createdAt: 1, updatedAt: 2,
});

describe("mounted turn disclosures", () => {
  it("retains nested choices through regrouping and prunes removed subtrees", () => {
    const store = createTurnDisclosureStore();
    const root = tool("root");
    const child = tool("child");
    const nested = tool("nested");
    const otherTurn = tool("other-turn");
    const children = new Map<string, AgentMessage[]>([
      [root.toolCallId, [child]],
      [child.toolCallId, [nested]],
      [otherTurn.toolCallId, [tool("unrelated")]],
    ]);
    store.set(root.id, "agent", true);
    store.set(child.id, "prompt", false);
    store.set(nested.id, "details", true);
    store.set("unrelated", "details", true);
    const report: AgentMessage = {
      id: "report", kind: "text", role: "agent", createdAt: 1,
      text: "Confirmed report", phase: "partial_answer",
    };
    store.retain([report, { ...root, updatedAt: 3 }], children);
    expect(store.get(root.id, "agent")).toBe(true);
    expect(store.get(child.id, "prompt")).toBe(false);
    expect(store.get(nested.id, "details")).toBe(true);
    expect(store.get("unrelated", "details")).toBeUndefined();

    // The shared child index may still contain rows from other turns or a
    // removed parent. Only descendants reachable from this turn stay resident.
    store.retain([report], children);
    for (const id of [root.id, child.id, nested.id]) {
      for (const slot of ["agent", "prompt", "details"]) {
        expect(store.get(id, slot)).toBeUndefined();
      }
    }
    store.retain([root], children);
    expect(store.get(nested.id, "details")).toBeUndefined();
  });

  it("bounds retained choices to the current message tree across replacements", () => {
    const store = createTurnDisclosureStore();
    const children = new Map<string, AgentMessage[]>();
    for (let index = 0; index < 100; index++) {
      const current = tool(`row-${index}`);
      store.set(current.id, "details", true);
      store.retain([current], children);
      expect(store.get(current.id, "details")).toBe(true);
      if (index > 0) expect(store.get(`row-${index - 1}`, "details")).toBeUndefined();
    }
    store.retain([], children);
    expect(store.get("row-99", "details")).toBeUndefined();
  });

  it("isolates row notifications and keeps independent facets of a tool", () => {
    const store = createTurnDisclosureStore();
    const changed = vi.fn();
    const unrelated = vi.fn();
    const unsubscribe = store.subscribe("edit", changed);
    store.subscribe("other", unrelated);
    store.set("edit", "file-a", true);
    store.set("edit", "file-b", false);
    store.set("edit", "file-b", false);
    expect(store.get("edit", "file-a")).toBe(true);
    expect(store.get("edit", "file-b")).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(unrelated).not.toHaveBeenCalled();
    unsubscribe();
    store.set("edit", "file-a", false);
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
