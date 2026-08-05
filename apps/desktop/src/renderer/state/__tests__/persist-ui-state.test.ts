// Boot-state persistence — validation of the per-workspace active-chat map so a
// corrupt / legacy localStorage blob can never seed a bad folder→chat mapping
// (or crash boot). The map is restored on launch and feeds the workspace-switch
// handlers, so a malformed entry must degrade to "no memory", not throw.
import { describe, it, expect, beforeEach } from "vitest";

import { loadPersistedUiState } from "../persist-ui-state";

const KEY = "zeros:ui-state:v1";

// The node test env has no DOM — install a tiny Map-backed localStorage before
// each test (loadPersistedUiState reads localStorage.getItem).
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
});

describe("loadPersistedUiState — activeChatByFolder", () => {
  it("restores the active chat in the same atomic workspace snapshot", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        activePage: "workspace",
        activeChatId: "chat-a",
        lastWorkspaceFolder: "/wt-a",
        activeChatByFolder: { "/wt-a": "chat-a" },
      }),
    );
    expect(loadPersistedUiState()).toMatchObject({
      activePage: "workspace",
      activeChatId: "chat-a",
      lastWorkspaceFolder: "/wt-a",
      activeChatByFolder: { "/wt-a": "chat-a" },
    });
  });

  it("degrades a malformed active chat id without losing its workspace", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ activeChatId: 42, lastWorkspaceFolder: "/wt-a" }),
    );
    expect(loadPersistedUiState()).toMatchObject({
      activeChatId: null,
      lastWorkspaceFolder: "/wt-a",
    });
  });

  it("round-trips a valid folder→chat map", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ activeChatByFolder: { "/wt-a": "c1", "/wt-b": "c2" } }),
    );
    expect(loadPersistedUiState().activeChatByFolder).toEqual({
      "/wt-a": "c1",
      "/wt-b": "c2",
    });
  });

  it("drops entries whose value isn't a non-empty string", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        activeChatByFolder: {
          "/wt-a": "c1",
          "/wt-b": 42,
          "/wt-c": "",
          "/wt-d": null,
        },
      }),
    );
    expect(loadPersistedUiState().activeChatByFolder).toEqual({
      "/wt-a": "c1",
    });
  });

  it("falls back to an empty map when the blob is an array, not an object", () => {
    localStorage.setItem(KEY, JSON.stringify({ activeChatByFolder: ["c1"] }));
    expect(loadPersistedUiState().activeChatByFolder).toEqual({});
  });

  it("omits the field when absent, leaving sibling fields intact", () => {
    localStorage.setItem(KEY, JSON.stringify({ lastWorkspaceFolder: "/wt-a" }));
    const out = loadPersistedUiState();
    expect(out.activeChatByFolder).toBeUndefined();
    expect(out.lastWorkspaceFolder).toBe("/wt-a");
  });

  it("survives a completely corrupt blob", () => {
    localStorage.setItem(KEY, "}{not json");
    expect(() => loadPersistedUiState()).not.toThrow();
    expect(loadPersistedUiState()).toEqual({});
  });
});

describe("loadPersistedUiState — repo page (activePage + activeRepoId pair)", () => {
  it("round-trips a repo page with its target id", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ activePage: "repo", activeRepoId: "proj_abc" }),
    );
    const out = loadPersistedUiState();
    expect(out.activePage).toBe("repo");
    expect(out.activeRepoId).toBe("proj_abc");
  });

  it("degrades a repo page WITHOUT an id to the Dashboard", () => {
    localStorage.setItem(KEY, JSON.stringify({ activePage: "repo" }));
    expect(loadPersistedUiState().activePage).toBe("dashboard");
  });

  it("degrades a repo page with a non-string id to the Dashboard", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ activePage: "repo", activeRepoId: 42 }),
    );
    const out = loadPersistedUiState();
    expect(out.activePage).toBe("dashboard");
    expect(out.activeRepoId).toBeNull();
  });

  it("keeps a non-repo page even when a stale repo id is present", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ activePage: "dashboard", activeRepoId: "proj_abc" }),
    );
    const out = loadPersistedUiState();
    expect(out.activePage).toBe("dashboard");
    expect(out.activeRepoId).toBe("proj_abc");
  });

  it("round-trips the Customize page as both the active page and the Home memory", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ activePage: "customize", lastHomePage: "customize" }),
    );
    const out = loadPersistedUiState();
    expect(out.activePage).toBe("customize");
    expect(out.lastHomePage).toBe("customize");
  });
});

describe("loadPersistedUiState — scoped navigation", () => {
  it("restores Home, per-repo workspace, and per-repo hub view independently", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        activePage: "workspace",
        lastHomePage: "repo",
        activeRepoId: "project-a",
        lastWorkspaceByRepoRoot: {
          "/repo-a": "/repo-a/wt-one",
          "/repo-b": "/repo-b/wt-two",
        },
        repoPageViewByProject: {
          "project-a": "git",
          "project-b": "paths",
        },
      }),
    );

    expect(loadPersistedUiState()).toMatchObject({
      lastHomePage: "repo",
      activeRepoId: "project-a",
      lastWorkspaceByRepoRoot: {
        "/repo-a": "/repo-a/wt-one",
        "/repo-b": "/repo-b/wt-two",
      },
      repoPageViewByProject: {
        "project-a": "git",
        "project-b": "paths",
      },
    });
  });

  it("round-trips every repo view the tab strip can select", () => {
    // The read-back allowlist is a separate list from the RepoPageView union,
    // so a new tab that compiles can still be dropped here — and the symptom
    // is only visible after an app restart, when it silently reverts to
    // Workspaces.
    const views = [
      "workspaces",
      "environment",
      "git",
      "actions",
      "files",
      "paths",
    ] as const;
    localStorage.setItem(
      KEY,
      JSON.stringify({
        repoPageViewByProject: Object.fromEntries(
          views.map((v, i) => [`project-${i}`, v]),
        ),
      }),
    );
    expect(loadPersistedUiState().repoPageViewByProject).toEqual(
      Object.fromEntries(views.map((v, i) => [`project-${i}`, v])),
    );
  });

  it("drops malformed scoped entries and invalid repo views", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        lastWorkspaceByRepoRoot: {
          "/repo-a": "/repo-a/wt-one",
          "/repo-b": 42,
        },
        repoPageViewByProject: {
          "project-a": "checks",
          "project-b": "environment",
          "project-c": null,
        },
      }),
    );

    const out = loadPersistedUiState();
    expect(out.lastWorkspaceByRepoRoot).toEqual({
      "/repo-a": "/repo-a/wt-one",
    });
    expect(out.repoPageViewByProject).toEqual({
      "project-b": "environment",
    });
  });

  it("attributes the former global repo view to the active repo on upgrade", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ activePage: "repo", activeRepoId: "project-a" }),
    );
    localStorage.setItem("zeros-repo-page:view", JSON.stringify("git"));

    expect(loadPersistedUiState().repoPageViewByProject).toEqual({
      "project-a": "git",
    });
  });

  it("bounds scoped maps to their newest 128 entries", () => {
    const entries = Object.fromEntries(
      Array.from({ length: 140 }, (_, index) => [
        `/repo-${index}`,
        `/repo-${index}/worktree`,
      ]),
    );
    localStorage.setItem(
      KEY,
      JSON.stringify({ lastWorkspaceByRepoRoot: entries }),
    );

    const restored = loadPersistedUiState().lastWorkspaceByRepoRoot!;
    expect(Object.keys(restored)).toHaveLength(128);
    expect(restored["/repo-0"]).toBeUndefined();
    expect(restored["/repo-139"]).toBe("/repo-139/worktree");
  });

  it("degrades a remembered repo Home destination without a repo id", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ activePage: "workspace", lastHomePage: "repo" }),
    );
    expect(loadPersistedUiState().lastHomePage).toBe("dashboard");
  });
});
