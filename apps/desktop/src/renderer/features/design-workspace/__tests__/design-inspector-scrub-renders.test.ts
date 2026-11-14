// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignRuntimeNodeDetails, DesignRuntimeSnapshot } from "@zeros/protocol/design-runtime";

type Fiber = {
  tag: number;
  type: unknown;
  flags: number;
  alternate: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  memoizedProps: Record<string, unknown> | null;
};

// Installed before react-dom loads, as React DevTools is, so every commit's
// rendered components can be counted from the real fiber tree.
const renders = vi.hoisted(() => {
  const byComponent = new Map<string, number>();
  const fields: string[] = [];
  const state = { recording: false, commits: 0, originLabels: 0 };
  const nameOf = (fiber: Fiber): string | null => {
    let type = fiber.type as { displayName?: string; name?: string; type?: unknown; render?: unknown } | null;
    if (!type || typeof type !== "object" && typeof type !== "function") return null;
    if (fiber.tag === 11 && type.render) type = type.render as typeof type;
    return type.displayName || type.name || null;
  };
  // A subtree React bailed out of keeps its old fibers and their old flags;
  // as React DevTools does, descend only where the child list was replaced.
  const walk = (parent: Fiber) => {
    const stack: Fiber[] = [];
    const pushChildren = (fiber: Fiber) => {
      if (fiber.alternate && fiber.child === fiber.alternate.child) return;
      for (let child = fiber.child; child; child = child.sibling) stack.push(child);
    };
    pushChildren(parent);
    while (stack.length) {
      const node = stack.pop()!;
      pushChildren(node);
      // A memo with its own comparator wraps the component's fiber; count the
      // inner one, which renders only when the comparator lets it.
      if (![0, 11, 15].includes(node.tag)) continue;
      if (node.alternate !== null && (node.flags & 1) === 0) continue;
      const name = nameOf(node);
      if (!name) continue;
      byComponent.set(name, (byComponent.get(name) ?? 0) + 1);
      if (/^InspectorStyleField\d*$/.test(name)) fields.push(String(node.memoizedProps?.property));
    }
  };
  (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => {},
    onScheduleFiberRoot: () => {},
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
      if (!state.recording) return;
      state.commits += 1;
      walk(root.current);
    },
  };
  return {
    byComponent,
    fields,
    state,
    reset() {
      byComponent.clear();
      fields.length = 0;
      state.commits = 0;
      state.originLabels = 0;
    },
  };
});

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  applyEdit: vi.fn(async () => ({})),
  updateStyles: vi.fn(async () => ({})),
}));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: mocks.runtime }));
vi.mock("../../../platform/bridge/active-bridge", () => ({ onActiveBridgeConnected: vi.fn(() => () => {}) }));
vi.mock("../state/design-workspace-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/design-workspace-cache")>()),
  applyDesignEditCached: mocks.applyEdit,
  updateDesignNodeStylesCached: mocks.updateStyles,
}));
vi.mock("../design-style-provenance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../design-style-provenance")>();
  const { useMemo } = await import("react");
  return {
    ...actual,
    useDesignStyleOriginLabel: (workspaceId: string | null | undefined) => {
      const label = actual.useDesignStyleOriginLabel(workspaceId);
      return useMemo(
        () =>
          ((origin: Parameters<typeof label>[0]) => {
            renders.state.originLabels += 1;
            return label(origin);
          }) as typeof label,
        [label],
      );
    },
  };
});

import { TooltipProvider } from "../../../shared/ui/primitives";
import { DesignInspector } from "../design-inspector";
import { resetDesignRuntimeStoreForTests, useDesignRuntimeStore } from "../state/design-runtime-store";
import { resetDesignHeldStateForTests } from "../state/design-held-state";
import { resetDesignLivePreviewForTests, useDesignLivePreviewStore } from "../state/design-live-preview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
vi.stubGlobal("CSS", { supports: () => true, escape: (value: string) => value });
let frameId = 0;
vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
  const id = ++frameId;
  setTimeout(() => callback(performance.now()), 0);
  return id;
});
vi.stubGlobal("cancelAnimationFrame", () => {});
Object.assign(Element.prototype, { setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false });

const sourceVersion = "1".repeat(24);
const root: DesignRuntimeNodeDetails = {
  sourceVersion, oid: "root", tag: "main", name: "Root", text: null, selector: '[data-oid="root"]',
  visible: true, breadcrumb: [], rect: { x: 0, y: 0, width: 400, height: 300 }, styles: { position: "static" },
  layout: { x: 0, y: 0, parentId: null, parentWidth: 400, parentHeight: 300, parentDisplay: "block", parentPosition: "static",
    isContainingBlock: true, widthValue: "fit-content", heightValue: "fit-content" } as never,
};
const card: DesignRuntimeNodeDetails = {
  ...root, oid: "card", tag: "section", name: "Card", selector: '[data-oid="card"]',
  rect: { x: 10, y: 10, width: 200, height: 100 },
  styles: { position: "static", display: "flex", flexDirection: "row", gap: "8px", opacity: "0.5", fontSize: "16px" },
  authoredStyleProperties: ["opacity", "display", "gap"],
  authoredStyles: {
    opacity: { origin: "inline", scope: "inline", value: "0.5", declared: "opacity" },
    display: { origin: "inline", scope: "inline", value: "flex", declared: "display" },
    gap: { origin: "inline", scope: "inline", value: "8px", declared: "gap" },
  } as never,
  layout: { ...(root.layout as object), parentId: "root" } as never,
};

let container: HTMLDivElement;
let reactRoot: Root | null = null;

async function show() {
  mocks.runtime.mockReturnValue({
    sourceVersion,
    supports: () => false,
    previewStyles: vi.fn(async () => card),
    clearPreviewStyles: vi.fn(async () => card),
    getNodeDetails: vi.fn(async () => card),
  });
  const frame = { file: "home.html", sourceVersion, title: "Home", x: 0, y: 0, z: 0, width: 400, height: 300 } as never;
  const snapshot = { sourceVersion, revision: 1, tree: [], warnings: [], frame: root,
    viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0 } } as DesignRuntimeSnapshot;
  useDesignRuntimeStore.getState().publishSnapshot("w", "/repo", "home.html", snapshot, sourceVersion);
  await act(async () => {
    reactRoot ??= createRoot(container);
    reactRoot.render(React.createElement(TooltipProvider, null,
      React.createElement(DesignInspector, {
        workspaceId: "w", folder: "/repo", frame, frameSelected: false, selectedNodeId: "card", selectedNodeIds: ["card"],
        details: card, lint: null, active: true, canvasBackground: "white", onCanvasBackgroundChange: () => {},
        motionTimelineOpen: false, motionProperties: [], onOpenMotionTimeline: () => {}, zoomActionsRef: { current: null },
      } as never)));
  });
  await act(async () => {});
}

const fieldInput = (property: string) =>
  container.querySelector<HTMLInputElement>(`[data-design-style-property="${property}"] input`)!;
const pointer = (type: string, clientX: number) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 0 });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  return event;
};
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 2)); });
const lastWrite = () =>
  JSON.stringify([...mocks.updateStyles.mock.calls, ...mocks.applyEdit.mock.calls].at(-1) ?? null);
const writes = () => mocks.updateStyles.mock.calls.length + mocks.applyEdit.mock.calls.length;

const lastX = (tick = 120) => 3 + (tick % 40);

/** Scrub a field's label for 120 moves, each a new value, and count what
 * React rendered for them. The release is not counted. */
async function scrub(label: string) {
  let publishes = 0;
  const unsubscribe = useDesignLivePreviewStore.subscribe(() => { publishes += 1; });
  renders.reset();
  renders.state.recording = true;
  act(() => {
    container.querySelector<HTMLButtonElement>(`button[aria-label="Scrub ${label}"]`)!
      .dispatchEvent(pointer("pointerdown", 0));
  });
  for (let tick = 1; tick <= 120; tick += 1) {
    act(() => { window.dispatchEvent(pointer("pointermove", lastX(tick))); });
    await settle();
  }
  renders.state.recording = false;
  unsubscribe();
  const count = (name: RegExp) =>
    [...renders.byComponent].filter(([component]) => name.test(component)).reduce((sum, [, n]) => sum + n, 0);
  return {
    publishes,
    commits: renders.state.commits,
    originLabels: renders.state.originLabels,
    fieldsRendered: Object.fromEntries(
      [...new Set(renders.fields)].map((property) => [property, renders.fields.filter((p) => p === property).length]),
    ),
    autoLayoutRenders: count(/^DesignAutoLayoutControls\d*$/),
    editFieldRenders: count(/^InspectorEditField\d*$/),
  };
}

async function release() {
  await act(async () => { window.dispatchEvent(pointer("pointerup", lastX())); });
  await settle();
}

describe("an inspector field scrub", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    resetDesignRuntimeStoreForTests();
    resetDesignHeldStateForTests();
    resetDesignLivePreviewForTests();
    mocks.applyEdit.mockClear();
    mocks.updateStyles.mockClear();
    renders.reset();
  });
  afterEach(() => {
    renders.state.recording = false;
    act(() => reactRoot?.unmount());
    reactRoot = null;
    container.remove();
  });

  it("a 120-tick scrub re-renders only the scrubbed field", async () => {
    await show();
    expect(fieldInput("opacity").value).toBe("50");
    const report = await scrub("Opacity");
    expect(report.publishes).toBe(120);
    expect(report.commits).toBeLessThanOrEqual(120);
    expect(report.fieldsRendered).toEqual({ opacity: 120 });
    expect(report.autoLayoutRenders).toBe(0);
    expect(report.editFieldRenders).toBeLessThanOrEqual(120);
    // The scrubbed field shows its live value, so no tick looks up a token's source.
    expect(report.originLabels).toBe(0);
    const shown = fieldInput("opacity").value;
    expect(shown).not.toBe("50");
    await release();
    expect(writes()).toBe(1);
    expect(lastWrite()).toContain(`"opacity":"${Number(shown) / 100}"`);
  });

  it("a layout scrub still reaches the layout section that reads it", async () => {
    await show();
    const report = await scrub("Gap");
    expect(report.publishes).toBe(120);
    expect(report.commits).toBeLessThanOrEqual(2 * 120);
    // The section shows the gap it reads; its other fields have nothing new.
    expect(report.autoLayoutRenders).toBe(120);
    expect(report.fieldsRendered).toEqual({ "column-gap": 120 });
    const shown = fieldInput("column-gap").value;
    expect(shown).not.toBe("8");
    await release();
    expect(writes()).toBe(1);
    expect(lastWrite()).toContain(`"column-gap":"${shown}px"`);
  });
});
