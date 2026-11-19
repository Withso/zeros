import { describe, it, expect } from "vitest";
import { TerminalRegistry, type TerminalEntry } from "../registry";

const entry = (
  sessionId: string,
  workspaceId: string | null,
  createdAt = 0,
): TerminalEntry => ({
  sessionId,
  workspaceId,
  cwd: `/w/${sessionId}`,
  createdAt,
});

describe("TerminalRegistry", () => {
  it("add is idempotent on sessionId (a reattach doesn't duplicate)", () => {
    const r = new TerminalRegistry();
    expect(r.add(entry("a", "ws1"))).toBe(true);
    expect(r.add(entry("a", "ws1"))).toBe(false);
    expect(r.sessionIds()).toEqual(["a"]);
  });

  it("remove reports whether an entry existed", () => {
    const r = new TerminalRegistry();
    r.add(entry("a", "ws1"));
    expect(r.remove("a")).toBe(true);
    expect(r.remove("a")).toBe(false);
  });

  it("idsUnderFolder matches the exact cwd and nested cwds, never siblings", () => {
    const r = new TerminalRegistry();
    r.add({ sessionId: "root", workspaceId: "ws1", cwd: "/w/ws1", createdAt: 0 });
    r.add({
      sessionId: "nested",
      workspaceId: "ws1",
      cwd: "/w/ws1/packages/app",
      createdAt: 1,
    });
    r.add({
      sessionId: "sibling",
      workspaceId: "ws2",
      cwd: "/w/ws1-other",
      createdAt: 2,
    });
    expect(r.idsUnderFolder("/w/ws1").sort()).toEqual(["nested", "root"]);
    expect(r.idsUnderFolder("/w/none")).toEqual([]);
  });

  it("visibleTo: local sees everything; remote sees only known non-restricted", () => {
    const r = new TerminalRegistry();
    r.add(entry("a", "ws1", 1));
    r.add(entry("b", "ws2", 2));
    r.add(entry("c", null, 3));
    const restricted = new Set(["ws2"]);

    expect(
      r.visibleTo({ isRemote: false, restricted }).map((t) => t.sessionId),
    ).toEqual(["a", "b", "c"]);

    expect(
      r.visibleTo({ isRemote: true, restricted }).map((t) => t.sessionId),
    ).toEqual(["a"]);
  });

  it("visibleTo: scopes to a single workspaceId when given", () => {
    const r = new TerminalRegistry();
    r.add(entry("a", "ws1", 1));
    r.add(entry("b", "ws1", 2));
    r.add(entry("c", "ws2", 3));
    const restricted = new Set<string>();
    expect(
      r
        .visibleTo({ isRemote: false, restricted, workspaceId: "ws1" })
        .map((t) => t.sessionId),
    ).toEqual(["a", "b"]);
  });

  it("markExited / markAlive flip the exited flag and report whether it changed", () => {
    const r = new TerminalRegistry();
    r.add(entry("a", "ws1"));
    expect(r.markExited("a")).toBe(true);
    expect(r.get("a")?.exited).toBe(true);
    expect(r.markExited("a")).toBe(false);
    expect(r.has("a")).toBe(true);
    expect(r.markAlive("a")).toBe(true);
    expect(r.get("a")?.exited).toBe(false);
    expect(r.markAlive("a")).toBe(false);
    expect(r.markExited("missing")).toBe(false);
    expect(r.markAlive("missing")).toBe(false);
  });

  it("remoteMayOperate: fail-closed for unknown/unknown-workspace/restricted", () => {
    const r = new TerminalRegistry();
    r.add(entry("shared", "ws1"));
    r.add(entry("locked", "ws2"));
    r.add(entry("nows", null));
    const restricted = new Set(["ws2"]);

    expect(r.remoteMayOperate("shared", restricted)).toBe(true);
    expect(r.remoteMayOperate("locked", restricted)).toBe(false);
    expect(r.remoteMayOperate("nows", restricted)).toBe(false);
    expect(r.remoteMayOperate("missing", restricted)).toBe(false);
  });
});
