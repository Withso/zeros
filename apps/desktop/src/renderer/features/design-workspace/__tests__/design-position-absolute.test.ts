// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import type { DesignLayoutFieldOptions } from "../design-layout-values";
import { DesignPositionSection } from "../design-layout-controls";
import { DesignLayerRowIcon } from "../design-workspace-sidebar-panels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function layer(oid: string, position: string, parentDisplay = "flex"): DesignRuntimeNodeDetails {
  return {
    sourceVersion: "a".repeat(24),
    oid,
    tag: "div",
    name: oid,
    text: null,
    selector: `[data-oid="${oid}"]`,
    visible: true,
    breadcrumb: [],
    rect: { x: 0, y: 0, width: 100, height: 60 },
    layout: {
      x: 40, y: 30, parentId: "parent", parentWidth: 400, parentHeight: 300,
      parentDisplay, parentPosition: "relative", isContainingBlock: true,
    },
    styles: { position, left: "40px", top: "30px", width: "100px", height: "60px", boxSizing: "border-box", transform: "none" },
  };
}

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  host = root = null;
});

function render(details: DesignRuntimeNodeDetails, layoutParents?: DesignRuntimeNodeDetails[]) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const onAction = vi.fn();
  const renderField = (label: string, _property: string, value: string, options?: DesignLayoutFieldOptions) =>
    createElement("input", { key: label, "aria-label": label, defaultValue: value, disabled: Boolean(options?.disabled) });
  act(() => root!.render(createElement(DesignPositionSection, { details, renderField, onAction, disabled: false, layoutParents })));
  const box = host.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="Absolute position"]');
  const field = (label: string) => host!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  return { onAction, box, field };
}

describe("Absolute position in Position", () => {
  it("is unticked on a layer its parent's auto layout places, which locks X and Y", () => {
    const { box, field, onAction } = render(layer("child", "static"));
    expect(box).not.toBeNull();
    expect(box!.checked).toBe(false);
    expect(field("X").disabled).toBe(true);
    expect(field("Y").disabled).toBe(true);
    expect(field("Rotation").disabled).toBe(false);
    expect(host!.textContent).not.toContain("Place freely");
    act(() => box!.click());
    expect(onAction).toHaveBeenCalledWith({ type: "place-freely" });
  });

  it("is ticked on an absolute layer of an auto layout, whose X and Y edit, and unticking rejoins", () => {
    const { box, field, onAction } = render(layer("child", "absolute"));
    expect(box!.checked).toBe(true);
    expect(field("X").disabled).toBe(false);
    expect(field("Y").disabled).toBe(false);
    act(() => box!.click());
    expect(onAction).toHaveBeenCalledWith({ type: "join-auto-layout" });
  });

  it("reads Mixed for a selection of both, and ticking places them all", () => {
    const placed = layer("a", "absolute");
    const { box, onAction } = render(placed, [placed, layer("b", "static")]);
    expect(box!.getAttribute("aria-checked")).toBe("mixed");
    act(() => box!.click());
    expect(onAction).toHaveBeenCalledWith({ type: "place-freely" });
  });

  it("is absent where the parent has no auto layout", () => {
    expect(render(layer("child", "absolute", "block")).box).toBeNull();
  });
});

describe("an absolute layer in Layers", () => {
  const icon = (kind: "instance" | "part" | "layer", absolute?: true) => {
    host = document.createElement("div");
    root = createRoot(host);
    act(() => root!.render(createElement(DesignLayerRowIcon, {
      kind, node: { oid: "a", tag: "div", name: "a", text: null, visible: true, display: "flex", children: [], ...(absolute ? { absolute } : {}) },
    })));
    return host.innerHTML;
  };

  it("shows the absolute mark only while the layer is out of its parent's auto layout", () => {
    expect(icon("layer", true)).toContain("data-design-layer-absolute");
    expect(icon("layer")).not.toContain("data-design-layer-absolute");
    expect(icon("layer")).toContain("data-design-layout-icon");
    // An instance keeps its component mark.
    expect(icon("instance", true)).toContain("data-design-layer-instance");
  });
});
