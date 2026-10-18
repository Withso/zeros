import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => null,
  onActiveBridgeChange: () => () => {},
}));

import {
  DESIGN_AGENT_DRAFT_IDLE_MS,
  DESIGN_AGENT_DRAFT_SAVED_MS,
  designAgentDraftsByFile,
  designAgentStylesheetPreviews,
  receiveDesignAgentDraft,
  resetDesignAgentDraftsForTests,
  retireDesignAgentDraft,
  setDesignAgentFollowing,
  sweepDesignAgentDrafts,
  useDesignAgentDraftStore,
  useDesignAgentFollowStore,
} from "../state/design-agent-drafts";
import {
  designAgentDraftLabel,
  designAgentDraftRetireAt,
  designAgentDraftThemeDocument,
  designAgentGhostLayout,
  designAgentGhostRects,
  designAgentRevealTarget,
} from "../design-agent-drafts";

const draft = (overrides: Record<string, unknown> = {}) => ({
  id: "draft1",
  chatId: "chat-1",
  directory: "App - Design",
  file: "page-1/card.html",
  operation: "write",
  phase: "writing",
  revision: 1,
  preview: { srcDoc: "<html><body>one</body></html>", width: 390, height: 844, title: "Card" },
  ...overrides,
});
const drafts = (workspaceId = "ws_local") =>
  useDesignAgentDraftStore.getState().byWorkspace[workspaceId] ?? {};

afterEach(() => resetDesignAgentDraftsForTests());

describe("Design agent draft store", () => {
  it("keeps the newest revision and its last preview through preview-less phases", () => {
    receiveDesignAgentDraft("ws_local", draft(), 10);
    receiveDesignAgentDraft("ws_local", draft({ revision: 3, phase: "saving", preview: undefined }), 20);
    // A late lower revision never replaces a newer one.
    receiveDesignAgentDraft("ws_local", draft({ revision: 2, preview: { srcDoc: "stale", width: 1, height: 1 } }), 30);
    expect(drafts().draft1).toMatchObject({
      draft: { revision: 3, phase: "saving" },
      preview: { srcDoc: "<html><body>one</body></html>" },
      updatedAt: 20,
      savedAt: null,
    });
    receiveDesignAgentDraft("ws_local", draft({ revision: 4, phase: "saved", preview: undefined }), 40);
    expect(drafts().draft1).toMatchObject({ savedAt: 40, preview: { srcDoc: "<html><body>one</body></html>" } });
  });

  it("removes an unsaved discarded draft but keeps a saved one for its hand-off", () => {
    receiveDesignAgentDraft("ws_local", draft(), 10);
    receiveDesignAgentDraft("ws_local", draft({ revision: 2, phase: "discarded", preview: undefined }), 20);
    expect(drafts().draft1).toBeUndefined();
    receiveDesignAgentDraft("ws_local", draft({ id: "draft2" }), 30);
    receiveDesignAgentDraft("ws_local", draft({ id: "draft2", revision: 2, phase: "saved", preview: undefined }), 40);
    receiveDesignAgentDraft("ws_local", draft({ id: "draft2", revision: 3, phase: "discarded", preview: undefined }), 50);
    expect(drafts().draft2).toMatchObject({ savedAt: 40 });
    retireDesignAgentDraft("ws_local", "draft2");
    expect(useDesignAgentDraftStore.getState().byWorkspace).toEqual({});
  });

  it("ignores cloud workspaces and malformed or oversized drafts", () => {
    receiveDesignAgentDraft("cloud://org/workspace", draft());
    receiveDesignAgentDraft("ws_local", draft({ id: "../escape" }));
    receiveDesignAgentDraft("ws_local", draft({ phase: "applied" }));
    receiveDesignAgentDraft("ws_local", draft({ preview: { srcDoc: "x".repeat(8 * 1024 * 1024 + 1), width: 1, height: 1 } }));
    receiveDesignAgentDraft(42, draft());
    expect(useDesignAgentDraftStore.getState().byWorkspace).toEqual({});
  });

  it("bounds drafts per workspace and releases the oldest previews first", () => {
    for (let index = 0; index < 8; index += 1)
      receiveDesignAgentDraft("ws_local", draft({ id: `d${index}`, file: `page-1/f${index}.html` }), index);
    expect(Object.keys(drafts()).sort()).toEqual(["d2", "d3", "d4", "d5", "d6", "d7"]);
    const large = "x".repeat(7 * 1024 * 1024);
    for (let index = 0; index < 4; index += 1)
      receiveDesignAgentDraft(`ws_${index}`, draft({ preview: { srcDoc: large, width: 1, height: 1 } }), 100 + index);
    const previews = [0, 1, 2, 3].map((index) => drafts(`ws_${index}`).draft1?.preview !== null);
    expect(previews).toEqual([false, true, true, true]);
  });

  it("expires drafts whose engine went quiet or whose save was never handed off", () => {
    receiveDesignAgentDraft("ws_local", draft(), 0);
    receiveDesignAgentDraft("ws_local", draft({ id: "saved", revision: 1, phase: "saved" }), 0);
    sweepDesignAgentDrafts(DESIGN_AGENT_DRAFT_SAVED_MS + 1);
    expect(Object.keys(drafts())).toEqual(["draft1"]);
    sweepDesignAgentDrafts(DESIGN_AGENT_DRAFT_IDLE_MS + 1);
    expect(useDesignAgentDraftStore.getState().byWorkspace).toEqual({});
  });

  it("shows only the newest draft per file of the canvas directory", () => {
    receiveDesignAgentDraft("ws_local", draft({ id: "older" }), 10);
    receiveDesignAgentDraft("ws_local", draft({ id: "newer" }), 20);
    receiveDesignAgentDraft("ws_local", draft({ id: "other", directory: "Other - Design" }), 30);
    const byFile = designAgentDraftsByFile(drafts(), "App - Design");
    expect([...byFile.entries()].map(([file, entry]) => [file, entry.draft.id])).toEqual([
      ["page-1/card.html", "newer"],
    ]);
    expect(designAgentDraftsByFile(drafts(), undefined).size).toBe(0);
  });
});

describe("Design agent draft presentation helpers", () => {
  it("applies the canvas theme as the document attribute without script", () => {
    expect(designAgentDraftThemeDocument('<!doctype html><html lang="en" data-zd-theme="dark"><body></body></html>', "light")).toBe(
      '<!doctype html><html lang="en" data-zd-theme="light"><body></body></html>',
    );
    expect(designAgentDraftThemeDocument("<!doctype html><body>x</body>", "dark")).toBe(
      '<!doctype html><html data-zd-theme="dark"><body>x</body>',
    );
    expect(designAgentDraftThemeDocument("<html><body></body></html>", 'x" onload="alert(1)')).toBe(
      "<html><body></body></html>",
    );
    expect(designAgentDraftThemeDocument("<html></html>", null)).toBe("<html></html>");
  });

  it("places unregistered drafts right of the page's frames, top-aligned", () => {
    expect(
      designAgentGhostRects(
        [
          { x: 0, y: 40, width: 390, height: 844 },
          { x: 500, y: 0, width: 1440, height: 900 },
        ],
        [
          { width: 390, height: 844 },
          { width: 800, height: 600 },
        ],
      ),
    ).toEqual([
      { x: 2100, y: 0, width: 390, height: 844 },
      { x: 2650, y: 0, width: 800, height: 600 },
    ]);
    expect(designAgentGhostRects([], [{ width: 10, height: 10 }])).toEqual([{ x: 0, y: 0, width: 10, height: 10 }]);
  });

  it("places a ghost where the in-flight canvas registers it, and keeps that through later phases", () => {
    const pages = [{ id: "page_1", title: "Page 1", folder: "page-1", frameFiles: ["page-1/home.html"] }] as never;
    const frames = [{ x: 0, y: 0, width: 1440, height: 900 }];
    receiveDesignAgentDraft("ws_local", draft({ id: "card", file: "page-1/card.html" }), 1_000);
    receiveDesignAgentDraft("ws_local", draft({ id: "list", file: "page-1/list.html" }), 2_000);
    receiveDesignAgentDraft(
      "ws_local",
      draft({
        id: "canvas",
        file: "meta/canvas.json",
        operation: "edit",
        preview: undefined,
        registrations: [{ file: "page-1/card.html", x: 2000, y: 300, width: 400, height: 800, title: "Checkout card" }],
      }),
      3_000,
    );
    // A preview-less phase update keeps the placements it already sent.
    receiveDesignAgentDraft("ws_local", draft({ id: "canvas", file: "meta/canvas.json", operation: "edit", phase: "saving", revision: 2, preview: undefined }), 4_000);
    const layout = designAgentGhostLayout(drafts(), "App - Design", pages, "page_1", frames);
    expect(layout.map(({ entry, rect, title }) => ({ file: entry.draft.file, rect, title }))).toEqual([
      { file: "page-1/card.html", rect: { x: 2000, y: 300, width: 400, height: 800 }, title: "Checkout card" },
      // Unplaced ghosts follow the frames and the placed ghosts.
      { file: "page-1/list.html", rect: { x: 2560, y: 0, width: 390, height: 844 }, title: "Card" },
    ]);
    // Another directory's canvas never places this directory's ghosts.
    expect(designAgentGhostLayout(drafts(), "Other - Design", pages, "page_1", frames)).toEqual([]);
  });
});

describe("Design agent activity chip", () => {
  const pages = [
    { id: "page_1", title: "Page 1", folder: "page-1", frameFiles: ["page-1/home.html", "page-1/card.html"] },
    { id: "page_2", title: "Checkout", folder: "checkout", frameFiles: ["checkout/pay.html"] },
  ] as never;
  const frames = [
    { file: "page-1/home.html", title: "Home", x: 0, y: 0, width: 1440, height: 900 },
    { file: "page-1/card.html", title: "Card", x: 1600, y: 0, width: 390, height: 844 },
  ];
  const entry = (overrides: Record<string, unknown>, savedAt: number | null = null) => ({
    draft: draft(overrides) as never,
    preview: null,
    registrations: null,
    stylesheet: null,
    updatedAt: 1,
    savedAt,
    ...("registrations" in overrides ? { registrations: overrides.registrations as never } : {}),
  });
  const ghost = {
    entry: entry({ file: "page-1/new.html" }),
    rect: { x: 2100, y: 0, width: 390, height: 844 },
    title: "New card",
  };
  const context = { pages, activePageId: "page_1", frames, ghosts: [ghost] };

  it("shows a frame on its page, a ghost where it sits, and a stylesheet's frames", () => {
    const placements = new Map([
      ["page-1/new.html", { file: "page-1/new.html", x: 2100, y: 0, width: 390, height: 844 }],
      ["checkout/more.html", { file: "checkout/more.html", x: 0, y: 0, width: 10, height: 10 }],
    ]);
    expect(designAgentRevealTarget(entry({ file: "page-1/card.html" }), context, placements)).toEqual({
      pageId: "page_1",
      files: ["page-1/card.html"],
      rects: [],
    });
    // A frame registered on another page switches to that page.
    expect(designAgentRevealTarget(entry({ file: "checkout/pay.html" }), context, placements)).toEqual({
      pageId: "page_2",
      files: ["checkout/pay.html"],
      rects: [],
    });
    expect(designAgentRevealTarget(entry({ file: "page-1/new.html" }), context, placements)).toEqual({
      pageId: "page_1",
      files: [],
      rects: [ghost.rect],
    });
    // tokens.css affects the active page; a page stylesheet, its own page.
    expect(designAgentRevealTarget(entry({ file: "tokens.css" }), context, placements)).toEqual({
      pageId: "page_1",
      files: ["page-1/home.html", "page-1/card.html"],
      rects: [],
    });
    expect(designAgentRevealTarget(entry({ file: "checkout/page.css" }), context, placements)?.pageId).toBe("page_2");
    // The canvas document shows the frames it places on this page.
    expect(designAgentRevealTarget(entry({ file: "meta/canvas.json" }), context, placements)).toEqual({
      pageId: "page_1",
      files: [],
      rects: [{ file: "page-1/new.html", x: 2100, y: 0, width: 390, height: 844 }],
    });
    expect(designAgentRevealTarget(entry({ file: "rules.md" }), context, placements)).toBeNull();
    expect(designAgentRevealTarget(entry({ file: "page-1/unknown.html" }), context, placements)).toBeNull();
  });

  it("names drafts as the canvas does", () => {
    expect(designAgentDraftLabel(entry({ file: "page-1/card.html" }), context)).toBe("Card");
    expect(designAgentDraftLabel(entry({ file: "page-1/new.html" }), context)).toBe("New card");
    expect(designAgentDraftLabel(entry({ file: "meta/canvas.json" }), context)).toBe("Canvas layout");
    expect(designAgentDraftLabel(entry({ file: "tokens.css" }), context)).toBe("tokens.css");
  });

  it("retires saved drafts nothing on this canvas hands off, and only those", () => {
    // Streaming drafts and this page's frames and ghosts hand off themselves.
    expect(designAgentDraftRetireAt(entry({ file: "tokens.css" }), context)).toBeNull();
    expect(designAgentDraftRetireAt(entry({ file: "page-1/card.html" }, 1_000), context)).toBeNull();
    expect(designAgentDraftRetireAt(entry({ file: "page-1/new.html" }, 1_000), context)).toBeNull();
    // Stylesheets, other files and other pages' frames linger briefly.
    expect(designAgentDraftRetireAt(entry({ file: "tokens.css" }, 1_000), context)).toBe(2_500);
    expect(designAgentDraftRetireAt(entry({ file: "rules.md" }, 1_000), context)).toBe(2_500);
    expect(designAgentDraftRetireAt(entry({ file: "checkout/pay.html" }, 1_000), context)).toBe(2_500);
    // The canvas document waits until every frame it placed is registered.
    const placing = entry({ file: "meta/canvas.json", registrations: [{ file: "page-1/new.html", x: 0, y: 0, width: 1, height: 1 }] }, 1_000);
    expect(designAgentDraftRetireAt(placing, context)).toBe(7_000);
    const registered = { ...context, pages: [{ ...(pages as never as Array<Record<string, unknown>>)[0], frameFiles: ["page-1/home.html", "page-1/new.html"] }] as never };
    expect(designAgentDraftRetireAt(placing, registered)).toBe(2_500);
  });

  it("keeps each stylesheet's newest text and whether it was saved", () => {
    receiveDesignAgentDraft("ws_local", draft({ id: "css", file: "tokens.css", preview: undefined, stylesheet: { css: ":root{--a:1}" } }), 1_000);
    receiveDesignAgentDraft("ws_local", draft({ id: "css", file: "tokens.css", phase: "saved", revision: 2, preview: undefined }), 2_000);
    receiveDesignAgentDraft("ws_local", draft({ id: "frame", file: "page-1/card.html" }), 3_000);
    expect([...designAgentStylesheetPreviews(drafts(), "App - Design")]).toEqual([
      ["tokens.css", { css: ":root{--a:1}", saved: true }],
    ]);
    expect(designAgentStylesheetPreviews(drafts(), "Other - Design").size).toBe(0);
  });

  it("follows per workspace, in memory", () => {
    setDesignAgentFollowing("ws_local", true);
    setDesignAgentFollowing("ws_local", true);
    expect(useDesignAgentFollowStore.getState().following).toEqual({ ws_local: true });
    setDesignAgentFollowing("ws_local", false);
    expect(useDesignAgentFollowStore.getState().following).toEqual({});
  });
});
