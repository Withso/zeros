import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveBridge } from "../../../platform/bridge/active-bridge";
import { resetWorkbenchAvailabilityForTests } from "../../../state/workbench-availability";
import { WorkbenchTabContent } from "../tab-content";
import { TAB_TYPE_META, type WorkbenchTabType } from "../tab-model";
import { workbenchSourcesFor, workbenchStatusKey } from "../tab-status-model";

const hooks = vi.hoisted(() => ({ target: vi.fn(), filter: vi.fn(), history: vi.fn(() => null),
  workspace: null as { id: string; placement: string; path: string } | null }));
vi.mock("../../pr/cloud-history-notice", () => ({ CloudHistoryNotice: hooks.history }));
vi.mock("../tabs/changes-tab", () => ({
  useSourceTarget: () => {
    hooks.target();
    return { workspace: hooks.workspace };
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
    hooks.workspace = null;
    hooks.history.mockClear();
    resetWorkbenchAvailabilityForTests();
    setActiveBridge(null);
  });
  it.each(["changes", "review"] as const)("mounts the %s history source only for cloud workspaces", type => {
    const tab = { id: type, type, title: type };
    for (const placement of ["local", "cloud"]) {
      hooks.workspace = { id: "history-workspace", path: "/history", placement };
      hooks.history.mockClear();
      const markup = renderToStaticMarkup(createElement(WorkbenchTabContent, { tab, active: true, scope: "/history" }));
      expect(markup.match(/data-workbench-banner=/g)).toHaveLength(1);
      expect(hooks.history).toHaveBeenCalledTimes(placement === "cloud" ? 1 : 0);
      expect(markup).not.toContain("Shallow Git history");
    }
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
