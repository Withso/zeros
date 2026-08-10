import { describe, expect, it } from "vitest";

import {
  planBrowserOpen,
  planBrowserSessionOpen,
  shouldRevealBrowserSession,
} from "../use-open-browser";
import { createBrowserTab, type WorkbenchTab } from "../tab-model";

function filesTab(): WorkbenchTab {
  return {
    id: "files-home",
    type: "files",
    title: "Open file",
    fixed: true,
  };
}

describe("planBrowserOpen", () => {
  it("focuses an exact existing page instead of creating a duplicate", () => {
    const browser = createBrowserTab({
      url: "https://example.com/docs",
      title: "Docs",
    });

    expect(
      planBrowserOpen([filesTab(), browser], "files-home", {
        url: "https://example.com/docs",
      }),
    ).toEqual({ type: "ACTIVATE_WORKBENCH_TAB", id: browser.id });
  });

  it("creates a canonical Browser tab for a new safe page", () => {
    const action = planBrowserOpen([filesTab()], "files-home", {
      url: "https://example.com",
      title: "Example",
    });

    expect(action).toMatchObject({
      type: "ADD_WORKBENCH_TAB",
      tab: {
        type: "browser",
        title: "Example",
        url: "https://example.com/",
      },
    });
  });

  it("reveals the active or most-recent Browser for a shortcut open", () => {
    const first = createBrowserTab({ url: "https://one.example" });
    const latest = createBrowserTab({ url: "https://two.example" });
    const tabs = [filesTab(), first, latest];

    expect(planBrowserOpen(tabs, first.id)).toEqual({
      type: "ACTIVATE_WORKBENCH_TAB",
      id: first.id,
    });
    expect(planBrowserOpen(tabs, "files-home")).toEqual({
      type: "ACTIVATE_WORKBENCH_TAB",
      id: latest.id,
    });
  });

  it("rejects non-web, credentialed, and oversized URLs", () => {
    expect(
      planBrowserOpen([], null, { url: "javascript:alert(1)" }),
    ).toBeNull();
    expect(
      planBrowserOpen([], null, {
        url: "https://user:secret@example.com/private",
      }),
    ).toBeNull();
    expect(
      planBrowserOpen([], null, { url: `https://example.com/${"x".repeat(8192)}` }),
    ).toBeNull();
  });
});

describe("planBrowserSessionOpen", () => {
  it("reveals the first valid native Codex page even without the legacy open tool", () => {
    expect(
      shouldRevealBrowserSession({
        activeChat: true,
        hasTaskTab: false,
        url: "https://example.com/",
        status: "ready",
        tool: undefined,
      }),
    ).toBe(true);
    expect(
      shouldRevealBrowserSession({
        activeChat: true,
        hasTaskTab: true,
        url: "https://example.com/next",
        status: "working",
        tool: "Page.navigate",
      }),
    ).toBe(false);
  });

  it("creates and activates a browser tab bound to the agent task", () => {
    const actions = planBrowserSessionOpen([], {
      taskId: "session-1",
      url: "https://example.com/path",
      title: "Example",
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "ADD_WORKBENCH_TAB",
      tab: {
        type: "browser",
        url: "https://example.com/path",
        title: "Example",
        browserSessionId: "session-1",
      },
    });
  });

  it("reuses the exact task-bound tab and refreshes its metadata", () => {
    const existing = createBrowserTab({
      browserSessionId: "session-1",
      url: "https://old.example/",
    });
    const actions = planBrowserSessionOpen([existing], {
      taskId: "session-1",
      url: "https://example.com/next",
      title: "Next",
    });

    expect(actions).toEqual([
      {
        type: "UPDATE_WORKBENCH_TAB",
        id: existing.id,
        updates: {
          url: "https://example.com/next",
          title: "Next",
        },
      },
      { type: "ACTIVATE_WORKBENCH_TAB", id: existing.id },
    ]);
  });

  it("updates background browser metadata without stealing focus", () => {
    const existing = createBrowserTab({
      browserSessionId: "session-1",
      url: "https://old.example/",
    });
    expect(
      planBrowserSessionOpen([existing], {
        taskId: "session-1",
        url: "https://example.com/next",
        title: "Next",
        activate: false,
      }),
    ).toEqual([
      {
        type: "UPDATE_WORKBENCH_TAB",
        id: existing.id,
        updates: {
          url: "https://example.com/next",
          title: "Next",
        },
      },
    ]);
  });

  it("rejects malformed task ids and non-web URLs", () => {
    expect(
      planBrowserSessionOpen([], {
        taskId: "bad/task",
        url: "file:///tmp/private",
        title: "Nope",
      }),
    ).toEqual([]);
  });
});
