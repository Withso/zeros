import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tabs, TabsContent } from "../../../shared/ui/primitives";
import {
  designInspectorActiveTab,
  designInspectorPanelState,
  designInspectorSelectionKind,
  designInspectorSimilarTabKey,
  designInspectorTabForSelection,
  designInspectorTabKey,
  designInspectorTabs,
  rememberDesignInspectorSelectionTab,
  rememberDesignInspectorTab,
} from "../design-inspector";

describe("component inspector tab ownership", () => {
  const owner = {
    workspaceId: "workspace-a",
    directoryId: "design-a",
    pageId: "page-a",
    frameFile: "components/button.html",
    selection: ["button-instance"],
  };

  it("keeps choices scoped to the exact workspace, directory, page, frame and selection", () => {
    const key = designInspectorTabKey(owner);
    expect(designInspectorTabKey(owner)).toBe(key);
    for (const change of [
      { workspaceId: "workspace-b" },
      { directoryId: "design-b" },
      { pageId: "page-b" },
      { frameFile: "components/card.html" },
      { selection: ["other-instance"] },
    ]) {
      expect(designInspectorTabKey({ ...owner, ...change })).not.toBe(key);
    }

    const preferences = new Map<string, "options" | "style" | "css">();
    const otherOwner = designInspectorTabKey({ ...owner, workspaceId: "workspace-b" });
    rememberDesignInspectorTab(preferences, key, "css");
    rememberDesignInspectorTab(preferences, otherOwner, "style");
    expect(preferences.get(key)).toBe("css");
    expect(preferences.get(otherOwner)).toBe("style");
  });

  it("refreshes recency and keeps preference state bounded", () => {
    const preferences = new Map<string, "options" | "style" | "css">();
    for (let index = 0; index < 32; index += 1) {
      rememberDesignInspectorTab(preferences, `owner-${index}`, "style");
    }
    rememberDesignInspectorTab(preferences, "owner-0", "css");
    rememberDesignInspectorTab(preferences, "owner-32", "options");
    expect(preferences.size).toBe(32);
    expect(preferences.has("owner-0")).toBe(true);
    expect(preferences.has("owner-1")).toBe(false);
    expect(preferences.get("owner-0")).toBe("css");
  });

  const none = { count: 1, mainRoot: false, mainLayer: false, instance: false, inner: false };
  it("knows each selection's kind from component evidence, not a selected node id", () => {
    expect(designInspectorSelectionKind(none)).toBe("ordinary");
    expect(designInspectorSelectionKind({ ...none, mainRoot: true })).toBe("main-root");
    expect(designInspectorSelectionKind({ ...none, mainLayer: true })).toBe("main-layer");
    expect(designInspectorSelectionKind({ ...none, instance: true })).toBe("instance");
    expect(designInspectorSelectionKind({ ...none, inner: true })).toBe("component-inner");
    expect(designInspectorSelectionKind({ ...none, count: 3 })).toBe("ordinary");
    expect(designInspectorSelectionKind({ ...none, count: 2, instance: true })).toBe("instances");
    expect(designInspectorSelectionKind({ ...none, count: 2, instance: true, inner: true })).toBe("component-inner-many");
  });

  it("offers the tabs each selection has, Controls first on a main", () => {
    expect(designInspectorTabs("ordinary")).toEqual(["style", "css"]);
    expect(designInspectorTabs("main-root")).toEqual(["options", "style"]);
    expect(designInspectorTabs("main-layer")).toEqual(["style"]);
    expect(designInspectorTabs("instance")).toEqual(["options"]);
    expect(designInspectorTabs("component-inner")).toEqual(["options"]);
    expect(designInspectorTabs("instances")).toEqual(["style"]);
    expect(designInspectorTabs("component-inner-many")).toEqual([]);
  });

  it("falls back to the selection's default when a stored tab no longer applies", () => {
    expect(designInspectorActiveTab("main-root", null)).toBe("options");
    expect(designInspectorActiveTab("main-root", "style")).toBe("style");
    expect(designInspectorActiveTab("main-root", "css")).toBe("options");
    expect(designInspectorActiveTab("main-layer", "css")).toBe("style");
    expect(designInspectorActiveTab("instance", "style")).toBe("options");
    expect(designInspectorActiveTab("component-inner", "css")).toBe("options");
    expect(designInspectorActiveTab("ordinary", "css")).toBe("css");
    expect(designInspectorActiveTab("ordinary", "options")).toBe("style");
    expect(designInspectorActiveTab("component-inner-many", "style")).toBeNull();
  });

  it("reuses a bounded owner-and-kind preference without replacing exact target choices", () => {
    const preferences = new Map<string, "options" | "style" | "css">();
    const exactA = designInspectorTabKey({ ...owner, selection: ["component-a"] });
    const exactB = designInspectorTabKey({ ...owner, frameFile: "components/card.html", selection: ["component-b"] });
    const similarRoot = designInspectorSimilarTabKey({ workspaceId: owner.workspaceId, directoryId: owner.directoryId }, "main-root");

    rememberDesignInspectorSelectionTab(preferences, exactA, similarRoot, "style");
    expect(designInspectorTabForSelection(preferences, exactB, similarRoot)).toBe("style");
    rememberDesignInspectorSelectionTab(preferences, exactB, similarRoot, "options");
    expect(designInspectorTabForSelection(preferences, exactA, similarRoot)).toBe("style");
    expect(designInspectorTabForSelection(preferences, exactB, similarRoot)).toBe("options");

    const otherOwner = { ...owner, workspaceId: "workspace-b" };
    const otherExact = designInspectorTabKey({ ...otherOwner, selection: ["component-c"] });
    expect(designInspectorTabForSelection(preferences, otherExact, designInspectorSimilarTabKey(otherOwner, "main-root"))).toBeNull();

    const exactLayer = designInspectorTabKey({ ...owner, selection: ["inner-layer"] });
    expect(designInspectorTabForSelection(preferences, exactLayer, designInspectorSimilarTabKey(owner, "main-layer"))).toBeNull();
  });

  it("keeps inactive retained panels mounted but inert and hidden", () => {
    const panel = designInspectorPanelState("options", "style");
    const contentProps = {
      value: "style",
      forceMount: true,
      inert: panel.inert ? "" : undefined,
      "aria-hidden": panel.ariaHidden,
      "data-design-style-panel": "",
    } as ComponentProps<typeof TabsContent> & { inert?: "" };
    const markup = renderToStaticMarkup(createElement(
      Tabs,
      { value: "options" },
      createElement(TabsContent, contentProps, "retained style content"),
    ));
    expect(panel.active).toBe(false);
    expect(markup).toContain('data-design-style-panel=""');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("inert");
  });
});
