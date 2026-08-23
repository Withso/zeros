import { describe, it, expect, beforeEach } from "vitest";
import {
  clearTerminalFolders,
  useTerminalStore,
  selectSessionsForFolder,
  runSessionId,
  isRunSessionId,
  isSetupSessionId,
} from "../terminal-store";
import type { TerminalSession } from "../terminal-store";
import { useWorkspaceStore } from "../../../state/workspace-store";

// Covers the Phase-C multiplayer reconcile: the engine's SHARED terminal
// registry is folded into a folder's tab strip — ADD terminals another device
// created, REMOVE ones closed on another device, KEEP a not-yet-registered local
// one. (Node env — the store's localStorage persist is window-guarded + no-ops.)

const ids = (folder: string) =>
  selectSessionsForFolder(useTerminalStore.getState(), folder).map((s) => s.id);

describe("terminal-store workspace activity", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      sessions: [],
      activeTerminalTabByFolder: {},
    });
    useWorkspaceStore.setState({ workspaceActivityByFolder: {} });
  });

  it("records user-created or explicitly run terminals, not automatic seeding", () => {
    const terminal = useTerminalStore.getState();
    terminal.createSession("/auto-seed", null, undefined, undefined, false);
    expect(
      useWorkspaceStore.getState().workspaceActivityByFolder["/auto-seed"],
    ).toBeUndefined();

    terminal.createSession("/user-terminal", null);
    expect(
      useWorkspaceStore.getState().workspaceActivityByFolder["/user-terminal"],
    ).toEqual(expect.any(Number));

    terminal.createSession(
      "/run",
      null,
      "pnpm test",
      "pty-run-activity",
      false,
    );
    expect(
      useWorkspaceStore.getState().workspaceActivityByFolder["/run"],
    ).toBeUndefined();
    terminal.createSession("/run", null, "pnpm test", "pty-run-activity", true);
    expect(
      useWorkspaceStore.getState().workspaceActivityByFolder["/run"],
    ).toEqual(expect.any(Number));
  });
});

describe("terminal-store syncEngineTerminals", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      sessions: [],
      activeTerminalTabByFolder: {},
    });
  });

  it("adds engine terminals for the folder, ordered + renumbered", () => {
    useTerminalStore.getState().syncEngineTerminals(
      "/w",
      [
        { sessionId: "a", createdAt: 1 },
        { sessionId: "b", createdAt: 2 },
      ],
      ["a", "b"],
    );
    expect(ids("/w")).toEqual(["a", "b"]);
    const titles = selectSessionsForFolder(
      useTerminalStore.getState(),
      "/w",
    ).map((s) => s.title);
    expect(titles).toEqual(["Terminal 1", "Terminal 2"]);
  });

  it("titles a single terminal 'Terminal' (no number)", () => {
    useTerminalStore
      .getState()
      .syncEngineTerminals("/solo", [{ sessionId: "x", createdAt: 1 }], ["x"]);
    const titles = selectSessionsForFolder(
      useTerminalStore.getState(),
      "/solo",
    ).map((s) => s.title);
    expect(titles).toEqual(["Terminal"]);
  });

  it("is idempotent once steady — re-syncing keeps the SAME ref", () => {
    const s = useTerminalStore.getState();
    s.syncEngineTerminals("/w", [{ sessionId: "a", createdAt: 1 }], ["a"]);
    // First sync added + marked engineSeen. A second identical sync is a no-op.
    const before = useTerminalStore.getState().sessions;
    s.syncEngineTerminals("/w", [{ sessionId: "a", createdAt: 1 }], ["a"]);
    expect(useTerminalStore.getState().sessions).toBe(before);
  });

  it("REMOVES a confirmed terminal that vanished from the registry (closed elsewhere)", () => {
    const s = useTerminalStore.getState();
    s.syncEngineTerminals("/w", [{ sessionId: "a", createdAt: 1 }], ["a"]);
    expect(ids("/w")).toEqual(["a"]);
    // 'a' is gone from the engine → drop it.
    s.syncEngineTerminals("/w", [], []);
    expect(ids("/w")).toEqual([]);
  });

  it("does NOT remove a not-yet-registered local terminal (create in flight)", () => {
    const s = useTerminalStore.getState();
    const local = s.createSession("/w"); // local, never engineSeen
    // Engine reports zero terminals for the folder — the local one is in flight,
    // so it must be KEPT (not pruned).
    s.syncEngineTerminals("/w", [], []);
    expect(ids("/w")).toContain(local.id);
  });

  it("marks a local terminal engineSeen once it appears, then prunes it when it vanishes", () => {
    const s = useTerminalStore.getState();
    const local = s.createSession("/w");
    // It shows up in the registry → confirmed (engineSeen).
    s.syncEngineTerminals("/w", [], [local.id]);
    expect(ids("/w")).toContain(local.id);
    // Now it's gone from the registry → pruned.
    s.syncEngineTerminals("/w", [], []);
    expect(ids("/w")).not.toContain(local.id);
  });

  it("repoints the folder's active terminal when the active one is pruned", () => {
    const s = useTerminalStore.getState();
    s.syncEngineTerminals(
      "/w",
      [
        { sessionId: "a", createdAt: 1 },
        { sessionId: "b", createdAt: 2 },
      ],
      ["a", "b"],
    );
    s.setActiveTerminalTab("/w", "a");
    // 'a' closed elsewhere → terminal panel's active terminal tab repoints to a
    // surviving sibling.
    s.syncEngineTerminals("/w", [{ sessionId: "b", createdAt: 2 }], ["b"]);
    expect(useTerminalStore.getState().activeTerminalTabByFolder["/w"]).toBe(
      "b",
    );
  });

  it("mirrors the engine 'exited' flag (a natural exit shows '(exited)', NOT removed)", () => {
    const s = useTerminalStore.getState();
    s.syncEngineTerminals("/w", [{ sessionId: "a", createdAt: 1 }], ["a"]);
    expect(
      selectSessionsForFolder(useTerminalStore.getState(), "/w")[0]!.alive,
    ).toBe(true);
    // Engine reports it exited but KEEPS it in the registry → tab stays, marked
    // exited (this is the "(exited) — press key to restart" behaviour).
    s.syncEngineTerminals(
      "/w",
      [{ sessionId: "a", createdAt: 1, exited: true }],
      ["a"],
    );
    const after = selectSessionsForFolder(useTerminalStore.getState(), "/w");
    expect(after.map((x) => x.id)).toEqual(["a"]); // still present
    expect(after[0]!.alive).toBe(false); // shown exited
  });

  it("flips an exited terminal back to alive when restarted elsewhere", () => {
    const s = useTerminalStore.getState();
    s.syncEngineTerminals(
      "/w",
      [{ sessionId: "a", createdAt: 1, exited: true }],
      ["a"],
    );
    expect(
      selectSessionsForFolder(useTerminalStore.getState(), "/w")[0]!.alive,
    ).toBe(false);
    s.syncEngineTerminals(
      "/w",
      [{ sessionId: "a", createdAt: 1, exited: false }],
      ["a"],
    );
    expect(
      selectSessionsForFolder(useTerminalStore.getState(), "/w")[0]!.alive,
    ).toBe(true);
  });

  it("scopes terminals to their folder", () => {
    const s = useTerminalStore.getState();
    s.syncEngineTerminals(
      "/w1",
      [{ sessionId: "a", createdAt: 1 }],
      ["a", "b"],
    );
    s.syncEngineTerminals(
      "/w2",
      [{ sessionId: "b", createdAt: 1 }],
      ["a", "b"],
    );
    expect(ids("/w1")).toEqual(["a"]);
    expect(ids("/w2")).toEqual(["b"]);
  });

  it("bounds stale per-folder selections while retaining the newest", () => {
    const store = useTerminalStore.getState();
    for (let index = 0; index < 140; index += 1) {
      store.setActiveTerminalTab(`/w/${index}`, `terminal-${index}`);
    }
    const selected = useTerminalStore.getState().activeTerminalTabByFolder;
    expect(Object.keys(selected)).toHaveLength(128);
    expect(selected["/w/0"]).toBeUndefined();
    expect(selected["/w/139"]).toBe("terminal-139");
  });

  it("drops sessions and selected tabs with an explicitly deleted owner", () => {
    useTerminalStore.setState({
      sessions: [
        {
          id: "removed",
          folder: "/removed/packages/app",
          title: "Removed",
          createdAt: 1,
          alive: false,
          agentId: null,
        },
        {
          id: "kept",
          folder: "/removed-sibling",
          title: "Kept",
          createdAt: 2,
          alive: false,
          agentId: null,
        },
      ],
      activeTerminalTabByFolder: {
        "/removed/packages/app": "removed",
        "/removed-sibling": "kept",
      },
    });

    clearTerminalFolders(["/removed", "/removed"]);

    expect(ids("/removed/packages/app")).toEqual([]);
    expect(ids("/removed-sibling")).toEqual(["kept"]);
    expect(useTerminalStore.getState().activeTerminalTabByFolder).toEqual({
      "/removed-sibling": "kept",
    });
  });
});

// ── Run terminals ────────────────────────────────────────
describe("terminal-store createSession — run terminals", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      sessions: [],
      activeTerminalTabByFolder: {},
    });
  });

  it("stores initialCommand, titles it 'Run', and skips it in plain numbering", () => {
    const s = useTerminalStore.getState();
    s.createSession("/w"); // plain "Terminal"
    const run = s.createSession("/w", null, "pnpm dev", "pty-run-w");
    expect(run.initialCommand).toBe("pnpm dev");
    expect(run.title).toBe("Run");
    // The plain terminal stays "Terminal" (a run terminal doesn't bump it to "1").
    const plain = selectSessionsForFolder(
      useTerminalStore.getState(),
      "/w",
    ).find((x) => !x.initialCommand);
    expect(plain!.title).toBe("Terminal");
  });

  it("reuses (focuses) an existing session for a repeat explicit id — no duplicate", () => {
    const s = useTerminalStore.getState();
    const first = s.createSession("/w", null, "pnpm dev", "pty-run-w");
    const again = s.createSession("/w", null, "pnpm dev", "pty-run-w");
    expect(again.id).toBe(first.id);
    expect(ids("/w")).toEqual(["pty-run-w"]); // exactly one
    // Reuse focuses the run terminal's Terminal-tab sub-tab.
    expect(useTerminalStore.getState().activeTerminalTabByFolder["/w"]).toBe(
      "pty-run-w",
    );
  });

  it("closeSession keeps the last terminal; forceCloseSession drops it (run restart)", () => {
    const s = useTerminalStore.getState();
    s.createSession("/w", null, "pnpm dev", "pty-run-w");
    // The single (run) terminal survives a normal close...
    s.closeSession("pty-run-w");
    expect(ids("/w")).toEqual(["pty-run-w"]);
    // ...but force-close removes it so a fresh Run can re-mount + re-fire.
    s.forceCloseSession("pty-run-w");
    expect(ids("/w")).toEqual([]);
  });
});

// ── Run-terminal identity (right-side Run tab / dropdown exclusion) ──
describe("terminal-store run-terminal identity", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      sessions: [],
      activeTerminalTabByFolder: {},
    });
  });

  const titlesOf = (folder: string) =>
    selectSessionsForFolder(useTerminalStore.getState(), folder).map(
      (x) => x.title,
    );

  it("runSessionId is deterministic + marked by isRunSessionId; minted ids are not", () => {
    expect(runSessionId("/w")).toBe(runSessionId("/w")); // deterministic
    expect(runSessionId("/w")).not.toBe(runSessionId("/other"));
    expect(isRunSessionId(runSessionId("/w"))).toBe(true);
    // A normal (minted) terminal id is NOT a run id.
    const plain = useTerminalStore.getState().createSession("/w");
    expect(isRunSessionId(plain.id)).toBe(false);
  });

  it("isSetupSessionId recognizes LEGACY pty-setup ids; run/plain ids are not setup ids", () => {
    // Nothing mints pty-setup ids anymore (the trunk's setup moved to the
    // engine runner) — the recognizer only has to keep a PERSISTED legacy
    // session pinned/filtered until TerminalPanel's migration purge drops it.
    expect(isSetupSessionId("pty-setup-abc123")).toBe(true);
    // Setup + run ids are distinct namespaces (different prefixes).
    expect(isRunSessionId("pty-setup-abc123")).toBe(false);
    expect(isSetupSessionId(runSessionId("/w"))).toBe(false);
    const plain = useTerminalStore.getState().createSession("/w");
    expect(isSetupSessionId(plain.id)).toBe(false);
  });

  it("keeps a RELOADED setup terminal (no initialCommand) out of the plain 'Terminal N' sequence", () => {
    // A reloaded trunk setup terminal hydrates with its pty-setup- id but its
    // runtime-only initialCommand is gone — it must still be PINNED so it doesn't
    // get swept into the plain numbering.
    const reloadedSetup: TerminalSession = {
      id: "pty-setup-x",
      folder: "/w",
      title: "Setup",
      createdAt: 1,
      alive: true,
      agentId: null,
    };
    useTerminalStore.setState({
      sessions: [reloadedSetup],
      activeTerminalTabByFolder: {},
    });
    const s = useTerminalStore.getState();
    // A lone plain terminal alongside Setup stays "Terminal" (not bumped to "1").
    s.createSession("/w");
    expect(titlesOf("/w").sort()).toEqual(["Setup", "Terminal"]);
    // The setup terminal keeps its title across a renumber.
    expect(titlesOf("/w").filter((t) => t === "Setup")).toHaveLength(1);
  });

  it("keeps a RELOADED run terminal (no initialCommand) titled 'Run' + out of the plain sequence", () => {
    // Simulate a reload: the run terminal hydrates with its pty-run- id and
    // "Run" title, but its runtime-only initialCommand is gone.
    const reloadedRun: TerminalSession = {
      id: "pty-run-x",
      folder: "/w",
      title: "Run",
      createdAt: 1,
      alive: true,
      agentId: null,
    };
    useTerminalStore.setState({
      sessions: [reloadedRun],
      activeTerminalTabByFolder: {},
    });
    const s = useTerminalStore.getState();

    // One plain terminal alongside Run → "Terminal" (NOT bumped to "1" by Run),
    // and Run keeps its title even though renumberFolder ran.
    s.createSession("/w");
    expect(titlesOf("/w").sort()).toEqual(["Run", "Terminal"]);

    // A second plain → "Terminal 1" / "Terminal 2"; Run is still skipped.
    s.createSession("/w");
    const titles = titlesOf("/w");
    expect(titles.filter((t) => t === "Run")).toHaveLength(1);
    expect(titles).toContain("Terminal 1");
    expect(titles).toContain("Terminal 2");
  });

  it("repoints to a PLAIN terminal (not the run tab) when the active one is closed", () => {
    useTerminalStore.setState({
      sessions: [
        {
          id: "t1",
          folder: "/w",
          title: "Terminal 1",
          createdAt: 1,
          alive: true,
          agentId: null,
        },
        {
          id: "t2",
          folder: "/w",
          title: "Terminal 2",
          createdAt: 2,
          alive: true,
          agentId: null,
        },
        {
          id: "pty-run-x",
          folder: "/w",
          title: "Run",
          createdAt: 3,
          alive: true,
          agentId: null,
        },
      ],
      activeTerminalTabByFolder: { "/w": "t2" },
    });
    // Delete the active plain terminal — repoint must prefer the surviving PLAIN
    // terminal (t1), never the run terminal (which has its own sub-tab).
    useTerminalStore.getState().closeSession("t2");
    expect(useTerminalStore.getState().activeTerminalTabByFolder["/w"]).toBe(
      "t1",
    );
  });
});

// ── Rename (custom titles + duplicate prevention) ─────────
describe("terminal-store renameSession", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      sessions: [],
      activeTerminalTabByFolder: {},
    });
  });

  const titlesOf = (folder: string) =>
    selectSessionsForFolder(useTerminalStore.getState(), folder).map(
      (x) => x.title,
    );

  it("pins a custom name so a later create doesn't renumber it away", () => {
    const s = useTerminalStore.getState();
    const a = s.createSession("/w");
    const b = s.createSession("/w"); // "Terminal 1", "Terminal 2"
    s.renameSession(b.id, "build");
    s.createSession("/w"); // a 3rd — renumberFolder must NOT clobber "build"
    const titles = titlesOf("/w");
    expect(titles.filter((t) => t === "build")).toHaveLength(1);
    // the non-renamed terminals stay auto-numbered, and `a` keeps "Terminal 1"
    const byId = (id: string) =>
      useTerminalStore.getState().sessions.find((x) => x.id === id)!;
    expect(byId(a.id).title).toBe("Terminal 1");
  });

  it("renaming to a reserved 'Terminal N' name leaves NO duplicate", () => {
    const s = useTerminalStore.getState();
    s.createSession("/w");
    s.createSession("/w");
    const c = s.createSession("/w"); // "Terminal 1", "Terminal 2", "Terminal 3"
    s.renameSession(c.id, "Terminal 2");
    const titles = titlesOf("/w");
    // every title is unique — the auto sibling that held "Terminal 2" shifts.
    expect(new Set(titles).size).toBe(titles.length);
    // the rename itself stuck.
    expect(
      useTerminalStore.getState().sessions.find((x) => x.id === c.id)!.title,
    ).toBe("Terminal 2");
  });
});
