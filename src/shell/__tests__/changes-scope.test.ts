// Per-workspace Changes-tab scope persistence — the choice (All changes /
// Uncommitted / a commit) must survive a source-tab switch, a workspace switch,
// and a reload, so it lives in localStorage keyed by git target. First visit →
// the "All changes" default; a corrupt / legacy blob must degrade to that
// default, never throw.
import { describe, it, expect, beforeEach } from "vitest";

import {
  DEFAULT_SCOPE,
  loadChangesScope,
  saveChangesScope,
  type Scope,
} from "../column3-tabs/changes-scope";

const KEY = "zeros:changes-scope:v1";

// The node test env has no DOM — install a tiny Map-backed localStorage before
// each test (the module reads/writes localStorage directly).
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
});

describe("changes-scope persistence", () => {
  it("defaults to All changes", () => {
    expect(DEFAULT_SCOPE).toEqual({ kind: "all" });
  });

  it("returns null for a target with no saved scope (→ caller defaults)", () => {
    expect(loadChangesScope("/wt-a")).toBeNull();
  });

  it("round-trips each scope kind", () => {
    saveChangesScope("/wt-a", { kind: "uncommitted" });
    expect(loadChangesScope("/wt-a")).toEqual({ kind: "uncommitted" });

    saveChangesScope("/wt-a", { kind: "staged" });
    expect(loadChangesScope("/wt-a")).toEqual({ kind: "staged" });

    saveChangesScope("/wt-a", { kind: "unstaged" });
    expect(loadChangesScope("/wt-a")).toEqual({ kind: "unstaged" });

    const commit: Scope = {
      kind: "commit",
      sha: "abc123",
      message: "fix: thing",
    };
    saveChangesScope("/wt-a", commit);
    expect(loadChangesScope("/wt-a")).toEqual(commit);

    saveChangesScope("/wt-a", { kind: "all" });
    expect(loadChangesScope("/wt-a")).toEqual({ kind: "all" });
  });

  it("keeps each target's scope independent", () => {
    saveChangesScope("/wt-a", { kind: "uncommitted" });
    saveChangesScope("/wt-b", {
      kind: "commit",
      sha: "deadbeef",
      message: "x",
    });
    expect(loadChangesScope("/wt-a")).toEqual({ kind: "uncommitted" });
    expect(loadChangesScope("/wt-b")).toEqual({
      kind: "commit",
      sha: "deadbeef",
      message: "x",
    });
  });

  it("bounds old workspace selections while retaining the newest 128", () => {
    for (let index = 0; index < 140; index += 1) {
      saveChangesScope(`/wt-${index}`, { kind: "uncommitted" });
    }
    const persisted = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(Object.keys(persisted)).toHaveLength(128);
    expect(persisted["/wt-0"]).toBeUndefined();
    expect(loadChangesScope("/wt-139")).toEqual({ kind: "uncommitted" });
  });

  it("ignores an empty target (no read, no write)", () => {
    saveChangesScope("", { kind: "uncommitted" });
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(loadChangesScope("")).toBeNull();
  });

  it("drops a commit scope missing its sha", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ "/wt-a": { kind: "commit", message: "no sha" } }),
    );
    expect(loadChangesScope("/wt-a")).toBeNull();
  });

  it("defaults message to '' when a persisted commit scope omits it", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ "/wt-a": { kind: "commit", sha: "abc" } }),
    );
    expect(loadChangesScope("/wt-a")).toEqual({
      kind: "commit",
      sha: "abc",
      message: "",
    });
  });

  it("drops an unknown scope kind", () => {
    localStorage.setItem(KEY, JSON.stringify({ "/wt-a": { kind: "bogus" } }));
    expect(loadChangesScope("/wt-a")).toBeNull();
  });

  it("survives a completely corrupt blob", () => {
    localStorage.setItem(KEY, "}{not json");
    expect(() => loadChangesScope("/wt-a")).not.toThrow();
    expect(loadChangesScope("/wt-a")).toBeNull();
  });

  it("falls back to an empty map when the blob is an array, not an object", () => {
    localStorage.setItem(KEY, JSON.stringify([{ kind: "all" }]));
    expect(loadChangesScope("/wt-a")).toBeNull();
  });
});
