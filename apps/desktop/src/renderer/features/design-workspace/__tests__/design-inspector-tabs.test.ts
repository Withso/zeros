import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tabs, TabsContent } from "../../../shared/ui/primitives";
import {
  designInspectorCssStateMismatch,
  designInspectorDefaultTab,
  designInspectorPanelState,
  designInspectorTabKey,
  rememberDesignInspectorTab,
} from "../design-inspector";
import * as designInspector from "../design-inspector";

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

  it("defaults component roots to Options and other selections to Style", () => {
    expect(designInspectorDefaultTab(true)).toBe("options");
    expect(designInspectorDefaultTab(false)).toBe("style");
  });

  it("reuses a bounded owner-and-kind preference without replacing exact target choices", () => {
    const api = designInspector as unknown as {
      designInspectorSimilarTabKey?: (owner: { workspaceId: string | null; directoryId: string | undefined }, kind: string) => string;
      designInspectorTabForSelection?: (preferences: Map<string, "options" | "style" | "css">, exactKey: string, similarKey: string) => "options" | "style" | "css" | null;
      rememberDesignInspectorSelectionTab?: (preferences: Map<string, "options" | "style" | "css">, exactKey: string, similarKey: string, value: "options" | "style" | "css") => void;
      designInspectorTabPreferenceKind?: (hasOptionsTarget: boolean, componentContext: boolean) => string;
    };
    const preferenceKey = (kind: string) =>
      api.designInspectorSimilarTabKey?.({ workspaceId: owner.workspaceId, directoryId: owner.directoryId }, kind)
      ?? JSON.stringify(["similar", owner.workspaceId, owner.directoryId, kind]);
    const remember = api.rememberDesignInspectorSelectionTab
      ?? ((preferences: Map<string, "options" | "style" | "css">, exactKey: string, _similarKey: string, value: "options" | "style" | "css") => rememberDesignInspectorTab(preferences, exactKey, value));
    const forSelection = api.designInspectorTabForSelection
      ?? ((preferences: Map<string, "options" | "style" | "css">, exactKey: string) => preferences.get(exactKey) ?? null);
    const preferences = new Map<string, "options" | "style" | "css">();
    const exactA = designInspectorTabKey({ ...owner, selection: ["component-a"] });
    const exactB = designInspectorTabKey({ ...owner, frameFile: "components/card.html", selection: ["component-b"] });
    const similarRoot = preferenceKey("component-root");

    expect(api.designInspectorTabPreferenceKind?.(true, true)).toBe("component-root");
    expect(api.designInspectorTabPreferenceKind?.(false, true)).toBe("component-inner");
    expect(api.designInspectorTabPreferenceKind?.(false, false)).toBe("ordinary");

    remember(preferences, exactA, similarRoot, "style");
    expect(forSelection(preferences, exactB, similarRoot)).toBe("style");
    remember(preferences, exactB, similarRoot, "css");
    expect(forSelection(preferences, exactA, similarRoot)).toBe("style");
    expect(forSelection(preferences, exactB, similarRoot)).toBe("css");

    const otherOwner = { ...owner, workspaceId: "workspace-b" };
    const otherExact = designInspectorTabKey({ ...otherOwner, selection: ["component-c"] });
    const otherSimilar = api.designInspectorSimilarTabKey?.(otherOwner, "component-root")
      ?? JSON.stringify(["similar", otherOwner.workspaceId, otherOwner.directoryId, "component-root"]);
    expect(forSelection(preferences, otherExact, otherSimilar)).toBeNull();

    const innerKind = api.designInspectorTabPreferenceKind?.(false, true);
    const innerSimilar = preferenceKey(innerKind ?? "component-inner");
    const exactInner = designInspectorTabKey({ ...owner, selection: ["inner-layer"] });
    expect(forSelection(preferences, exactInner, innerSimilar)).toBeNull();
    expect(designInspectorDefaultTab(false)).toBe("style");
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

  it("gates Base CSS on interaction-state context, not a named option preset", () => {
    expect(designInspectorCssStateMismatch(null)).toBe(false);
    expect(designInspectorCssStateMismatch("hover")).toBe(true);
  });
});
