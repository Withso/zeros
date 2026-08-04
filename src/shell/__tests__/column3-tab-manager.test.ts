import { describe, expect, it } from "vitest";

import {
  MAX_RECENT_BROWSERS,
  blankFixedFilesTab,
  createBrowserTab,
  createChangesTab,
  createEmptyFilesTab,
  createFilesTab,
  defaultScopeFor,
  defaultTabs,
  findBlankFilesTab,
  MAX_PERSISTED_COLUMN3_SCOPES,
  migrateScopes,
  normalizeRecentBrowsers,
  normalizeRow1Tabs,
  orderRow1Tabs,
  planRow1Open,
  recordRecentBrowser,
  row1TabIconPath,
  shouldMountRow1Tab,
  type Column3ScopeMap,
  type Column3ScopeState,
  type Column3Tab,
} from "../column3-tab-manager";

describe("tab factories", () => {
  it("creates path-backed and blank File tabs with the right labels", () => {
    expect(() => createFilesTab("  ")).toThrow(/non-empty file path/);
    expect(createFilesTab("src/app/index.html", { diff: true })).toMatchObject({
      type: "files",
      title: "index.html",
      filePath: "src/app/index.html",
      diff: true,
      fileTreeVisible: false,
    });
    expect(createEmptyFilesTab()).toMatchObject({
      type: "files",
      title: "Open file",
      fileTreeVisible: true,
    });
  });

  it("reverts the fixed home to the exact fresh blank state", () => {
    const home: Column3Tab = {
      ...createFilesTab("src/deep/openapi.yaml", {
        diff: true,
        diffScope: "commit",
        diffSha: "abc123",
        discardable: true,
        isNewFile: true,
      }),
      fixed: true,
      viewerMode: "edit",
      contentRevision: 3,
    };
    expect(blankFixedFilesTab(home)).toEqual({
      id: home.id,
      type: "files",
      fixed: true,
      title: "Open file",
      filePath: undefined,
      fileTreeVisible: true,
      diff: false,
      diffScope: undefined,
      diffSha: undefined,
      turnChatId: undefined,
      turnId: undefined,
      discardable: false,
      isNewFile: false,
      viewerMode: undefined,
      contentRevision: undefined,
    });
  });

  it("creates independently closable Browser tabs with a stable blank title", () => {
    const blank = createBrowserTab();
    const docs = createBrowserTab({
      url: "https://example.com/docs",
      title: "Docs",
    });
    expect(blank).toMatchObject({ type: "browser", title: "Browser", url: "" });
    expect(docs).toMatchObject({
      type: "browser",
      title: "Docs",
      url: "https://example.com/docs",
    });
    expect(blank.id).not.toBe(docs.id);
    expect(blank.pinned).toBeUndefined();
  });
});

describe("planRow1Open", () => {
  const file = (id: string, filePath?: string): Column3Tab => ({
    id,
    type: "files",
    title: filePath ?? "Open file",
    filePath,
  });
  const browser = (id: string): Column3Tab => ({
    id,
    type: "browser",
    title: "Browser",
    url: "",
  });

  it("replaces the active File tab, even if the path is open elsewhere", () => {
    expect(
      planRow1Open([file("f1", "a.ts"), file("f2", "b.ts")], "f2", "a.ts"),
    ).toEqual({ kind: "replace", id: "f2" });
  });

  it("preserves a dirty active File tab when another path opens", () => {
    expect(
      planRow1Open(
        [file("dirty", "draft.ts"), file("target", "next.ts")],
        "dirty",
        "next.ts",
        true,
      ),
    ).toEqual({ kind: "focus", id: "target" });
    expect(
      planRow1Open([file("dirty", "draft.ts")], "dirty", "new.ts", true),
    ).toEqual({ kind: "new" });
    // A blank (never dirty — it has no editor) still absorbs the open, so the
    // draft survives without allocating a duplicate surface.
    expect(
      planRow1Open(
        [file("dirty", "draft.ts"), { ...file("home"), fixed: true }],
        "dirty",
        "new.ts",
        true,
      ),
    ).toEqual({ kind: "replace", id: "home" });
  });

  it("focuses an existing path, then consumes a blank tab before adding", () => {
    expect(
      planRow1Open([browser("b"), file("open", "a.ts")], "b", "a.ts"),
    ).toEqual({ kind: "focus", id: "open" });
    expect(planRow1Open([browser("b"), file("empty")], "b", "new.ts")).toEqual({
      kind: "replace",
      id: "empty",
    });
    expect(planRow1Open([browser("b")], "b", "new.ts")).toEqual({
      kind: "new",
    });
  });

  it("prefers the blank fixed home over an earlier extra blank", () => {
    const extraBlank = file("extra");
    const home: Column3Tab = { ...file("home"), fixed: true };
    expect(planRow1Open([browser("b"), extraBlank, home], "b", "n.ts")).toEqual(
      { kind: "replace", id: "home" },
    );
    expect(findBlankFilesTab([extraBlank, home])?.id).toBe("home");
    // A filled home no longer counts as a direct-open destination.
    expect(
      findBlankFilesTab([{ ...home, filePath: "a.ts" }, extraBlank])?.id,
    ).toBe("extra");
  });
});

describe("row1TabIconPath", () => {
  it("resolves a File tab's icon from its open file", () => {
    expect(row1TabIconPath(createFilesTab("site/README.md"))).toBe(
      "site/README.md",
    );
    expect(row1TabIconPath(createFilesTab("scripts/install.sh"))).toBe(
      "scripts/install.sh",
    );
    expect(row1TabIconPath(createFilesTab("package.json"))).toBe("package.json");
  });

  it("keeps the generic glyph for blank File tabs and non-File tabs", () => {
    expect(row1TabIconPath(createEmptyFilesTab())).toBeNull();
    expect(row1TabIconPath(createChangesTab())).toBeNull();
    expect(row1TabIconPath(createBrowserTab({ url: "http://a.test/" }))).toBe(
      null,
    );
    // Changes tabs carry a filePath (their sidebar selection) but the pill is
    // still the "Changes" home, not that file.
    expect(
      row1TabIconPath({
        ...createChangesTab(),
        filePath: "src/index.ts",
      }),
    ).toBeNull();
  });

  it("treats a whitespace-only path as no file", () => {
    expect(
      row1TabIconPath({ ...createEmptyFilesTab(), filePath: "   " }),
    ).toBeNull();
  });
});

describe("shouldMountRow1Tab", () => {
  it("keeps pinned sources, Browsers, the active tab, and dirty editors mounted", () => {
    const dirty = new Set(["dirty"]);
    expect(
      shouldMountRow1Tab(
        { id: "browser-a", type: "browser", title: "A" },
        "active",
        dirty,
      ),
    ).toBe(true);
    expect(
      shouldMountRow1Tab(
        { id: "browser-b", type: "browser", title: "B" },
        "active",
        dirty,
      ),
    ).toBe(true);
    expect(shouldMountRow1Tab(createChangesTab(), "other", dirty)).toBe(true);
    expect(
      shouldMountRow1Tab(
        { id: "review", type: "review", title: "Review", pinned: true },
        "other",
        dirty,
      ),
    ).toBe(true);
    expect(
      shouldMountRow1Tab(
        { id: "dirty", type: "files", title: "draft.ts", filePath: "draft.ts" },
        "other",
        dirty,
      ),
    ).toBe(true);
  });
});

describe("defaultTabs", () => {
  it("seeds exactly Open file, Changes, Review and opens the File tab", () => {
    const { tabs, activeId, recentBrowsers } = defaultTabs();
    expect(tabs.map((tab) => tab.type)).toEqual(["files", "changes", "review"]);
    expect(tabs.map((tab) => tab.title)).toEqual([
      "Open file",
      "Changes",
      "Review",
    ]);
    expect(tabs.map((tab) => Boolean(tab.pinned))).toEqual([false, true, true]);
    // The seeded blank File tab is THE permanent Files home.
    expect(tabs[0].fixed).toBe(true);
    expect(activeId).toBe(tabs[0].id);
    expect(recentBrowsers).toEqual([]);
  });

  it("generates unique default ids and stable per-scope defaults", () => {
    const a = defaultTabs();
    const b = defaultTabs();
    expect(a.tabs.map((tab) => tab.id)).not.toEqual(
      b.tabs.map((tab) => tab.id),
    );
    expect(defaultScopeFor("/repo/a")).toBe(defaultScopeFor("/repo/a"));
    expect(defaultScopeFor("/repo/a")).not.toBe(defaultScopeFor("/repo/b"));
  });
});

describe("normalizeRow1Tabs", () => {
  it("seeds the permanent surfaces, and only those, into an empty slice", () => {
    const out = normalizeRow1Tabs([]);
    // Browsers and EXTRA File tabs stay gone, but the fixed Files home is
    // permanent now — a persisted slice without one is legacy state.
    expect(out.map((tab) => tab.type)).toEqual(["files", "changes", "review"]);
    expect(out[0]).toMatchObject({
      title: "Open file",
      fixed: true,
      fileTreeVisible: true,
    });
    expect(Boolean(out[0].pinned)).toBe(false);
    expect(out.slice(1).every((tab) => tab.pinned)).toBe(true);
  });

  it("migrates a legacy Files home into the fixed Open file first tab", () => {
    const out = normalizeRow1Tabs([
      { id: "legacy-files", type: "files", title: "Files", pinned: true },
    ]);
    expect(out[0]).toMatchObject({
      id: "legacy-files",
      type: "files",
      title: "Open file",
      pinned: false,
      fixed: true,
    });
  });

  it("preserves multiple File and Browser tabs while stripping their pins", () => {
    const out = normalizeRow1Tabs([
      { id: "b1", type: "browser", title: "One", url: "https://one.dev" },
      { id: "blank", type: "files", title: "Files", pinned: true },
      { id: "b2", type: "browser", title: "", url: "" },
      { id: "f1", type: "files", title: "a.ts", filePath: "a.ts" },
    ]);
    expect(out.map((tab) => tab.id)).toEqual([
      "blank",
      expect.stringMatching(/^changes-/),
      expect.stringMatching(/^review-/),
      "b1",
      "b2",
      "f1",
    ]);
    expect(out.filter((tab) => tab.type === "browser")).toHaveLength(2);
    expect(out.find((tab) => tab.id === "b2")?.title).toBe("Browser");
    // The first File tab of a pre-flag slice is promoted to the fixed home.
    expect(out.find((tab) => tab.id === "blank")?.fixed).toBe(true);
    expect(out.find((tab) => tab.id === "f1")?.fixed).toBeUndefined();
    expect(
      out
        .filter((tab) => tab.type === "files" || tab.type === "browser")
        .every((tab) => !tab.pinned),
    ).toBe(true);
  });

  it("keeps exactly one fixed Files home and ignores non-File fixed flags", () => {
    const out = normalizeRow1Tabs([
      {
        id: "stray",
        type: "browser",
        title: "B",
        url: "",
        fixed: true,
      } as Column3Tab,
      { id: "f1", type: "files", title: "a.ts", filePath: "a.ts" },
      {
        id: "home",
        type: "files",
        title: "b.ts",
        filePath: "b.ts",
        fixed: true,
      },
      {
        id: "dupe",
        type: "files",
        title: "c.ts",
        filePath: "c.ts",
        fixed: true,
      },
    ]);
    // The first PERSISTED flag wins (not merely the first File tab), extra
    // flags are stripped, and the home leads the strip.
    expect(out[0].id).toBe("home");
    expect(
      out
        .filter((tab) => tab.type === "files")
        .map((tab) => [tab.id, tab.fixed]),
    ).toEqual([
      ["home", true],
      ["f1", undefined],
      ["dupe", undefined],
    ]);
    expect(out.find((tab) => tab.id === "stray")?.fixed).toBeUndefined();
  });

  it("restores each File tab's tree visibility and repairs invalid defaults", () => {
    const out = normalizeRow1Tabs([
      {
        id: "expanded",
        type: "files",
        title: "a.ts",
        filePath: "src/a.ts",
        fileTreeVisible: true,
      },
      {
        id: "collapsed",
        type: "files",
        title: "b.ts",
        filePath: "src/b.ts",
        fileTreeVisible: false,
      },
      {
        id: "legacy",
        type: "files",
        title: "c.ts",
        filePath: "src/c.ts",
      },
      {
        id: "corrupt",
        type: "files",
        title: "d.ts",
        filePath: "src/d.ts",
        fileTreeVisible: "yes" as unknown as boolean,
      },
      {
        id: "blank",
        type: "files",
        title: "Open file",
        fileTreeVisible: false,
      },
    ]);

    expect(
      out
        .filter((tab) => tab.type === "files")
        .map((tab) => [tab.id, tab.fileTreeVisible]),
    ).toEqual([
      ["expanded", true],
      ["collapsed", false],
      ["legacy", false],
      ["corrupt", false],
      ["blank", true],
    ]);
  });

  it("repairs duplicate/malformed persisted ids without dropping valid tabs", () => {
    const out = normalizeRow1Tabs([
      { id: "same", type: "files", title: "", filePath: undefined },
      { id: "same", type: "browser", title: "", url: "" },
      null as unknown as Column3Tab,
    ]);
    const ids = out.map((tab) => tab.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(out.filter((tab) => tab.type === "files")).toHaveLength(1);
    expect(out.filter((tab) => tab.type === "browser")).toHaveLength(1);
  });

  it("turns unsafe persisted Browser state back into a blank Browser", () => {
    const out = normalizeRow1Tabs([
      {
        id: "unsafe",
        type: "browser",
        title: "Stale external title",
        url: "javascript://example.com/%0Aalert(1)",
        canvasMode: true,
      },
    ]);
    expect(out.find((tab) => tab.id === "unsafe")).toMatchObject({
      title: "Browser",
      url: "",
      canvasMode: false,
    });
  });

  it("promotes one Changes/Review pair, preserves selection, and drops legacy types", () => {
    const input = [
      {
        id: "c1",
        type: "changes",
        title: "Changes",
        filePath: "src/picked.ts",
        diff: true,
      },
      { id: "c2", type: "changes", title: "Duplicate" },
      { id: "r1", type: "review", title: "Review" },
      { id: "git", type: "git", title: "Git" },
      { id: "terminal", type: "terminal", title: "Terminal" },
    ] as unknown as Column3Tab[];
    const out = normalizeRow1Tabs(input);
    expect(out.find((tab) => tab.type === "changes")).toMatchObject({
      id: "c1",
      pinned: true,
      filePath: "src/picked.ts",
      diff: true,
    });
    expect(out.filter((tab) => tab.type === "changes")).toHaveLength(1);
    expect(out.filter((tab) => tab.type === "review")).toHaveLength(1);
    expect(out.some((tab) => ["git", "terminal"].includes(tab.type))).toBe(
      false,
    );
  });

  it("restores valid nested tab choices and drops corrupt persisted values", () => {
    const out = normalizeRow1Tabs([
      {
        id: "changes-valid",
        type: "changes",
        title: "Changes",
        filePath: "src/a.ts",
        changesView: "tree",
        viewerMode: "diff",
      },
      {
        id: "review-valid",
        type: "review",
        title: "Review",
        reviewSubtab: "checks",
      },
      {
        id: "file-invalid",
        type: "files",
        title: "b.ts",
        filePath: "src/b.ts",
        viewerMode: "sideways",
      } as unknown as Column3Tab,
    ]);

    expect(out.find((tab) => tab.id === "changes-valid")).toMatchObject({
      changesView: "tree",
      viewerMode: "diff",
    });
    expect(out.find((tab) => tab.id === "review-valid")?.reviewSubtab).toBe(
      "checks",
    );
    expect(out.find((tab) => tab.id === "file-invalid")?.viewerMode).toBe(
      undefined,
    );
  });
});

describe("per-worktree scope bounds", () => {
  it("restores independent File-tab tree choices after serialized reload", () => {
    const expanded = {
      ...createFilesTab("src/a.ts"),
      id: "expanded-after-reload",
      fileTreeVisible: true,
    };
    const collapsed = {
      ...createFilesTab("src/b.ts"),
      id: "collapsed-after-reload",
      fileTreeVisible: false,
    };
    const serialized = JSON.parse(
      JSON.stringify({
        "/repo/reload": {
          tabs: [expanded, collapsed],
          activeId: collapsed.id,
          recentBrowsers: [],
        },
      }),
    ) as Column3ScopeMap;

    const restored = migrateScopes(serialized)["/repo/reload"];
    expect(
      restored.tabs
        .filter((tab) => tab.type === "files")
        .map((tab) => [tab.id, tab.fileTreeVisible]),
    ).toEqual([
      ["expanded-after-reload", true],
      ["collapsed-after-reload", false],
    ]);
    expect(restored.activeId).toBe("collapsed-after-reload");
  });

  it("keeps only the newest persisted scope window", () => {
    const scopes = Object.fromEntries(
      Array.from({ length: MAX_PERSISTED_COLUMN3_SCOPES + 12 }, (_, index) => [
        `/scope-${index}`,
        defaultTabs(),
      ]),
    );
    const migrated = migrateScopes(scopes);
    expect(Object.keys(migrated)).toHaveLength(MAX_PERSISTED_COLUMN3_SCOPES);
    expect(migrated["/scope-0"]).toBeUndefined();
    expect(
      migrated[`/scope-${MAX_PERSISTED_COLUMN3_SCOPES + 11}`],
    ).toBeDefined();
  });
});

describe("orderRow1Tabs", () => {
  it("keeps the first File first and system tabs next without pinning browsers", () => {
    const out = orderRow1Tabs([
      { id: "b", type: "browser", title: "Browser", pinned: true },
      { id: "r", type: "review", title: "Review", pinned: true },
      { id: "f2", type: "files", title: "b.ts", filePath: "b.ts" },
      { id: "c", type: "changes", title: "Changes", pinned: true },
      { id: "f1", type: "files", title: "a.ts", filePath: "a.ts" },
    ]);
    expect(out.map((tab) => tab.id)).toEqual(["f2", "c", "r", "b", "f1"]);
    expect(out.find((tab) => tab.id === "b")?.pinned).toBe(false);
  });

  it("keeps the fixed home leading even when listed after other File tabs", () => {
    const out = orderRow1Tabs([
      { id: "f2", type: "files", title: "b.ts", filePath: "b.ts" },
      { id: "c", type: "changes", title: "Changes", pinned: true },
      { id: "r", type: "review", title: "Review", pinned: true },
      {
        id: "home",
        type: "files",
        title: "a.ts",
        filePath: "a.ts",
        fixed: true,
      },
    ]);
    expect(out.map((tab) => tab.id)).toEqual(["home", "c", "r", "f2"]);
  });
});

describe("recent browser history", () => {
  it("deduplicates by URL, refreshes titles, rejects unsafe entries, and caps", () => {
    let entries = recordRecentBrowser(
      [],
      {
        url: "https://example.com/docs",
        title: "Old title",
      },
      1,
    );
    entries = recordRecentBrowser(
      entries,
      {
        url: "https://example.com/docs",
        title: "New title",
      },
      2,
    );
    expect(entries).toEqual([
      {
        url: "https://example.com/docs",
        title: "New title",
        visitedAt: 2,
      },
    ]);
    expect(
      recordRecentBrowser(entries, { url: "file:///etc/passwd", title: "Bad" }),
    ).toBe(entries);
    expect(
      recordRecentBrowser(entries, {
        url: "https://user:secret@example.com",
        title: "Secret",
      }),
    ).toBe(entries);

    const many = Array.from(
      { length: MAX_RECENT_BROWSERS + 5 },
      (_, index) => ({
        url: `https://example.com/${index}`,
        title: `Page ${index}`,
        visitedAt: index,
      }),
    );
    expect(
      normalizeRecentBrowsers([null, { url: "bad" }, ...many]),
    ).toHaveLength(MAX_RECENT_BROWSERS);
  });
});

describe("migrateScopes", () => {
  it("preserves workspace isolation, multi-browser tabs, and recent history", () => {
    const input: Column3ScopeMap = {
      "/repo/main": {
        tabs: [
          { id: "empty", type: "files", title: "Files", pinned: true },
          { id: "b1", type: "browser", title: "Docs", url: "https://x.dev" },
          {
            id: "b2",
            type: "browser",
            title: "App",
            url: "http://localhost:3",
          },
        ],
        activeId: "b2",
        recentBrowsers: [
          { url: "https://x.dev", title: "Docs", visitedAt: 10 },
        ],
      },
      "/repo/feature": {
        tabs: [],
        activeId: null,
        recentBrowsers: [],
      },
    };
    const out = migrateScopes(input);
    expect(
      out["/repo/main"].tabs.filter((tab) => tab.type === "browser"),
    ).toHaveLength(2);
    expect(out["/repo/main"].activeId).toBe("b2");
    expect(out["/repo/main"].recentBrowsers[0].url).toBe("https://x.dev/");
    // Browsers/extra Files stay gone, but the permanent surfaces return —
    // including the fixed Files home a pre-flag slice couldn't have kept.
    expect(out["/repo/feature"].tabs.map((tab) => tab.type)).toEqual([
      "files",
      "changes",
      "review",
    ]);
    expect(out["/repo/feature"].tabs[0].fixed).toBe(true);
  });

  it("falls back to the Files home for a removed/stale active id and drops malformed slices", () => {
    const out = migrateScopes({
      "/stale": {
        tabs: [],
        activeId: "gone",
        recentBrowsers: [],
      },
      "/bad": {
        tabs: undefined as unknown as Column3Tab[],
        activeId: null,
        recentBrowsers: [],
      },
      "/null": null as unknown as Column3ScopeState,
    });
    expect(out["/stale"].activeId).toBe(out["/stale"].tabs[0].id);
    expect(out["/stale"].tabs[0]).toMatchObject({ type: "files", fixed: true });
    expect(out["/bad"]).toBeUndefined();
    expect(out["/null"]).toBeUndefined();
  });
});
