import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => null,
  onActiveBridgeChange: () => () => {},
}));

import {
  DESIGN_AGENT_DRAFT_IDLE_MS,
  DESIGN_AGENT_DRAFT_SAVED_MS,
  designAgentDraftsByFile,
  receiveDesignAgentDraft,
  resetDesignAgentDraftsForTests,
  retireDesignAgentDraft,
  sweepDesignAgentDrafts,
  useDesignAgentDraftStore,
} from "../state/design-agent-drafts";
import {
  designAgentDraftThemeDocument,
  designAgentGhostRects,
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
});
