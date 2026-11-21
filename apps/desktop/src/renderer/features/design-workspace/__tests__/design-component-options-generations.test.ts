// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignComponentIdentity, DesignFrameComponent, DesignFrameInstances } from "@zeros/protocol/design-catalog";
import { designComponentPartNodeId, designComponentSlotNodeId, type DesignRuntimeNodeDetails, type DesignRuntimeSnapshot } from "@zeros/protocol/design-runtime";

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), applyEdit: vi.fn(async () => ({})) }));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: mocks.runtime }));
vi.mock("../../../platform/bridge/active-bridge", () => ({ onActiveBridgeConnected: vi.fn(() => () => {}) }));
// The style fields themselves are tested on their own; here, which ones the
// inspector asks for, and where.
vi.mock("../design-style-editor", async () => {
  const { createElement } = await import("react");
  return { DesignStyleEditor: ({ only }: { only?: string }) => createElement("div", { "data-test-style-editor": only ?? "all" }) };
});
vi.mock("../state/design-workspace-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/design-workspace-cache")>()),
  applyDesignEditCached: mocks.applyEdit,
}));

import { TooltipProvider } from "../../../shared/ui/primitives";
import { DesignInspector } from "../design-inspector";
import { loadDesignComponentOptions } from "../design-component-options-loader";
import { resetDesignRuntimeStoreForTests, useDesignRuntimeStore } from "../state/design-runtime-store";
import { resetDesignHeldStateForTests } from "../state/design-held-state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

const V1 = "1".repeat(24);
const V2 = "2".repeat(24);
const V3 = "3".repeat(24);
const element = (tag: string, attributes: Record<string, string>) => ({ tag, attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })) });
const LABEL = element("zd-option", { name: "label", type: "text", default: "Send" });
const RADIUS = element("zd-option", { name: "radius", type: "number", default: "8", unit: "px", group: "Shape" });
const component = (...elements: ReturnType<typeof element>[]): DesignFrameComponent => ({
  elements, reach: Object.fromEntries(elements.map((entry) => [entry.attributes[0]!.value, "structure" as const])),
});
const CHIP = component(LABEL, RADIUS);

const root = (sourceVersion: string, oid = "root"): DesignRuntimeNodeDetails => ({
  sourceVersion, oid, tag: "main", name: "Root", text: null, selector: `[data-oid="${oid}"]`,
  visible: true, breadcrumb: [], rect: { x: 0, y: 0, width: 400, height: 300 }, styles: { position: "static" },
  layout: { x: 0, y: 0, parentId: null, parentWidth: 400, parentHeight: 300, parentDisplay: "block", parentPosition: "static",
    isContainingBlock: true, widthValue: "fit-content", heightValue: "fit-content" } as never,
});
const host = (sourceVersion: string, oid = "chip-1"): DesignRuntimeNodeDetails => ({ ...root(sourceVersion), oid, tag: "zd-chip", name: "zd-chip", selector: `[data-oid="${oid}"]` });

type Target = {
  file: string;
  sourceVersion: string;
  component?: DesignFrameComponent;
  componentIdentity?: DesignComponentIdentity | null;
  instances?: DesignFrameInstances;
  nodeId?: string;
  workspaceId?: string;
  runtime?: null | { sourceVersion?: string; rootOid?: string; details?: boolean };
};
const instances = (chip: DesignFrameComponent, attributes: Record<string, string> = {}, style?: string): DesignFrameInstances => ({
  key: "0".repeat(16),
  components: { chip: { ...chip, file: "components/chip.html", frame: true } },
  hosts: { "chip-1": { component: "chip", attributes, ...(style ? { style } : {}) } },
});

let container: HTMLDivElement;
let reactRoot: Root | null = null;

function render(target: Target) {
  const frame = { file: target.file, sourceVersion: target.sourceVersion, title: "Chip", x: 0, y: 0, z: 0, width: 400, height: 300,
    ...(target.component ? { component: target.component } : {}), ...(target.componentIdentity !== undefined ? { componentIdentity: target.componentIdentity } : {}),
    ...(target.instances ? { instances: target.instances } : {}) } as never;
  const runtimeSourceVersion = target.runtime?.sourceVersion ?? target.sourceVersion;
  const runtimeRootOid = target.runtime?.rootOid ?? "root";
  const details = target.runtime === null
    ? null
    : target.nodeId ? host(target.runtime?.details ? runtimeSourceVersion : target.sourceVersion, target.nodeId)
      : target.runtime?.details === false ? null : root(runtimeSourceVersion, runtimeRootOid);
  if (target.runtime !== null && details) {
    const snapshot = { sourceVersion: runtimeSourceVersion, revision: 1, tree: [], warnings: [], frame: root(runtimeSourceVersion, runtimeRootOid),
      viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0 } } as DesignRuntimeSnapshot;
    useDesignRuntimeStore.getState().publishSnapshot(target.workspaceId ?? "w", "/repo", target.file, snapshot, runtimeSourceVersion);
  }
  const selectedNodeIds = target.nodeId
    ? target.nodeId === "mixed" ? ["chip-1", "other-node"]
      : target.nodeId === "mixed-part" ? [designComponentPartNodeId("chip-1", "cc-label"), "other-node"] : [target.nodeId]
    : [];
  reactRoot ??= createRoot(container);
  reactRoot.render(
    React.createElement(TooltipProvider, null,
      React.createElement(DesignInspector, {
        workspaceId: target.workspaceId ?? "w", folder: "/repo", frame, frameSelected: !target.nodeId, selectedNodeId: target.nodeId ?? null,
        selectedNodeIds, details, lint: null, active: true, canvasBackground: "white",
        onCanvasBackgroundChange: () => {}, motionTimelineOpen: false, motionProperties: [], onOpenMotionTimeline: () => {},
        zoomActionsRef: { current: null },
      } as never)),
  );
}

async function show(target: Target) {
  await act(async () => {
    render(target);
    await loadDesignComponentOptions();
  });
  await act(async () => {});
}

const field = (label: string) => container.querySelector<HTMLInputElement>(`[data-design-component-options] input[aria-label="${label}"]`);
const radiusRow = () => container.querySelector('[data-design-component-options] [aria-label="Radius"]');
function type(input: HTMLInputElement, text: string) {
  act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const press = (input: HTMLInputElement, key: string) => act(() => {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
});
const fold = (group: string) => act(() => {
  [...container.querySelectorAll<HTMLButtonElement>("[data-design-component-options] button")].find((button) => button.textContent?.trim() === group)!.click();
});
const written = () => (mocks.applyEdit.mock.calls as unknown as [string, { file: string; sourceVersion: string }, { operations: unknown[] }][])
  .map(([, frame, edit]) => ({ sourceVersion: frame.sourceVersion, operations: edit.operations }));

describe("the Options section across new generations of the same target", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    resetDesignRuntimeStoreForTests();
    resetDesignHeldStateForTests();
    mocks.runtime.mockReturnValue(null);
    mocks.applyEdit.mockClear();
  });
  afterEach(() => {
    act(() => reactRoot?.unmount());
    reactRoot = null;
    container.remove();
  });

  it("keeps a main's typed draft, and Enter then writes that option once against the current source", async () => {
    await show({ file: "components/chip.html", sourceVersion: V1, component: CHIP });
    type(field("Label")!, "Hello");
    await show({ file: "components/chip.html", sourceVersion: V2, component: component(LABEL, RADIUS) });
    expect(field("Label")!.value).toBe("Hello");
    press(field("Label")!, "Enter");
    expect(written()).toEqual([{ sourceVersion: V2, operations: [expect.objectContaining({ type: "component.set-option", option: "label", value: "Hello" })] }]);
  });

  it("keeps an instance's typed draft when its main changes on disk", async () => {
    const instance = { file: "home/page.html", nodeId: "chip-1" };
    await show({ ...instance, sourceVersion: V1, instances: instances(CHIP) });
    type(field("Label")!, "Hello");
    const changedMain = component(LABEL, element("zd-option", { name: "radius", type: "number", default: "12", unit: "px", group: "Shape" }));
    await show({ ...instance, sourceVersion: V2, instances: instances(changedMain) });
    expect(field("Label")!.value).toBe("Hello");
    press(field("Label")!, "Enter");
    expect(written()).toEqual([{ sourceVersion: V2, operations: [expect.objectContaining({ type: "node.set-attribute", nodeId: "chip-1", attribute: "label", value: "Hello" })] }]);
  });

  it("keeps the draft when the new generation changes that option's own value", async () => {
    await show({ file: "components/chip.html", sourceVersion: V1, component: CHIP });
    type(field("Label")!, "Hello");
    await show({ file: "components/chip.html", sourceVersion: V2, component: component(element("zd-option", { name: "label", type: "text", default: "Go" }), RADIUS) });
    expect(field("Label")!.value).toBe("Hello");
    press(field("Label")!, "Escape");
    expect(field("Label")!.value).toBe("Go");
    expect(written()).toEqual([]);
  });

  it("drops a draft whose option the new generation no longer declares, and writes nothing", async () => {
    await show({ file: "components/chip.html", sourceVersion: V1, component: CHIP });
    type(field("Label")!, "Hello");
    await show({ file: "components/chip.html", sourceVersion: V2, component: component(RADIUS) });
    expect(field("Label")).toBeNull();
    await show({ file: "components/chip.html", sourceVersion: V3, component: CHIP });
    expect(field("Label")!.value).toBe("Send");
    expect(written()).toEqual([]);
  });

  it("drops a draft whose option changes type", async () => {
    await show({ file: "components/chip.html", sourceVersion: V1, component: CHIP });
    type(field("Label")!, "Hello");
    await show({ file: "components/chip.html", sourceVersion: V2, component: component(element("zd-option", { name: "label", type: "boolean", default: "true" }), RADIUS) });
    expect(field("Label")).toBeNull();
    expect(written()).toEqual([]);
  });

  it("keeps a folded group folded after a commit brings a new generation", async () => {
    await show({ file: "components/chip.html", sourceVersion: V1, component: CHIP });
    expect(radiusRow()).not.toBeNull();
    fold("Shape");
    expect(radiusRow()).toBeNull();
    type(field("Label")!, "Hello");
    press(field("Label")!, "Enter");
    await show({ file: "components/chip.html", sourceVersion: V2, component: component(element("zd-option", { name: "label", type: "text", default: "Hello" }), RADIUS) });
    expect(radiusRow()).toBeNull();
    expect(field("Label")!.value).toBe("Hello");
  });

  it("shows the restored value when an undo brings back the generation a write was made against", async () => {
    await show({ file: "components/chip.html", sourceVersion: V1, component: CHIP });
    type(field("Label")!, "Hello");
    press(field("Label")!, "Enter");
    await show({ file: "components/chip.html", sourceVersion: V2, component: component(element("zd-option", { name: "label", type: "text", default: "Hello" }), RADIUS) });
    expect(field("Label")!.value).toBe("Hello");
    // A byte-exact undo restores the first generation's content hash too.
    await show({ file: "components/chip.html", sourceVersion: V1, component: CHIP });
    expect(field("Label")!.value).toBe("Send");
    type(field("Label")!, "Hello");
    press(field("Label")!, "Enter");
    expect(written()).toEqual([
      { sourceVersion: V1, operations: [expect.objectContaining({ type: "component.set-option", option: "label", value: "Hello" })] },
      { sourceVersion: V1, operations: [expect.objectContaining({ type: "component.set-option", option: "label", value: "Hello" })] },
    ]);
  });

  it("starts clean for a different frame or instance", async () => {
    await show({ file: "components/chip.html", sourceVersion: V1, component: CHIP });
    fold("Shape");
    type(field("Label")!, "Hello");
    await show({ file: "components/other.html", sourceVersion: V1, component: CHIP });
    expect(radiusRow()).not.toBeNull();
    expect(field("Label")!.value).toBe("Send");
    await show({ file: "home/page.html", nodeId: "chip-1", sourceVersion: V1, instances: instances(CHIP) });
    expect(radiusRow()).not.toBeNull();
    expect(written()).toEqual([]);
  });

  it("shows inherited provenance on focus and marks even equal explicit overrides", async () => {
    await show({ file: "home/page.html", nodeId: "chip-1", sourceVersion: V1, instances: instances(CHIP) });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      field("Label")!.focus();
    });
    await vi.waitFor(() => {
      const tooltip = [...document.body.querySelectorAll<HTMLElement>('[role="tooltip"]')]
        .find((candidate) => candidate.textContent?.includes("Inherited from Chip/Default: Send."));
      expect(tooltip).toBeDefined();
    }, { timeout: 2500 });

    await show({ file: "home/page.html", nodeId: "chip-1", sourceVersion: V2, instances: instances(CHIP, { label: "Send" }) });
    expect(container.querySelector('[data-design-component-options="instance"] [data-option-changed]')).not.toBeNull();
  });

  it("offers Default in the Variant menu only, with no separate Use Default button", async () => {
    const primary = element("zd-variant", { name: "primary", label: "Primary" });
    await show({ file: "home/page.html", nodeId: "chip-1", sourceVersion: V1,
      instances: instances(component(LABEL, RADIUS, primary), { "zd-variant": "primary" }) });
    expect(container.querySelector("[data-design-options-variant]")).not.toBeNull();
    expect(container.querySelector("[data-design-options-use-default]")).toBeNull();
    expect(container.textContent).not.toContain("Use Default");
  });

  it("names an instance, its part and its slot in one header row whose one button is Edit main", async () => {
    const header = () => container.querySelector<HTMLElement>("[data-design-inspector-header]")!;
    const once = () => {
      expect(container.querySelectorAll("[data-design-component-of]")).toHaveLength(1);
      expect(header().querySelectorAll("button")).toHaveLength(1);
      expect(header().querySelector("[data-design-edit-main]")?.textContent).toBe("Edit main");
      expect(container.querySelector("[data-design-select-instance]")).toBeNull();
      expect(container.querySelector("[data-design-part-reset]")).toBeNull();
    };
    const overridden = instances(CHIP);
    overridden.hosts["chip-1"]!.overrides = { "cc-label": "opacity: 0.5" };
    await show({ file: "home/page.html", sourceVersion: V1, instances: overridden,
      componentIdentity: { kind: "instance", nodeId: "chip-1" }, runtime: null });
    expect(header().getAttribute("data-design-component-of")).toBe("instance");
    expect(container.querySelector("[data-design-inspector-title]")?.textContent).toBe("Chip/Default");
    once();
    expect(container.textContent).not.toContain("Instance ·");

    await show({ file: "home/page.html", nodeId: designComponentPartNodeId("chip-1", "cc-label"), sourceVersion: V1,
      instances: overridden, componentIdentity: { kind: "instance", nodeId: "chip-1" } });
    expect(header().getAttribute("data-design-component-of")).toBe("part");
    // The identity truncates; the layer's name has its own span that does not.
    const title = container.querySelector<HTMLElement>("[data-design-inspector-title]")!;
    expect(title.querySelector("[data-design-inspector-title-identity]")?.textContent).toBe("Chip/Default");
    const layerName = title.querySelector<HTMLElement>("[data-design-inspector-title-layer]")!;
    expect(layerName.textContent).toMatch(/^· \S/);
    expect(layerName.className).toContain("shrink-0");
    expect(title.querySelector("[data-design-inspector-title-identity]")!.className).toContain("truncate");
    once();
    expect(container.textContent).not.toContain("Part of");

    await show({ file: "home/page.html", nodeId: designComponentSlotNodeId("chip-1", "extras"), sourceVersion: V1,
      instances: overridden, componentIdentity: { kind: "instance", nodeId: "chip-1" } });
    expect(header().getAttribute("data-design-component-of")).toBe("slot");
    expect(container.querySelector("[data-design-inspector-title-layer]")?.textContent).toMatch(/^· \S/);
    once();
    expect(container.textContent).not.toContain("Drop or draw layers");
  });

  it("shows no main-component scope row under a main's header", async () => {
    await show({ file: "components/chip.html", sourceVersion: V1, component: CHIP,
      componentIdentity: { kind: "main", name: "chip" }, runtime: null });
    expect(container.querySelector('[data-design-component-options="main"]')).not.toBeNull();
    expect(container.querySelector("[data-design-component-scope]")).toBeNull();
    expect(container.textContent).not.toContain("changes update inheriting instances");
  });

  it("calls the section and its tab Controls, keeping the options wire names", async () => {
    await show({ file: "components/chip.html", sourceVersion: V1, component: CHIP,
      componentIdentity: { kind: "main", name: "chip" }, runtime: null });
    const mainTabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.textContent?.trim());
    expect(mainTabs).toContain("Controls");
    expect(mainTabs).not.toContain("Options");
    await show({ file: "home/page.html", sourceVersion: V1, instances: instances(CHIP, { label: "Hi" }),
      componentIdentity: { kind: "instance", nodeId: "chip-1" }, runtime: null });
    const section = container.querySelector<HTMLElement>('[data-design-component-options="instance"]')!;
    expect(section.textContent).toContain("Controls");
    expect(section.textContent).not.toMatch(/\bOptions\b/);
    expect(section.querySelector("[data-design-options-reset]")?.getAttribute("aria-label")).toBe("Reset controls");

    await show({ file: "components/chip.html", sourceVersion: V1, component: CHIP,
      componentIdentity: { kind: "main", name: "chip" }, runtime: null });
    expect(container.querySelector("[data-design-options-ask]")?.textContent?.trim()).toBe("Ask agent to change controls");
  });

  const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.textContent?.trim());
  const editor = () => container.querySelector("[data-test-style-editor]")?.getAttribute("data-test-style-editor") ?? null;
  const zoom = () => container.querySelector('[aria-label^="Canvas zoom"]');

  it("shows an instance its Size and then its Controls, with no tabs and no Style or CSS", async () => {
    await show({ file: "home/page.html", nodeId: "chip-1", sourceVersion: V1, instances: instances(CHIP) });
    expect(tabs()).toEqual([]);
    expect(zoom()).not.toBeNull();
    const panel = container.querySelector<HTMLElement>("[data-design-options-panel]")!;
    expect(panel.querySelector("[data-test-style-editor]")?.getAttribute("data-test-style-editor")).toBe("size");
    const controls = panel.querySelector('[data-design-component-options="instance"]')!;
    expect(panel.querySelector("[data-test-style-editor]")!.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("[data-design-style-panel]")).toBeNull();
    expect(container.querySelector("[data-design-style-panel-css-mode]")).toBeNull();
    expect(container.querySelector("[data-design-reset-style]")).toBeNull();
  });

  it("treats a frame whose root is an instance as that instance: Size, then Controls, no tabs", async () => {
    await show({ file: "home/copy.html", sourceVersion: V1, instances: instances(CHIP),
      componentIdentity: { kind: "instance", nodeId: "chip-1" }, runtime: { rootOid: "chip-1" } });
    expect(container.querySelector("[data-design-inspector-header]")?.getAttribute("data-design-component-of")).toBe("instance");
    expect(tabs()).toEqual([]);
    expect(zoom()).not.toBeNull();
    const panel = container.querySelector<HTMLElement>("[data-design-options-panel]")!;
    expect(panel.querySelector("[data-test-style-editor]")?.getAttribute("data-test-style-editor")).toBe("size");
    expect(panel.querySelector('[data-design-component-options="instance"]')).not.toBeNull();
    expect(container.querySelector("[data-design-style-panel]")).toBeNull();
  });

  it("gives a main Controls and Style, a layer inside it Style alone, and a plain layer Style and CSS", async () => {
    await show({ file: "components/chip.html", sourceVersion: V1, component: CHIP, componentIdentity: { kind: "main", name: "chip" } });
    expect(tabs()).toEqual(["Controls", "Style"]);
    await show({ file: "components/chip.html", nodeId: "label-1", sourceVersion: V1, component: CHIP, componentIdentity: { kind: "main", name: "chip" } });
    expect(tabs()).toEqual([]);
    expect(zoom()).not.toBeNull();
    expect(editor()).toBe("all");
    expect(container.querySelector("[data-design-style-panel-css-mode]")).toBeNull();
    await show({ file: "home/page.html", nodeId: "card", sourceVersion: V1, instances: instances(CHIP) });
    expect(tabs()).toEqual(["Style", "CSS"]);
    expect(editor()).toBe("all");
    expect(container.querySelector("[data-design-component-options]")).toBeNull();
  });

  it("shows a part or slot its instance's Controls, and no Style, CSS or Size", async () => {
    for (const nodeId of [designComponentPartNodeId("chip-1", "cc-label"), designComponentSlotNodeId("chip-1", "extras")]) {
      await show({ file: "home/page.html", nodeId, sourceVersion: V1, instances: instances(CHIP, { label: "Hi" }) });
      expect(tabs()).toEqual([]);
      expect(container.querySelector('[data-design-component-options="instance"]')).not.toBeNull();
      expect(field("Label")!.disabled).toBe(false);
      expect(editor()).toBeNull();
      expect(container.querySelector("[data-design-style-panel]")).toBeNull();
    }
    type(field("Label")!, "Go");
    press(field("Label")!, "Enter");
    expect(written().at(-1)!.operations).toEqual([expect.objectContaining({ type: "node.set-attribute", nodeId: "chip-1", attribute: "label", value: "Go" })]);
  });

  it("sizes several layers with an instance among them, and edits nothing when a part is among them", async () => {
    await show({ file: "home/page.html", nodeId: "mixed", sourceVersion: V1, instances: instances(CHIP) });
    expect(tabs()).toEqual([]);
    expect(editor()).toBe("size");
    expect(container.querySelector("[data-design-component-options]")).toBeNull();
    await show({ file: "home/page.html", nodeId: "mixed-part", sourceVersion: V1, instances: instances(CHIP) });
    expect(tabs()).toEqual([]);
    expect(editor()).toBeNull();
    expect(container.querySelector("[data-design-component-options]")).toBeNull();
    expect(container.querySelector("[data-design-inspector-header]")).not.toBeNull();
  });

  it("counts older overrides apart from size and place, and resets them in one transaction", async () => {
    const older = instances(CHIP, {}, "position: absolute; left: 10px; width: 200px; opacity: 0.5");
    older.hosts["chip-1"]!.overrides = { "cc-label": "color: red" };
    for (const nodeId of ["chip-1", designComponentPartNodeId("chip-1", "cc-label")]) {
      await show({ file: "home/page.html", nodeId, sourceVersion: V1, instances: older });
      const line = container.querySelector<HTMLElement>("[data-design-older-overrides]")!;
      expect(line.getAttribute("data-design-older-overrides")).toBe("2");
      expect(line.textContent).toContain("2 older overrides");
    }
    // One prepared transaction (its operations are tested with the helper).
    act(() => container.querySelector<HTMLButtonElement>("[data-design-older-overrides-reset]")!.click());
    expect(mocks.applyEdit).toHaveBeenCalledTimes(1);
    expect((mocks.applyEdit.mock.calls[0] as unknown as [string, { file: string }, unknown])[1].file).toBe("home/page.html");
    expect(typeof (mocks.applyEdit.mock.calls[0] as unknown as unknown[])[2]).toBe("function");

    await show({ file: "home/page.html", nodeId: "chip-1", sourceVersion: V1, instances: instances(CHIP, {}, "width: 200px; left: 4px") });
    expect(container.querySelector("[data-design-older-overrides]")).toBeNull();
  });

  it("shows Options for an explicit instance before any runtime snapshot exists", async () => {
    await show({ file: "home/page.html", sourceVersion: V1, instances: instances(CHIP),
      componentIdentity: { kind: "instance", nodeId: "chip-1" }, runtime: null });
    expect(container.querySelector('[data-design-component-options="instance"]')).not.toBeNull();
    expect(container.querySelector('[data-design-inspector-title]')?.textContent).toBe("Chip/Default");
    expect(container.querySelector('[data-design-edit-main]')?.textContent).toBe("Edit main");
    expect(mocks.runtime).not.toHaveBeenCalled();
    type(field("Label")!, "Frame-only");
    press(field("Label")!, "Enter");
    expect(written()).toEqual([{ sourceVersion: V1, operations: [expect.objectContaining({
      type: "node.set-attribute", nodeId: "chip-1", attribute: "label", value: "Frame-only",
    })] }]);
  });

  it("shows Options for a registered main with no declaration", async () => {
    await show({ file: "components/chip.html", sourceVersion: V1,
      componentIdentity: { kind: "main", name: "chip" }, runtime: null });
    expect(container.querySelector('[data-design-component-options="main"]')).not.toBeNull();
    // With no options template to append to, a variant or state cannot be saved yet.
    expect(container.querySelector("[data-design-options-add-variant]")).toBeNull();
  });

  it("offers adding a variant on a main that declares its options", async () => {
    await show({ file: "components/chip.html", sourceVersion: V1, component: CHIP,
      componentIdentity: { kind: "main", name: "chip" }, runtime: null });
    expect(container.querySelector("[data-design-options-add-variant]")).not.toBeNull();
  });

  it("shows a registered main header without asking runtime for classification", async () => {
    await show({ file: "components/chip.html", sourceVersion: V1,
      componentIdentity: { kind: "main", name: "chip" }, runtime: { details: false } });
    expect(container.querySelector('[data-design-inspector-title]')?.textContent).toBe("Chip/Default");
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it("keeps a proven ordinary null frame out of Options despite a nested sole instance", async () => {
    await show({ file: "home/page.html", sourceVersion: V1, component: CHIP, instances: instances(CHIP),
      componentIdentity: null, runtime: null });
    expect(container.querySelector("[data-design-component-options]")).toBeNull();
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it("accepts only an exact current-source legacy runtime root host", async () => {
    await show({ file: "home/page.html", sourceVersion: V1, instances: instances(CHIP),
      runtime: { rootOid: "chip-1" } });
    expect(container.querySelector('[data-design-component-options="instance"]')).not.toBeNull();

    useDesignRuntimeStore.getState().publishSnapshot("w", "/repo", "home/page.html", {
      sourceVersion: V2, revision: 2, tree: [], warnings: [], frame: root(V2, "chip-1"),
      viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0 },
    } as DesignRuntimeSnapshot, V2);
    await show({ file: "home/page.html", sourceVersion: V1, instances: instances(CHIP), runtime: null });
    expect(container.querySelector("[data-design-component-options]")).toBeNull();
  });

  it("keeps a legacy main declaration ahead of runtime-root instance fallback", async () => {
    await show({ file: "components/chip.html", sourceVersion: V1, component: CHIP, instances: instances(CHIP),
      runtime: { sourceVersion: V2, rootOid: "chip-1" } });
    expect(container.querySelector('[data-design-component-options="main"]')).not.toBeNull();
  });

  it("lets known main identity outrank a root host with the same id", async () => {
    await show({ file: "components/chip.html", sourceVersion: V1, component: CHIP, instances: instances(CHIP),
      componentIdentity: { kind: "main", name: "chip" }, runtime: { rootOid: "chip-1" } });
    expect(container.querySelector('[data-design-component-options="main"]')).not.toBeNull();
    expect(container.querySelector('[data-design-component-options="instance"]')).toBeNull();
  });

  it("validates Default and named host variants", async () => {
    const variantComponent = component(element("zd-variant", { name: "compact", label: "Compact" }), LABEL);
    await show({ file: "home/page.html", sourceVersion: V1, instances: instances(variantComponent),
      componentIdentity: { kind: "instance", nodeId: "chip-1" }, runtime: null });
    expect(container.textContent).toContain("Chip/Default");
    await show({ file: "home/page.html", sourceVersion: V1,
      instances: { ...instances(variantComponent), hosts: { "chip-1": { component: "chip", attributes: { "zd-variant": "compact" } } } },
      componentIdentity: { kind: "instance", nodeId: "chip-1" }, runtime: null });
    expect(container.textContent).toContain("Chip/Compact");
  });

  it("retargets frame to inner part to ordinary, the part keeping its instance's Controls", async () => {
    await show({ file: "home/page.html", sourceVersion: V1, instances: instances(CHIP),
      componentIdentity: { kind: "instance", nodeId: "chip-1" }, runtime: null });
    expect(container.querySelector('[data-design-component-options="instance"]')).not.toBeNull();
    await show({ file: "home/page.html", nodeId: designComponentPartNodeId("chip-1", "cc-label"), sourceVersion: V1,
      instances: instances(CHIP), componentIdentity: { kind: "instance", nodeId: "chip-1" } });
    expect(container.querySelector('[data-design-component-options="instance"]')).not.toBeNull();
    expect(container.querySelector('[data-design-style-panel-header]')).not.toBeNull();
    await show({ file: "home/page.html", sourceVersion: V1, component: CHIP, instances: instances(CHIP), componentIdentity: null, runtime: null });
    expect(container.querySelector("[data-design-component-options]")).toBeNull();
  });

  it("keeps mixed instance selections out of instance Controls", async () => {
    await show({ file: "home/page.html", nodeId: "mixed", sourceVersion: V1, instances: instances(CHIP),
      componentIdentity: { kind: "instance", nodeId: "chip-1" } });
    expect(container.querySelector("[data-design-component-options]")).toBeNull();
    expect(container.querySelector('[data-design-style-panel-header]')).not.toBeNull();
  });

  it("does not write to the previous workspace after an owner switch", async () => {
    await show({ file: "components/chip.html", sourceVersion: V1, workspaceId: "owner-a", componentIdentity: { kind: "main", name: "chip" }, component: CHIP });
    type(field("Label")!, "Owner A draft");
    await show({ file: "components/chip.html", sourceVersion: V1, workspaceId: "owner-b", componentIdentity: { kind: "main", name: "chip" }, component: CHIP });
    type(field("Label")!, "Owner B");
    press(field("Label")!, "Enter");
    expect((mocks.applyEdit.mock.calls as unknown as Array<[string]>).map(([owner]) => owner)).toEqual(["owner-b"]);
    expect((mocks.applyEdit.mock.calls as unknown as Array<[string]>).at(-1)?.[0]).toBe("owner-b");
  });
});
