import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  openZerosDb,
  closeZerosDb,
  setZerosDbPathForTesting,
  latestSchemaVersion,
} from "../index";
import {
  listProjects,
  listKnownRepoRoots,
  upsertRepoByRoot,
  removeRepoByRoot,
  renameRepoByRoot,
  pruneWorktreeRepos,
} from "../projects";
import {
  listChats,
  listChatsSince,
  summariesForFolder,
  upsertChat,
  deleteChat,
  bulkUpsertChats,
  coerceChatRow,
  setChatWorkspaceResolver,
  backfillChatWorkspaceIds,
  type ChatRow,
} from "../chats";
import { headRev, tombstonesSince } from "../sync";
import {
  upsertChatMessage,
  upsertChatMessagesBulk,
  windowChatMessages,
  windowOlderChatMessages,
  searchMessages,
  listChatMessagesSince,
  backfillChatMessageRevs,
  clearChatMessages,
  truncateChatMessagesFrom,
} from "../messages";

function makeChat(id: string, over: Partial<ChatRow> = {}): ChatRow {
  return {
    id,
    folder: "/p",
    agentId: "claude",
    agentName: "Claude",
    model: null,
    effort: "",
    permissionMode: "default",
    lastModeId: null,
    prePlanModeId: null,
    fast: false,
    additionalDirectories: [],
    title: id,
    createdAt: 1,
    updatedAt: 1,
    sessionId: null,
    pinned: false,
    archived: false,
    sourceChatId: null,
    kind: "chat",
    ...over,
  };
}

const TABLES = [
  "repos",
  "workspaces",
  "workspace_meta",
  "workspace_lifecycle_journal",
  "detach_state",
  "settings",
  "attachments",
  "diff_comments",
  "terminal_sessions",
  "port_forwards",
  "sync_state",
  "sync_meta",
  "sync_tombstones",
  "chats",
  "chat_messages",
  "chat_messages_fts",
  "remote_restricted_workspaces",
  "turns",
  "schema_migrations",
];

// Dropped by migration 7 (idealized Phase-0 guesses, superseded): the engine
// uses chats/chat_messages, localStorage policies, and the real workspaces schema.
const DROPPED_TABLES = ["sessions", "messages", "messages_fts", "policies"];

function tmpDbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-db-"));
  return path.join(dir, "zeros.db");
}

describe("Zeros DB (unified engine store)", () => {
  afterEach(() => {
    closeZerosDb();
    setZerosDbPathForTesting(null);
    setChatWorkspaceResolver(null); // reset v11 resolver between tests
  });

  it("creates the full v1 schema and records the migration", () => {
    setZerosDbPathForTesting(tmpDbFile());
    const db = openZerosDb();

    const names = new Set(
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view')",
          )
          .all() as {
          name: string;
        }[]
      ).map((r) => r.name),
    );
    for (const t of TABLES)
      expect(names.has(t), `missing table: ${t}`).toBe(true);
    for (const t of DROPPED_TABLES)
      expect(names.has(t), `should be dropped: ${t}`).toBe(false);

    const applied = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];
    expect(applied.map((r) => r.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      22, 23, 24,
    ]);
    expect(latestSchemaVersion()).toBe(24);
  });

  it("stamps + backfills chats.workspace_id from folder via the resolver (v11)", () => {
    setZerosDbPathForTesting(tmpDbFile());
    const db = openZerosDb();

    // Stub standing in for WorkspaceService.workspaceIdForCwd: a managed folder
    // resolves to its id; anything else → null (a plain/empty folder = no owning
    // workspace). Mutable so we can simulate a folder GAINING a workspace.
    let mapping: Record<string, string> = { "/proj": "ws_proj" };
    setChatWorkspaceResolver((folder) => mapping[folder] ?? null);

    const wsId = (id: string): string | null =>
      (
        db.prepare("SELECT workspace_id FROM chats WHERE id = ?").get(id) as
          | { workspace_id: string | null }
          | undefined
      )?.workspace_id ?? null;

    // Upsert caches the resolved id from `folder`...
    upsertChat(makeChat("c1", { folder: "/proj" }));
    expect(wsId("c1")).toBe("ws_proj");
    // ...and a folder with no owning workspace stays NULL.
    upsertChat(makeChat("c2", { folder: "/scratch" }));
    expect(wsId("c2")).toBeNull();

    // Backfill fills rows that were NULL once their folder gains a workspace,
    // and ONLY those (c1 already set) — and reports the count.
    mapping = { "/proj": "ws_proj", "/scratch": "ws_scratch" };
    expect(backfillChatWorkspaceIds()).toBe(1);
    expect(wsId("c2")).toBe("ws_scratch");
    expect(wsId("c1")).toBe("ws_proj");

    // Engine-authoritative: re-upsert recomputes from `folder` (never a client
    // value), so a remapped folder moves the cached id.
    mapping = { "/proj": "ws_proj_v2", "/scratch": "ws_scratch" };
    upsertChat(makeChat("c1", { folder: "/proj" }));
    expect(wsId("c1")).toBe("ws_proj_v2");
  });

  it("is idempotent across re-opens (migrations run at most once)", () => {
    const file = tmpDbFile();
    setZerosDbPathForTesting(file);
    openZerosDb();
    closeZerosDb();
    // Re-open the SAME file: must not re-run migration 1 or throw.
    setZerosDbPathForTesting(file);
    const db = openZerosDb();
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
      .get() as { n: number };
    expect(count.n).toBe(24);
  });

  it("preserves created_at on upsert (immutable after first insert)", () => {
    setZerosDbPathForTesting(tmpDbFile());
    const db = openZerosDb();
    upsertChat(makeChat("c1", { createdAt: 1000, updatedAt: 1000 }));
    // A coerced/streaming update with createdAt=0 (coerceChatRow's default for a
    // missing value) or a stale client replay must NOT reset the creation time.
    upsertChat(
      makeChat("c1", { createdAt: 0, updatedAt: 2000, title: "renamed" }),
    );
    const row = db
      .prepare("SELECT created_at, updated_at, title FROM chats WHERE id = ?")
      .get("c1") as { created_at: number; updated_at: number; title: string };
    expect(row.created_at).toBe(1000); // preserved
    expect(row.updated_at).toBe(2000); // updated
    expect(row.title).toBe("renamed");
  });

  it("round-trips a repo row", () => {
    setZerosDbPathForTesting(tmpDbFile());
    const db = openZerosDb();
    db.prepare("INSERT INTO repos (id, name, remote_url) VALUES (?, ?, ?)").run(
      "r1",
      "Zeros",
      "git@github.com:acme/example.git",
    );
    const row = db
      .prepare("SELECT id, name, hidden, rev FROM repos WHERE id = ?")
      .get("r1") as {
      id: string;
      name: string;
      hidden: number;
      rev: number;
    };
    expect(row).toMatchObject({ id: "r1", name: "Zeros", hidden: 0, rev: 0 });
  });

  // (The idealized `messages`/`messages_fts` FTS test was removed in Phase 0 —
  //  migration 7 drops those unused tables; real transcript FTS over
  //  chat_messages_fts is covered by the "FTS: cross-chat search" test below.)

  it("listProjects seeds repos from workspaces, dedupes by root, maps Project shape", () => {
    setZerosDbPathForTesting(tmpDbFile());
    const ws = [
      { repoSlug: "acme-example", repoRoot: "/Users/x/example" },
      { repoSlug: "acme-example", repoRoot: "/Users/x/example" }, // dup root → one project
      { repoSlug: "acme-widgets", repoRoot: "/Users/x/widgets" },
    ];
    const projects = listProjects(ws);
    expect(projects.map((p) => p.repoRoot).sort()).toEqual([
      "/Users/x/example",
      "/Users/x/widgets",
    ]);

    const z = projects.find((p) => p.repoRoot === "/Users/x/example")!;
    expect(z).toMatchObject({
      repoSlug: "acme-example",
      name: "example",
      originUrl: null,
    });
    expect(z.id).toMatch(/^proj_[0-9a-f]{12}$/);
    expect(typeof z.addedAt).toBe("number");

    // Idempotent: re-seeding with the same roots + one new repo doesn't duplicate.
    const again = listProjects([
      ...ws,
      { repoSlug: "n", repoRoot: "/Users/x/new" },
    ]);
    expect(again.length).toBe(3);
    expect(again.filter((p) => p.repoRoot === "/Users/x/example").length).toBe(
      1,
    );
  });

  it("write-through: upsert a worktree-less project, rename it, then remove it", () => {
    setZerosDbPathForTesting(tmpDbFile());
    upsertRepoByRoot({
      repoRoot: "/Users/x/curated",
      repoSlug: "curated",
      name: "Curated",
      originUrl: "git@github.com:x/curated.git",
    });
    const c = listProjects([]).find((p) => p.repoRoot === "/Users/x/curated")!;
    expect(c).toMatchObject({
      name: "Curated",
      repoSlug: "curated",
      originUrl: "git@github.com:x/curated.git",
    });

    renameRepoByRoot("/Users/x/curated", "Renamed");
    expect(
      listProjects([]).find((p) => p.repoRoot === "/Users/x/curated")!.name,
    ).toBe("Renamed");

    removeRepoByRoot("/Users/x/curated");
    expect(
      listProjects([]).some((p) => p.repoRoot === "/Users/x/curated"),
    ).toBe(false);
  });

  it("a removed repo stays removed even with a worktree (hidden, not re-seeded)", () => {
    setZerosDbPathForTesting(tmpDbFile());
    const ws = [{ repoSlug: "z", repoRoot: "/Users/x/zeros" }];
    listProjects(ws); // seeds it
    removeRepoByRoot("/Users/x/zeros");
    // Hiding (not deleting) survives the worktree re-seed, so the removal
    // STICKS — the "a project I removed keeps coming back" bug is fixed.
    expect(listProjects(ws).some((p) => p.repoRoot === "/Users/x/zeros")).toBe(
      false,
    );
    // Explicitly re-adding the same folder un-hides it.
    upsertRepoByRoot({ repoSlug: "z", repoRoot: "/Users/x/zeros" });
    expect(listProjects(ws).some((p) => p.repoRoot === "/Users/x/zeros")).toBe(
      true,
    );
  });

  it("project identity canonicalizes symlinked repo roots", () => {
    setZerosDbPathForTesting(tmpDbFile());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-project-root-"));
    const real = path.join(dir, "repo");
    const link = path.join(dir, "repo-link");
    fs.mkdirSync(real);
    try {
      fs.symlinkSync(real, link, "dir");
    } catch {
      return;
    }

    upsertRepoByRoot({ repoRoot: link, repoSlug: "repo", name: "Via link" });
    upsertRepoByRoot({
      repoRoot: real,
      repoSlug: "repo",
      name: "Via realpath",
    });

    const projects = listProjects([]);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      repoRoot: fs.realpathSync.native(real),
      name: "Via realpath",
    });
  });

  it("listKnownRepoRoots: returns open roots read-only (no seeding), excludes hidden", () => {
    setZerosDbPathForTesting(tmpDbFile());
    // A worktree-less project registered via the bridge (project.upsert) — the
    // no-respawn "Open project" path. The PTY cwd allowlist consults this so a
    // terminal opened in the just-added repo's root is trusted immediately,
    // before any worktree exists, instead of falling back to the engine root.
    upsertRepoByRoot({ repoRoot: "/Users/x/added", repoSlug: "added" });
    upsertRepoByRoot({ repoRoot: "/Users/x/other", repoSlug: "other" });
    expect(listKnownRepoRoots().sort()).toEqual([
      "/Users/x/added",
      "/Users/x/other",
    ]);

    // Read-only: unlike listProjects it never seeds repos from workspaces — it's
    // a hot-path helper, so it must not mutate the table as a side effect.
    expect(listKnownRepoRoots().length).toBe(2);

    // A removed (hidden) repo drops out of the trusted set.
    removeRepoByRoot("/Users/x/other");
    expect(listKnownRepoRoots()).toEqual(["/Users/x/added"]);
  });

  it("pruneWorktreeRepos: removes phantom worktree repos, keeps real ones, idempotent", () => {
    setZerosDbPathForTesting(tmpDbFile());
    const prevWsDir = process.env.ZEROS_WORKSPACES_DIR;
    // Pin the visible worktrees root so the phantom path is deterministic.
    process.env.ZEROS_WORKSPACES_DIR = "/tmp/zeros-wsroot";
    try {
      upsertRepoByRoot({
        repoRoot: "/Users/x/Documents/widgets",
        repoSlug: "widgets",
      }); // real repo
      upsertRepoByRoot({
        repoRoot: "/tmp/zeros-wsroot/widgets/ws_e14d72-phalaenopsis", // phantom worktree
        repoSlug: "widgets",
      });
      expect(listProjects([]).length).toBe(2);

      expect(pruneWorktreeRepos()).toBe(1);
      const roots = listProjects([]).map((p) => p.repoRoot);
      expect(roots).toContain("/Users/x/Documents/widgets");
      expect(roots).not.toContain(
        "/tmp/zeros-wsroot/widgets/ws_e14d72-phalaenopsis",
      );

      expect(pruneWorktreeRepos()).toBe(0); // idempotent — nothing left to prune
    } finally {
      if (prevWsDir === undefined) delete process.env.ZEROS_WORKSPACES_DIR;
      else process.env.ZEROS_WORKSPACES_DIR = prevWsDir;
    }
  });

  it("chats: upsert + list (newest-first), bulkUpsert merges, delete", () => {
    setZerosDbPathForTesting(tmpDbFile());
    upsertChat(
      makeChat("c1", { title: "First", updatedAt: 100, pinned: true }),
    );
    upsertChat(makeChat("c2", { title: "Second", updatedAt: 200 }));
    let list = listChats();
    expect(list.map((c) => c.id)).toEqual(["c2", "c1"]); // ORDER BY updated_at DESC
    expect(list.find((c) => c.id === "c1")).toMatchObject({
      title: "First",
      pinned: true,
      archived: false,
    });

    // bulkUpsert MERGES (updates c1, adds c3) — never deletes the unseen c2.
    bulkUpsertChats([
      makeChat("c1", { title: "First!", updatedAt: 300 }),
      makeChat("c3", { updatedAt: 50 }),
    ]);
    list = listChats();
    expect(list.map((c) => c.id).sort()).toEqual(["c1", "c2", "c3"]);
    expect(list.find((c) => c.id === "c1")!.title).toBe("First!");

    deleteChat("c2");
    expect(listChats().some((c) => c.id === "c2")).toBe(false);
  });

  it("summariesForFolder: first user message per chat; includes archived; excludes self / no-user / other folders", () => {
    setZerosDbPathForTesting(tmpDbFile());
    upsertChat(
      makeChat("a", { folder: "/proj", title: "A", createdAt: 10, updatedAt: 10 }),
    );
    upsertChat(
      makeChat("b", { folder: "/proj", title: "B", createdAt: 20, updatedAt: 20 }),
    );
    upsertChat(
      makeChat("c", {
        folder: "/proj",
        title: "C",
        createdAt: 30,
        updatedAt: 30,
        archived: true,
      }),
    );
    upsertChat(
      makeChat("d", { folder: "/proj", title: "D", createdAt: 40, updatedAt: 40 }),
    ); // agent-only
    upsertChat(makeChat("z", { folder: "/elsewhere", updatedAt: 50 }));
    const um = (id: string, text: string, createdAt = 1) => ({
      msgId: id,
      kind: "text",
      payload: JSON.stringify({ id, kind: "text", role: "user", text }),
      createdAt,
    });
    const am = (id: string, text: string, createdAt = 2) => ({
      msgId: id,
      kind: "text",
      payload: JSON.stringify({ id, kind: "text", role: "agent", text }),
      createdAt,
    });
    upsertChatMessagesBulk("a", [
      um("a1", "first A question"),
      am("a2", "answer"),
      um("a3", "second A", 77),
    ]);
    upsertChatMessagesBulk("b", [um("b1", "first B question")]);
    upsertChatMessagesBulk("c", [um("c1", "first C question")]);
    upsertChatMessagesBulk("d", [am("d1", "agent only — no user turn")]);

    const rows = summariesForFolder("/proj");
    // agent-only d excluded; ARCHIVED c included and unmarked (2026-07-30 —
    // you close a tab when the work finishes, which is when its transcript is
    // most worth handing forward). Newest CREATION first: c=30, b=20, a=10.
    expect(rows.map((r) => r.chatId)).toEqual(["c", "b", "a"]);
    expect(rows.find((r) => r.chatId === "a")!.summary).toBe(
      "first A question",
    ); // FIRST user msg
    expect(rows.find((r) => r.chatId === "b")!.summary).toBe(
      "first B question",
    );
    // Volume + recency aggregates ride along on the same round trip.
    expect(rows.find((r) => r.chatId === "a")!.messageCount).toBe(3);
    expect(rows.find((r) => r.chatId === "a")!.lastMessageAt).toBe(77);
    expect(rows.find((r) => r.chatId === "b")!.messageCount).toBe(1);
    // excludeChatId drops self; cross-folder z never appears.
    expect(summariesForFolder("/proj", "b").map((r) => r.chatId)).toEqual([
      "c",
      "a",
    ]);
    expect(summariesForFolder("/nope")).toEqual([]);
  });

  it("summariesForFolder: creation order wins over updated_at, and ties fall back to insertion order", () => {
    setZerosDbPathForTesting(tmpDbFile());
    const um = (id: string) => ({
      msgId: id,
      kind: "text",
      payload: JSON.stringify({ id, kind: "text", role: "user", text: "q" }),
      createdAt: 1,
    });

    // `updated_at` order deliberately CONTRADICTS creation order. It used to be
    // the sort key and it is not activity: it moves when an AI title lands or
    // a setting is written, and never when a message is persisted.
    upsertChat(
      makeChat("old", { folder: "/p2", createdAt: 100, updatedAt: 999 }),
    );
    upsertChat(
      makeChat("new", { folder: "/p2", createdAt: 200, updatedAt: 1 }),
    );
    upsertChatMessagesBulk("old", [um("o1")]);
    upsertChatMessagesBulk("new", [um("n1")]);
    expect(summariesForFolder("/p2").map((r) => r.chatId)).toEqual([
      "new",
      "old",
    ]);

    // Legacy / coerced rows collapse to createdAt 0 (coerceChatRow defaults a
    // missing createdAt to 0, and the column has no NOT NULL). Without the
    // rowid tiebreak these would order arbitrarily and could differ per call.
    setZerosDbPathForTesting(tmpDbFile());
    upsertChat(makeChat("t1", { folder: "/p3", createdAt: 0 }));
    upsertChat(makeChat("t2", { folder: "/p3", createdAt: 0 }));
    upsertChat(makeChat("t3", { folder: "/p3", createdAt: 0 }));
    upsertChatMessagesBulk("t1", [um("x1")]);
    upsertChatMessagesBulk("t2", [um("x2")]);
    upsertChatMessagesBulk("t3", [um("x3")]);
    const first = summariesForFolder("/p3").map((r) => r.chatId);
    // Insertion order, newest first — and stable across repeat calls.
    expect(first).toEqual(["t3", "t2", "t1"]);
    expect(summariesForFolder("/p3").map((r) => r.chatId)).toEqual(first);
  });

  it("delta sync: global rev is monotonic; pull returns only changes + deletions since a cursor", () => {
    setZerosDbPathForTesting(tmpDbFile());
    expect(headRev()).toBe(0);

    upsertChat(makeChat("c1", { updatedAt: 1 }));
    const afterC1 = headRev();
    expect(afterC1).toBeGreaterThan(0);
    upsertChat(makeChat("c2", { updatedAt: 2 }));
    const afterC2 = headRev();
    expect(afterC2).toBeGreaterThan(afterC1); // monotonic across writes

    // A client at cursor=afterC1 has already seen c1 — pull returns only c2.
    expect(listChatsSince(afterC1).map((c) => c.id)).toEqual(["c2"]);
    // Full pull (since 0) returns both, in rev order.
    expect(listChatsSince(0).map((c) => c.id)).toEqual(["c1", "c2"]);
    // No tombstones yet.
    expect(tombstonesSince("chat", 0)).toEqual([]);

    // Delete c1 → it leaves the live set and appears as a tombstone with a NEW rev.
    const beforeDelete = headRev();
    deleteChat("c1");
    expect(listChats().some((c) => c.id === "c1")).toBe(false);
    expect(tombstonesSince("chat", beforeDelete)).toEqual(["c1"]);
    // listChatsSince never resurrects a deleted row.
    expect(listChatsSince(0).map((c) => c.id)).toEqual(["c2"]);

    // Re-create c1 → tombstone is cleared (no stale delete), row is back with a new rev.
    const beforeRecreate = headRev();
    upsertChat(makeChat("c1", { updatedAt: 9 }));
    expect(tombstonesSince("chat", 0)).toEqual([]); // cleared
    expect(listChatsSince(beforeRecreate).map((c) => c.id)).toEqual(["c1"]);
  });

  it("chats: coerceChatRow rejects junk and sanitizes types at the trust boundary", () => {
    expect(coerceChatRow(null)).toBeNull();
    expect(coerceChatRow({ noId: true })).toBeNull();
    // Wrong-typed fields are coerced to safe defaults; only a string id is required.
    expect(
      coerceChatRow({ id: "x", title: 5, pinned: "yes", createdAt: "nope" }),
    ).toMatchObject({
      id: "x",
      title: "",
      pinned: false,
      createdAt: 0,
      additionalDirectories: [], // missing → []
    });
    // additionalDirectories: keep only string entries, drop junk; non-array → [].
    expect(
      coerceChatRow({ id: "y", additionalDirectories: ["/a", 5, null, "/b"] })!
        .additionalDirectories,
    ).toEqual(["/a", "/b"]);
    expect(
      coerceChatRow({ id: "z", additionalDirectories: "nope" })!
        .additionalDirectories,
    ).toEqual([]);
  });

  it("chats: additionalDirectories round-trips through the JSON-array column", () => {
    setZerosDbPathForTesting(tmpDbFile());
    upsertChat(
      makeChat("d1", { additionalDirectories: ["/work/api", "/work/web"] }),
    );
    // Default stays [] when unset.
    upsertChat(makeChat("d2"));
    const list = listChats();
    expect(list.find((c) => c.id === "d1")!.additionalDirectories).toEqual([
      "/work/api",
      "/work/web",
    ]);
    expect(list.find((c) => c.id === "d2")!.additionalDirectories).toEqual([]);

    // An update replaces the array wholesale (the renderer always sends the
    // full list), and removal persists.
    upsertChat(makeChat("d1", { additionalDirectories: ["/work/api"] }));
    expect(
      listChats().find((c) => c.id === "d1")!.additionalDirectories,
    ).toEqual(["/work/api"]);
  });

  it("chat_messages: upsert appends, same msg_id updates in place, windows are chronological", () => {
    setZerosDbPathForTesting(tmpDbFile());
    upsertChatMessagesBulk("c1", [
      { msgId: "m1", kind: "text", payload: '{"id":"m1"}', createdAt: 1 },
      { msgId: "m2", kind: "text", payload: '{"id":"m2"}', createdAt: 2 },
      { msgId: "m3", kind: "text", payload: '{"id":"m3"}', createdAt: 3 },
    ]);
    // A streaming chunk reuses the msg_id → rewrites the SAME row (ord preserved).
    upsertChatMessage("c1", {
      msgId: "m2",
      kind: "text",
      payload: '{"id":"m2","t":"grown"}',
      createdAt: 2,
    });

    const all = windowChatMessages("c1", 10);
    expect(all.map((m) => m.msgId)).toEqual(["m1", "m2", "m3"]); // chronological
    expect(all.find((m) => m.msgId === "m2")!.payload).toContain("grown");

    // newest 2, still chronological within the window
    expect(windowChatMessages("c1", 2).map((m) => m.msgId)).toEqual([
      "m2",
      "m3",
    ]);
    // older page before m3
    expect(windowOlderChatMessages("c1", 10, "m3").map((m) => m.msgId)).toEqual(
      ["m1", "m2"],
    );
    // unknown chat / unknown cursor → []
    expect(windowChatMessages("nope", 10)).toEqual([]);
    expect(windowOlderChatMessages("c1", 10, "missing")).toEqual([]);
  });

  it("FTS: cross-chat search over transcript content, hyphen-safe, follows updates", () => {
    setZerosDbPathForTesting(tmpDbFile());
    const text = (id: string, t: string) => ({
      msgId: id,
      kind: "text",
      payload: JSON.stringify({ id, kind: "text", text: t }),
      createdAt: 1,
    });
    upsertChatMessagesBulk("c1", [
      text("m1", "the relay-core reducer forwards opaque ciphertext"),
      text("m2", "unrelated chatter about lunch"),
    ]);
    upsertChatMessage("c2", {
      msgId: "n1",
      kind: "tool",
      payload: JSON.stringify({
        id: "n1",
        kind: "tool",
        title: "Read relay/server.ts",
      }),
      createdAt: 3,
    });

    expect(searchMessages("ciphertext").map((h) => h.msgId)).toEqual(["m1"]);
    // cross-chat: "relay" hits c1's text AND c2's tool title
    expect(
      searchMessages("relay")
        .map((h) => h.msgId)
        .sort(),
    ).toEqual(["m1", "n1"]);
    // hyphenated term is literal, not the FTS NOT operator
    expect(searchMessages("relay-core").map((h) => h.msgId)).toEqual(["m1"]);
    // a streaming update changes content → the index follows
    upsertChatMessage("c1", text("m2", "now mentions ciphertext too"));
    expect(
      searchMessages("ciphertext")
        .map((h) => h.msgId)
        .sort(),
    ).toEqual(["m1", "m2"]);
    // a deleted message leaves the index
    db_deleteRow("c1", "m1");
    expect(searchMessages("relay-core")).toEqual([]);
    expect(searchMessages("   ")).toEqual([]);
  });

  it("delta sync: messages stamp a GLOBAL rev, list since a cursor, reset tombstones", () => {
    setZerosDbPathForTesting(tmpDbFile());
    const text = (id: string, t: string) => ({
      msgId: id,
      kind: "text",
      payload: JSON.stringify({ id, role: "user", text: t }),
      createdAt: 1,
    });
    const base = headRev();
    upsertChatMessage("c1", text("m1", "hi"));
    // Insert stamps a fresh GLOBAL rev (not the old per-row rev=rev+1 counter).
    expect(headRev()).toBeGreaterThan(base);
    const d1 = listChatMessagesSince(base);
    expect(d1.map((m) => `${m.chatId}/${m.msgId}`)).toEqual(["c1/m1"]);
    expect(typeof d1[0]?.ord).toBe("number");

    // A streaming UPDATE bumps the global rev and reappears in a delta since the
    // pre-update head — the gap the old per-row counter left unsyncable.
    const beforeUpd = headRev();
    upsertChatMessage("c1", text("m1", "hi there"));
    expect(headRev()).toBeGreaterThan(beforeUpd);
    expect(listChatMessagesSince(beforeUpd).some((m) => m.msgId === "m1")).toBe(
      true,
    );
    // Nothing changed past the current head.
    expect(listChatMessagesSince(headRev())).toEqual([]);

    // Bulk insert into a second chat is routed by chatId, oldest-change first.
    upsertChatMessagesBulk("c2", [text("a", "a"), text("b", "b")]);
    expect(
      listChatMessagesSince(base)
        .filter((m) => m.chatId === "c2")
        .map((m) => m.msgId),
    ).toEqual(["a", "b"]);

    // truncate + clear record a msgreset tombstone so a delta puller re-windows.
    const beforeTrunc = headRev();
    truncateChatMessagesFrom("c2", "b");
    expect(tombstonesSince("msgreset", beforeTrunc)).toContain("c2");
    const beforeClear = headRev();
    clearChatMessages("c1");
    expect(tombstonesSince("msgreset", beforeClear)).toContain("c1");
  });

  it("backfillChatMessageRevs stamps legacy rev=0 rows and is idempotent", () => {
    setZerosDbPathForTesting(tmpDbFile());
    const db = openZerosDb();
    db.prepare(
      "INSERT INTO chat_messages (chat_id, msg_id, ord, kind, payload, created_at, content, rev) VALUES (?,?,?,?,?,?,?,0)",
    ).run("c3", "z", 1, "text", "{}", 1, "");
    expect(backfillChatMessageRevs()).toBe(1);
    const row = db
      .prepare(
        "SELECT rev FROM chat_messages WHERE chat_id = 'c3' AND msg_id = 'z'",
      )
      .get() as { rev: number };
    expect(row.rev).toBeGreaterThan(0);
    expect(backfillChatMessageRevs()).toBe(0); // idempotent — no rev=0 rows left
  });
});

function db_deleteRow(chatId: string, msgId: string): void {
  // Direct delete to exercise the FTS delete trigger (no public delete-one yet).
  const db = openZerosDb();
  db.prepare("DELETE FROM chat_messages WHERE chat_id = ? AND msg_id = ?").run(
    chatId,
    msgId,
  );
}
