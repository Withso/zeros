// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { TooltipProvider } from "../../../shared/ui/primitives";
import { DesignAutoLayoutControls } from "../design-auto-layout-controls";
import { publishDesignLivePreviewStyles, resetDesignLivePreviewForTests } from "../state/design-live-preview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  resetDesignLivePreviewForTests();
});

const details = {
  sourceVersion: "a".repeat(24), oid: "button", tag: "button", visible: true, breadcrumb: [],
  rect: { x: 0, y: 0, width: 143, height: 40 },
  styles: { display: "inline-flex", width: "143px", height: "40px", position: "static" },
  layout: { parentId: "frame", parentDisplay: "flex", parentFlexDirection: "column", widthValue: "max-content", heightValue: "auto", x: 0, y: 0 },
} as unknown as DesignRuntimeNodeDetails;

it("reads a pending sizing preview's mode from its previewed size", () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(React.createElement(TooltipProvider, null, React.createElement(DesignAutoLayoutControls, {
    details,
    livePreviewOwner: { workspaceId: "w", frame: "home.html", nodeId: "button" },
    renderField: () => null,
    onAction: () => {},
    onCommit: () => {},
  } as never))));
  const sizing = () => host.querySelector('[aria-label^="Width sizing: "]')?.getAttribute("aria-label");
  expect(sizing()).toBe("Width sizing: Hug");
  act(() => { publishDesignLivePreviewStyles("w", "home.html", "button", { width: "210px" }); });
  expect(sizing()).toBe("Width sizing: Fixed");
});
