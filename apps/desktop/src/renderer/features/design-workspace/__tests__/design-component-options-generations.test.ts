// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignFrameComponent, DesignFrameInstances } from "@zeros/protocol/design-catalog";
import type { DesignRuntimeNodeDetails, DesignRuntimeSnapshot } from "@zeros/protocol/design-runtime";

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), applyEdit: vi.fn(async () => ({})) }));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: mocks.runtime }));
vi.mock("../../../platform/bridge/active-bridge", () => ({ onActiveBridgeConnected: vi.fn(() => () => {}) }));
vi.mock("../design-style-editor", () => ({ DesignStyleEditor: () => null }));
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

const root = (sourceVersion: string): DesignRuntimeNodeDetails => ({
  sourceVersion, oid: "root", tag: "main", name: "Root", text: null, selector: '[data-oid="root"]',
  visible: true, breadcrumb: [], rect: { x: 0, y: 0, width: 400, height: 300 }, styles: { position: "static" },
  layout: { x: 0, y: 0, parentId: null, parentWidth: 400, parentHeight: 300, parentDisplay: "block", parentPosition: "static",
    isContainingBlock: true, widthValue: "fit-content", heightValue: "fit-content" } as never,
});
const host = (sourceVersion: string): DesignRuntimeNodeDetails => ({ ...root(sourceVersion), oid: "chip-1", tag: "zd-chip", name: "zd-chip", selector: '[data-oid="chip-1"]' });

type Target = { file: string; sourceVersion: string; component?: DesignFrameComponent; instances?: DesignFrameInstances; nodeId?: string };
const instances = (chip: DesignFrameComponent, attributes: Record<string, string> = {}): DesignFrameInstances => ({
  key: "0".repeat(16),
  components: { chip: { ...chip, file: "components/chip.html", frame: true } },
  hosts: { "chip-1": { component: "chip", attributes } },
});

let container: HTMLDivElement;
let reactRoot: Root | null = null;

function render(target: Target) {
  const frame = { file: target.file, sourceVersion: target.sourceVersion, title: "Chip", x: 0, y: 0, z: 0, width: 400, height: 300,
    ...(target.component ? { component: target.component } : {}), ...(target.instances ? { instances: target.instances } : {}) } as never;
  const details = target.nodeId ? host(target.sourceVersion) : root(target.sourceVersion);
  const snapshot = { sourceVersion: target.sourceVersion, revision: 1, tree: [], warnings: [], frame: root(target.sourceVersion),
    viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0 } } as DesignRuntimeSnapshot;
  useDesignRuntimeStore.getState().publishSnapshot("w", "/repo", target.file, snapshot, target.sourceVersion);
  reactRoot ??= createRoot(container);
  reactRoot.render(
    React.createElement(TooltipProvider, null,
      React.createElement(DesignInspector, {
        workspaceId: "w", folder: "/repo", frame, frameSelected: !target.nodeId, selectedNodeId: target.nodeId ?? null,
        selectedNodeIds: target.nodeId ? [target.nodeId] : [], details, lint: null, active: true, canvasBackground: "white",
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
});
