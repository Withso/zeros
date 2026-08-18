import { describe, expect, it } from "vitest";

import { planBrowserOpen } from "../use-open-browser";
import { createBrowserTab, type WorkbenchTab } from "../tab-model";

const filesTab = (): WorkbenchTab => ({
  id: "files-home",
  type: "files",
  title: "Open file",
  fixed: true,
});

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
    expect(
      planBrowserOpen([filesTab()], "files-home", {
        url: "https://example.com",
        title: "Example",
      }),
    ).toMatchObject({
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
      planBrowserOpen([], null, {
        url: `https://example.com/${"x".repeat(8192)}`,
      }),
    ).toBeNull();
  });
});
