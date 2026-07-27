// The shared per-target Changes filter: one live scope + turn selection that
// every mounted Changes surface (row-1 tab, row-2 view) reads together.
import { beforeEach, describe, expect, it } from "vitest";

const stubStore = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => (stubStore.has(key) ? stubStore.get(key)! : null),
  setItem: (key: string, value: string) =>
    void stubStore.set(key, String(value)),
  removeItem: (key: string) => void stubStore.delete(key),
  clear: () => stubStore.clear(),
};

import {
  clearChangesFilters,
  getChangesFilter,
  resetChangesFilterForTests,
  setChangesScope,
  setChangesTurnFilter,
} from "../changes-filter-store";
import { loadChangesScope } from "../changes-scope";
import { loadTurnFilterId } from "../changes-turn-filter";

beforeEach(() => {
  stubStore.clear();
  resetChangesFilterForTests();
});

describe("changes-filter-store", () => {
  it("seeds from the persisted scope/turn and defaults to All changes", () => {
    expect(getChangesFilter("wt-1")).toEqual({
      scope: { kind: "all" },
      turn: null,
    });

    resetChangesFilterForTests();
    setChangesScope("wt-1", { kind: "uncommitted" });
    resetChangesFilterForTests(); // simulate a reload — re-seed from persistence
    expect(getChangesFilter("wt-1").scope).toEqual({ kind: "uncommitted" });
  });

  it("keeps targets isolated and returns a stable snapshot until a set", () => {
    const a1 = getChangesFilter("wt-a");
    expect(getChangesFilter("wt-a")).toBe(a1);
    setChangesScope("wt-b", { kind: "uncommitted" });
    expect(getChangesFilter("wt-a")).toBe(a1); // untouched target keeps identity
    expect(getChangesFilter("wt-b").scope).toEqual({ kind: "uncommitted" });
  });

  it("clears the turn filter when a scope is picked (mutually exclusive)", () => {
    setChangesTurnFilter("wt-1", { chatId: "c1", turnId: "t1" });
    expect(getChangesFilter("wt-1").turn).toEqual({
      chatId: "c1",
      turnId: "t1",
    });
    expect(loadTurnFilterId("wt-1")).toEqual({ chatId: "c1", turnId: "t1" });

    setChangesScope("wt-1", { kind: "all" });
    expect(getChangesFilter("wt-1").turn).toBeNull();
    expect(loadTurnFilterId("wt-1")).toBeNull();
    expect(loadChangesScope("wt-1")).toEqual({ kind: "all" });
  });

  it("no-ops on equal sets (no snapshot churn)", () => {
    setChangesScope("wt-1", { kind: "commit", sha: "abc", message: "m" });
    const snap = getChangesFilter("wt-1");
    setChangesScope("wt-1", { kind: "commit", sha: "abc", message: "m2" });
    expect(getChangesFilter("wt-1")).toBe(snap);

    setChangesTurnFilter("wt-1", { chatId: "c1", turnId: "t1" });
    const withTurn = getChangesFilter("wt-1");
    setChangesTurnFilter("wt-1", { chatId: "c1", turnId: "t1" });
    expect(getChangesFilter("wt-1")).toBe(withTurn);
    setChangesTurnFilter("wt-1", null);
    setChangesTurnFilter("wt-1", null);
    expect(getChangesFilter("wt-1").turn).toBeNull();
  });

  it("drops live and persisted choices when their repository owner is removed", () => {
    setChangesScope("wt-1", { kind: "uncommitted" });
    setChangesTurnFilter("wt-2", { chatId: "c2", turnId: "t2" });
    const untouched = getChangesFilter("wt-kept");

    clearChangesFilters(["wt-1", "wt-2", "wt-2"]);

    expect(loadChangesScope("wt-1")).toBeNull();
    expect(loadTurnFilterId("wt-2")).toBeNull();
    expect(getChangesFilter("wt-1")).toEqual({
      scope: { kind: "all" },
      turn: null,
    });
    expect(getChangesFilter("wt-2")).toEqual({
      scope: { kind: "all" },
      turn: null,
    });
    expect(getChangesFilter("wt-kept")).toBe(untouched);
  });

  it("bounds persisted turn selections to the newest 128 targets", () => {
    for (let index = 0; index < 140; index += 1) {
      setChangesTurnFilter(`wt-${index}`, {
        chatId: `chat-${index}`,
        turnId: `turn-${index}`,
      });
    }
    const persisted = JSON.parse(
      stubStore.get("zeros:changes-turn-filter:v1") ?? "{}",
    ) as Record<string, unknown>;
    expect(Object.keys(persisted)).toHaveLength(128);
    expect(persisted["wt-0"]).toBeUndefined();
    expect(loadTurnFilterId("wt-139")).toEqual({
      chatId: "chat-139",
      turnId: "turn-139",
    });
  });
});
