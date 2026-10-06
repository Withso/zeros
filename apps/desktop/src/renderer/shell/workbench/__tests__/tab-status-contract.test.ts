import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveBridge } from "../../../platform/bridge/active-bridge";
import { resetWorkbenchAvailabilityForTests } from "../../../state/workbench-availability";
import { WorkbenchTabContent } from "../tab-content";
import { TAB_TYPE_META, type WorkbenchTabType } from "../tab-model";
import { workbenchSourcesFor, workbenchStatusKey } from "../tab-status-model";

const hooks = vi.hoisted(() => ({ target: vi.fn(), filter: vi.fn() }));
vi.mock("../tabs/changes-tab", () => ({
  useSourceTarget: () => {
    hooks.target();
    return {};
  },
}));
vi.mock("../tabs/changes-filter-store", () => ({
  useChangesFilter: () => {
    hooks.filter();
    return {};
  },
}));

// The map's frame must work even when a future body provides no status UI.
vi.mock("../tabs/files-tab", () => ({ FilesTab: () => null }));
vi.mock("../tabs/changes-surface", () => ({
  ChangesWorkbenchSurface: () => null,
}));
vi.mock("../tabs/review-surface", () => ({ ReviewSurface: () => null }));
vi.mock("../tabs/browser-tab", () => ({ BrowserTab: () => null }));

describe("every WorkbenchTabType enters the status frame", () => {
  afterEach(() => {
    resetWorkbenchAvailabilityForTests();
    setActiveBridge(null);
  });
  it.each(Object.keys(TAB_TYPE_META) as WorkbenchTabType[])(
    "structurally supplies %s with one banner and neutral empty state",
    (type) => {
      hooks.target.mockClear();
      hooks.filter.mockClear();
      setActiveBridge({
        status: "connected",
        onStatusChange: () => () => {},
      } as never);
      const tab = { id: type, type, title: type };
      const sources = workbenchSourcesFor(workbenchStatusKey("/contract", tab));
      sources.update("fixture", {
        primary: true,
        pending: false,
        error: new Error("bridge request failed"),
      });
      const markup = renderToStaticMarkup(
        createElement(WorkbenchTabContent, {
          tab,
          active: true,
          scope: "/contract",
        }),
      );
      expect(markup.match(/data-workbench-banner=/g)).toHaveLength(1);
      expect(markup.match(/data-workbench-empty=/g)).toHaveLength(1);
      expect(markup).toContain(`data-workbench-frame="${type}"`);
      expect(markup).toContain("text-fg2");
      expect(markup.match(/<button/g)).toHaveLength(1);
      if (type === "changes" || type === "review")
        expect(hooks.target).toHaveBeenCalled();
      else expect(hooks.target).not.toHaveBeenCalled();
      if (type === "changes") expect(hooks.filter).toHaveBeenCalled();
      else expect(hooks.filter).not.toHaveBeenCalled();
      sources.remove("fixture");
    },
  );
});
