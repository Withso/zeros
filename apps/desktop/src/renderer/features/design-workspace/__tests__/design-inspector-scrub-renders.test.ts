// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignRuntimeNodeDetails, DesignRuntimeSnapshot } from "@zeros/protocol/design-runtime";
import { resetDesignWorkspaceUiForTests, useDesignWorkspaceUiStore } from "../state/design-workspace-ui";
import { isDesignHistoryFocusOwner } from "../state/design-history-commands";
import * as designSelection from "../state/design-selection";

type MockEditIntent = {
  operations: Array<{ type: string; styles?: Record<string, string | null> }>;
};
type MockEditIntentFactory = (
  context: { assertCurrent: () => void },
) => MockEditIntent | null | Promise<MockEditIntent | null>;
type MockApplyEdit = (
  workspaceId: string,
  frame: { file: string; sourceVersion: string },
  intent: MockEditIntent | MockEditIntentFactory,
  ...options: unknown[]
) => Promise<{ result: null }>;

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

const mocks = vi.hoisted(() => {
  const state: { lastPreparedIntent: unknown } = { lastPreparedIntent: null };
  return {
  runtime: vi.fn(),
  waitForRuntime: vi.fn(),
  applyEdit: vi.fn<MockApplyEdit>(async (_workspaceId, _frame, intent) => {
    state.lastPreparedIntent = typeof intent === "function"
      ? await intent({ assertCurrent: () => {} })
      : intent;
    return { result: null };
  }),
  applyHistory: vi.fn(),
  updateStyles: vi.fn(async () => ({})),
  state,
  };
});
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({
  designFrameRuntime: mocks.runtime,
  waitForDesignFrameRuntime: mocks.waitForRuntime,
}));
vi.mock("../../../platform/bridge/active-bridge", () => ({ onActiveBridgeConnected: vi.fn(() => () => {}) }));
vi.mock("../state/design-workspace-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/design-workspace-cache")>()),
  applyDesignEditCached: mocks.applyEdit,
  applyDesignHistoryCached: mocks.applyHistory,
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
import { designFrameGeometryLiveValue, publishDesignFrameGeometryLive, resetDesignLivePreviewForTests, useDesignLivePreviewStore } from "../state/design-live-preview";
import { designWorkspaceSnapshotCache } from "../state/design-workspace-cache";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
vi.stubGlobal("CSS", { supports: () => true, escape: (value: string) => value });
let frameId = 0;
let pendingAnimationFrames = 0;
const animationFrameWaiters = new Set<() => void>();
vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
  const id = ++frameId;
  pendingAnimationFrames += 1;
  setTimeout(() => {
    try {
      callback(performance.now());
    } finally {
      pendingAnimationFrames -= 1;
      if (pendingAnimationFrames === 0) {
        const waiters = [...animationFrameWaiters];
        animationFrameWaiters.clear();
        waiters.forEach((resolve) => resolve());
      }
    }
  }, 0);
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

async function show(frameVersion = sourceVersion, details: DesignRuntimeNodeDetails | null = card, workspaceId = "w", nodeId = "card", active = true) {
  // The runtime answers at the generation its readback carries.
  const runtimeVersion = details?.sourceVersion ?? sourceVersion;
  mocks.runtime.mockReturnValue({
    sourceVersion: runtimeVersion,
    supports: (capability: string) => capability === "measureLayout",
    previewStyles: vi.fn(async () => card),
    clearPreviewStyles: vi.fn(async () => card),
    getNodeDetails: vi.fn(async () => card),
    measureLayout: vi.fn(async ({ nodeIds }: { nodeIds: string[] }) =>
      nodeIds.map((id) => (id === "root" ? root : details ?? card))),
  });
  const frame = { file: "home.html", sourceVersion: frameVersion, title: "Home", x: 0, y: 0, z: 0, width: 400, height: 300 } as never;
  designWorkspaceSnapshotCache.setData(workspaceId, { frames: [frame] } as never);
  const snapshot = { sourceVersion: runtimeVersion, revision: 1, tree: [], warnings: [], frame: { ...root, sourceVersion: runtimeVersion },
    viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0 } } as DesignRuntimeSnapshot;
  useDesignRuntimeStore.getState().publishSnapshot(workspaceId, "/repo", "home.html", snapshot, runtimeVersion);
  await act(async () => {
    reactRoot ??= createRoot(container);
    reactRoot.render(React.createElement(TooltipProvider, null,
      React.createElement(DesignInspector, {
        workspaceId, folder: "/repo", frame, frameSelected: false, selectedNodeId: nodeId, selectedNodeIds: [nodeId],
        details, lint: null, active, canvasBackground: "white", onCanvasBackgroundChange: () => {},
        motionTimelineOpen: false, motionProperties: [], onOpenMotionTimeline: () => {}, zoomActionsRef: { current: null },
      } as never)));
  });
  await act(async () => {});
}

async function showFrameOnlyMain() {
  mocks.runtime.mockReturnValue({
    sourceVersion,
    supports: () => false,
    previewStyles: vi.fn(async () => card),
    clearPreviewStyles: vi.fn(async () => card),
    getNodeDetails: vi.fn(async () => card),
  });
  const frame = {
    file: "home.html", sourceVersion, title: "Home", x: 0, y: 0, z: 0, width: 400, height: 300,
    componentIdentity: { kind: "main", name: "home" },
  } as never;
  const snapshot = { sourceVersion, revision: 1, tree: [], warnings: [], frame: root,
    viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0 } } as DesignRuntimeSnapshot;
  useDesignRuntimeStore.getState().publishSnapshot("w", "/repo", "home.html", snapshot, sourceVersion);
  await act(async () => {
    reactRoot ??= createRoot(container);
    reactRoot.render(React.createElement(TooltipProvider, null,
      React.createElement(DesignInspector, {
        workspaceId: "w", folder: "/repo", frame, frameSelected: true, selectedNodeId: null, selectedNodeIds: [],
        details: null, lint: null, active: true, canvasBackground: "white", onCanvasBackgroundChange: () => {},
        motionTimelineOpen: false, motionProperties: [], onOpenMotionTimeline: () => {}, zoomActionsRef: { current: null },
      } as never)));
  });
  await act(async () => {});
}

async function showRuntime(
  details: DesignRuntimeNodeDetails = card,
  previewLayout = false,
  runtimeSourceVersion = sourceVersion,
  selection: {
    frameSelected?: boolean;
    selectedNodeId?: string | null;
    selectedNodeIds?: string[];
  } = {},
) {
  const {
    frameSelected = false,
    selectedNodeId = "card",
    selectedNodeIds = ["card"],
  } = selection;
  const getNodeDetails = vi.fn<(nodeId: string) => Promise<DesignRuntimeNodeDetails>>(async (nodeId) =>
    nodeId === "root" && details.oid !== "root" ? root : details,
  );
  const runtime = {
    sourceVersion: runtimeSourceVersion,
    supports: (capability: string) => capability === "measureLayout" || (previewLayout && capability === "previewLayout"),
    ...(previewLayout ? { previewLayout: vi.fn(async () => []) } : {}),
    previewStyles: vi.fn(async () => details),
    clearPreviewStyles: vi.fn(async () => details),
    getNodeDetails,
    measureLayout: vi.fn(async ({ nodeIds }: { nodeIds: string[] }) =>
      Promise.all(nodeIds.map((nodeId) => getNodeDetails(nodeId))),
    ),
  };
  mocks.runtime.mockReturnValue(runtime);
  const frame = { file: "home.html", sourceVersion, title: "Home", x: 0, y: 0, z: 0, width: 400, height: 300 } as never;
  designWorkspaceSnapshotCache.setData("w", { frames: [frame] } as never);
  const snapshot = { sourceVersion, revision: 1, tree: [], warnings: [], frame: root,
    viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0 } } as DesignRuntimeSnapshot;
  useDesignRuntimeStore.getState().publishSnapshot("w", "/repo", "home.html", snapshot, sourceVersion);
  await act(async () => {
    reactRoot ??= createRoot(container);
    reactRoot.render(React.createElement(TooltipProvider, null,
      React.createElement("div", { "data-design-workspace-surface": "" },
        React.createElement(DesignInspector, {
          workspaceId: "w", folder: "/repo", frame, frameSelected, selectedNodeId, selectedNodeIds,
          details, lint: null, active: true, canvasBackground: "white", onCanvasBackgroundChange: () => {},
          motionTimelineOpen: false, motionProperties: [], onOpenMotionTimeline: () => {}, zoomActionsRef: { current: null },
        } as never))));
  });
  await act(async () => {});
  return runtime;
}

const fieldInput = (property: string) =>
  container.querySelector<HTMLInputElement>(`[data-design-style-property="${property}"] input`)!;
const serialMutationLane = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T,>(action: () => Promise<T>): Promise<T> => {
    const task = tail.then(action);
    tail = task.then(() => {}, () => {});
    return task;
  };
};
const pointer = (type: string, clientX: number, shiftKey = false) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 0, shiftKey });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  return event;
};
const settle = () => act(async () => {
  while (pendingAnimationFrames > 0) {
    await new Promise<void>((resolve) => animationFrameWaiters.add(resolve));
  }
});
const lastWrite = () =>
  mocks.state.lastPreparedIntent
    ? JSON.stringify(mocks.state.lastPreparedIntent)
    : JSON.stringify([...mocks.updateStyles.mock.calls, ...mocks.applyEdit.mock.calls].at(-1) ?? null);
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
    mocks.state.lastPreparedIntent = null;
    mocks.applyHistory.mockReset();
    mocks.updateStyles.mockClear();
    mocks.waitForRuntime.mockReset();
    renders.reset();
  });
  afterEach(() => {
    renders.state.recording = false;
    act(() => reactRoot?.unmount());
    reactRoot = null;
    container.remove();
    resetDesignWorkspaceUiForTests();
  });

  it.each(["frame", "details"])("retains the same-node editor and open menu when %s advances first without allowing stale writes", async (first) => {
    await show();
    const editor = container.querySelector("[data-design-style-editor]");
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label^="Width sizing:"]')!;
    await act(async () => { trigger.dispatchEvent(pointer("pointerdown", 0)); });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    const nextVersion = "2".repeat(24);
    await show(first === "frame" ? nextVersion : sourceVersion, first === "details" ? { ...card, sourceVersion: nextVersion } : card);
    expect(container.querySelector("[data-design-style-editor]")?.isSameNode(editor)).toBe(true);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(fieldInput("opacity").disabled).toBe(true);
    expect(fieldInput("opacity").value).toBe("50");
    const item = document.querySelector<HTMLElement>('[role="menuitemradio"]')!;
    await act(async () => { item.click(); });
    expect(writes()).toBe(0);
    await show(nextVersion, null);
    expect(container.querySelector("[data-design-style-editor]")).toBe(editor);
    expect(fieldInput("opacity").disabled).toBe(true);
    await show(nextVersion, { ...card, sourceVersion: nextVersion });
    expect(container.querySelector("[data-design-style-editor]")).toBe(editor);
    expect(fieldInput("opacity").disabled).toBe(false);
  });

  it("does not retain another owner or node's details when their readback is missing", async () => {
    await show();
    await show(sourceVersion, null, "other");
    expect(container.querySelector("[data-design-style-editor]")).toBeNull();
    await show();
    await show(sourceVersion, null, "w", "other-node");
    expect(container.querySelector("[data-design-style-editor]")).toBeNull();
    expect(writes()).toBe(0);
  });

  it("keeps the Styled-by line open while the layer's details revalidate", async () => {
    const line = () =>
      container.querySelector<HTMLElement>('[data-design-styled-by] [aria-label="What styles this layer"]');
    const styled = {
      ...card,
      classes: "btn",
      authoredStyles: {
        ...card.authoredStyles,
        gap: { origin: "frame", selector: ".btn", scope: "element", subjectClasses: ["btn"], value: "8px", declared: "gap" },
      } as never,
    };
    await show(sourceVersion, styled);
    act(() => line()!.click());
    expect(line()!.getAttribute("aria-expanded")).toBe("true");
    const nextVersion = "2".repeat(24);
    await show(nextVersion, styled);
    expect(line()?.getAttribute("aria-expanded")).toBe("true");
    await show(nextVersion, { ...styled, sourceVersion: nextVersion });
    expect(line()?.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps an admitted Shift scrub through revalidation and writes only after exact-source readback", async () => {
    const padding = { ...card, styles: { ...card.styles, "padding-left": "22px" } };
    await show(sourceVersion, padding);
    expect(fieldInput("padding-left").value).toBe("22");
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Scrub Left"]')!
        .dispatchEvent(pointer("pointerdown", 0, true));
      window.dispatchEvent(pointer("pointermove", 2, true));
    });
    await settle();
    const nextVersion = "2".repeat(24);
    await show(nextVersion, padding);
    expect(fieldInput("padding-left").disabled).toBe(true);
    expect(writes()).toBe(0);
    await show(nextVersion, { ...padding, sourceVersion: nextVersion });
    act(() => {
      window.dispatchEvent(pointer("pointermove", 4, true));
      window.dispatchEvent(pointer("pointerup", 4, true));
    });
    await settle();
    expect(fieldInput("padding-left").value).toBe("62");
    expect(writes()).toBe(1);
    expect(lastWrite()).toContain('"padding-left":"62px"');
    expect(JSON.stringify([...mocks.updateStyles.mock.calls, ...mocks.applyEdit.mock.calls].at(-1))).toContain(nextVersion);
  });

  it.each(["revalidating", "inactive"])("does not write when a scrub ends while %s", async (reason) => {
    const padding = { ...card, styles: { ...card.styles, "padding-left": "22px" } };
    await show(sourceVersion, padding);
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Scrub Left"]')!
        .dispatchEvent(pointer("pointerdown", 0, true));
      window.dispatchEvent(pointer("pointermove", 4, true));
    });
    await settle();
    expect(fieldInput("padding-left").value).toBe("62");
    await show("2".repeat(24), padding, "w", "card", reason !== "inactive");
    act(() => { window.dispatchEvent(pointer("pointerup", 4, true)); });
    await settle();
    expect(fieldInput("padding-left").value).toBe(reason === "inactive" ? "22" : "62");
    expect(writes()).toBe(0);
    await show("2".repeat(24), { ...padding, sourceVersion: "2".repeat(24) });
    expect(writes()).toBe(reason === "inactive" ? 0 : 1);
  });

  it.each(["confirmed", "inactive", "owner", "node"])("settles a pending typed commit only for its active exact-source owner: %s", async (outcome) => {
    await show();
    const input = fieldInput("opacity");
    act(() => input.focus());
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "75");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("75");
    const nextVersion = "2".repeat(24);
    await show(nextVersion);
    expect(document.activeElement).toBe(input);
    expect(input.disabled).toBe(false);
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(writes()).toBe(0);
    if (outcome === "inactive") await show(nextVersion, card, "w", "card", false);
    if (outcome === "owner") await show(nextVersion, null, "other");
    if (outcome === "node") await show(nextVersion, null, "w", "other-node");
    await show(nextVersion, { ...card, sourceVersion: nextVersion });
    expect(writes()).toBe(outcome === "confirmed" ? 1 : 0);
    if (outcome === "confirmed") {
      expect(lastWrite()).toContain('"opacity":"0.75"');
      expect(lastWrite()).toContain(nextVersion);
    }
  });

  it("a 120-tick scrub re-renders only the scrubbed field", async () => {
    const runtime = await showRuntime();
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
    expect(runtime.measureLayout).not.toHaveBeenCalled();
  });

  it("does not measure confirmed layout during ordinary pointer position previews", async () => {
    const runtime = await showRuntime();
    await scrub("X");
    expect(runtime.previewStyles).toHaveBeenCalled();
    expect(runtime.measureLayout).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
    act(() => { window.dispatchEvent(pointer("pointercancel", lastX())); });
    await settle();
    expect(runtime.measureLayout).not.toHaveBeenCalled();
  });

  it("a layout scrub still reaches the layout section that reads it", async () => {
    await showRuntime();
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

  it("queues a Style-field edit between pending Undo and the next Redo", async () => {
    const actions: string[] = [];
    const enqueueMutation = serialMutationLane();
    const bridgeMutation = vi.fn();
    let resolveHistory: (() => void) | undefined;
    mocks.applyHistory
      .mockImplementationOnce(() => enqueueMutation(async () => {
        actions.push("undo");
        await new Promise<void>((resolve) => { resolveHistory = resolve; });
        return { result: null };
      }))
      .mockImplementationOnce(() => enqueueMutation(async () => {
        actions.push("redo");
        return { result: null };
      }));
    mocks.updateStyles.mockImplementation(() => enqueueMutation(async () => {
      actions.push("style");
      bridgeMutation();
      return {};
    }));
    await showRuntime();
    const inspector = container.querySelector<HTMLElement>("[data-design-inspector]")!;
    const input = fieldInput("opacity");
    try {
      await act(async () => {
        input.focus();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      expect(mocks.applyHistory).toHaveBeenCalledTimes(1);
      expect(container.querySelector("[data-design-inspector]")).toBe(inspector);
      expect(fieldInput("opacity")).toBe(input);
      expect(input.disabled).toBe(false);
      expect(document.activeElement).toBe(input);

      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "75");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        input.focus();
        await Promise.resolve();
      });
      expect(input.value).toBe("75");
      expect(document.activeElement).toBe(input);
      expect(mocks.updateStyles).toHaveBeenCalledTimes(1);
      expect(bridgeMutation).not.toHaveBeenCalled();

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: "z", metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
        }));
        await Promise.resolve();
      });
      expect(mocks.applyHistory).toHaveBeenCalledTimes(2);
      expect(bridgeMutation).not.toHaveBeenCalled();

      await act(async () => {
        resolveHistory?.();
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(actions).toEqual(["undo", "style", "redo"]));
      expect(bridgeMutation).toHaveBeenCalledTimes(1);
      expect(actions).toEqual(["undo", "style", "redo"]);
      expect(mocks.applyHistory.mock.calls.map(([, , direction]) => direction)).toEqual(["undo", "redo"]);
      expect(container.querySelector("[data-design-inspector]")).toBe(inspector);
      expect(fieldInput("opacity")).toBe(input);
      expect(input.disabled).toBe(false);
      expect(document.activeElement).toBe(input);
    } finally {
      await act(async () => { resolveHistory?.(); await Promise.resolve(); });
    }
  });

  it("admits an intrinsic-size Style preparation before a following Undo", async () => {
    const textCard = {
      ...card,
      tag: "p",
      styles: { ...card.styles, fontSize: "16px" },
    };
    const actions: string[] = [];
    const enqueueMutation = serialMutationLane();
    let releasePreparation: (() => void) | undefined;
    const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
    mocks.applyHistory.mockImplementation(() => enqueueMutation(async () => {
      actions.push("undo");
      return { result: null };
    }));
    mocks.applyEdit.mockImplementation((_workspaceId, _frame, intent) =>
      enqueueMutation(async () => {
        actions.push("style-preparation");
        await preparationGate;
        const transaction = typeof intent === "function"
          ? await intent({ assertCurrent: () => {} })
          : intent;
        if (transaction) actions.push("style");
        return { result: null };
      }),
    );
    await showRuntime(textCard, true);
    const input = fieldInput("font-size");
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "18px");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(mocks.applyEdit).toHaveBeenCalledOnce();
    expect(actions).toEqual(["style-preparation"]);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(mocks.applyHistory).toHaveBeenCalledOnce();
    expect(actions).toEqual(["style-preparation"]);
    await act(async () => {
      releasePreparation?.();
      await vi.waitFor(() => expect(actions).toEqual(["style-preparation", "style", "undo"]));
    });
  });

  it("prepares Rotate after pending history without blocking controls or later lane work", async () => {
    const beforeUndo = { ...card, styles: { ...card.styles, rotate: "90deg" } };
    const afterUndo = { ...beforeUndo, styles: { ...beforeUndo.styles, rotate: "0deg" } };
    let releaseUndo: (() => void) | undefined;
    let resolveDetails: (() => void) | undefined;
    const detailsGate = new Promise<void>((resolve) => { resolveDetails = resolve; });
    let currentDetails = beforeUndo;
    let prepared: { operations: Array<{ type: string; styles?: Record<string, string | null> }> } | undefined;
    const actions: string[] = [];
    const enqueueMutation = serialMutationLane();
    const undoGate = new Promise<void>((resolve) => { releaseUndo = resolve; });
    mocks.applyHistory
      .mockImplementationOnce(() => enqueueMutation(async () => {
        actions.push("undo");
        await undoGate;
        currentDetails = afterUndo;
        return { result: null };
      }))
      .mockImplementationOnce(() => enqueueMutation(async () => {
        actions.push("redo");
        return { result: null };
      }));
    mocks.applyEdit.mockImplementation((_workspaceId, _frame, intent) => enqueueMutation(async () => {
      if (typeof intent === "function") {
        const transaction = await intent({ assertCurrent: () => {} });
        if (transaction) prepared = transaction;
        actions.push("rotate");
      } else {
        actions.push("canvas");
      }
      return { result: null };
    }));
    const runtime = await showRuntime(beforeUndo, true);
    const rotate = container.querySelector<HTMLButtonElement>('button[aria-label="Rotate 90° clockwise"]')!;
    const inspector = container.querySelector("[data-design-inspector]");
    const opacity = fieldInput("opacity");
    runtime.getNodeDetails.mockClear();
    await act(async () => { opacity.focus(); });
    try {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      expect(mocks.applyHistory).toHaveBeenCalledOnce();
      expect(rotate.disabled).toBe(false);
      expect(fieldInput("rotate").disabled).toBe(false);
      expect(opacity.disabled).toBe(false);
      expect(document.activeElement).toBe(opacity);
      await act(async () => {
        runtime.getNodeDetails.mockImplementation((nodeId) => {
          if (nodeId === "root") return Promise.resolve(root);
          return detailsGate.then(() => currentDetails);
        });
        rotate.click();
        await Promise.resolve();
      });
      expect(mocks.applyEdit).toHaveBeenCalledOnce();
      expect(runtime.getNodeDetails).not.toHaveBeenCalled();
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: "z", metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
        }));
        await Promise.resolve();
      });
      expect(mocks.applyHistory).toHaveBeenCalledTimes(2);
      await act(async () => {
        mocks.applyEdit("w", { file: "home.html", sourceVersion }, { operations: [] });
        await Promise.resolve();
      });
      expect(actions).toEqual(["undo"]);
      await act(async () => {
        releaseUndo?.();
        await vi.waitFor(() => expect(runtime.getNodeDetails).toHaveBeenCalledTimes(2));
      });
      expect(actions).toEqual(["undo"]);
      await act(async () => {
        resolveDetails?.();
        await vi.waitFor(() => expect(actions).toEqual(["undo", "rotate", "redo", "canvas"]));
      });
      expect(container.querySelector("[data-design-inspector]")).toBe(inspector);
      expect(fieldInput("opacity")).toBe(opacity);
      expect(opacity.disabled).toBe(false);
      expect(document.activeElement).toBe(opacity);
      expect(prepared?.operations.filter((operation) => operation.type === "node.set-styles")[0]?.styles?.rotate).toBe("90deg");
    } finally {
      await act(async () => {
        currentDetails = afterUndo;
        releaseUndo?.();
        resolveDetails?.();
        await Promise.resolve();
      });
      mocks.applyEdit.mockReset();
    }
  });

  it("fails layout preparation instead of reading a stale runtime generation", async () => {
    const runtime = await showRuntime(card, true, "f".repeat(24));
    mocks.waitForRuntime.mockResolvedValue(null);
    let preparation: Promise<unknown> | undefined;
    mocks.applyEdit.mockImplementation((_workspaceId, _frame, intent) => {
      if (typeof intent !== "function") return Promise.resolve({ result: null });
      preparation = Promise.resolve(intent({ assertCurrent: () => {} }));
      return preparation.then(() => ({ result: null }));
    });
    const rotate = container.querySelector<HTMLButtonElement>('button[aria-label="Rotate 90° clockwise"]')!;
    try {
      await act(async () => { rotate.click(); await Promise.resolve(); });
      await vi.waitFor(() => expect(preparation).toBeDefined());
      await expect(preparation).rejects.toThrow(/still loading|matching runtime/i);
      expect(mocks.waitForRuntime).toHaveBeenCalledWith(
        "w",
        "home.html",
        expect.any(Number),
        { sourceVersion },
      );
      expect(runtime.getNodeDetails).not.toHaveBeenCalled();
      expect(mocks.applyEdit).toHaveBeenCalledOnce();
    } finally {
      mocks.applyEdit.mockReset();
    }
  });

  it("derives frame root sizing styles from the latest runtime details", async () => {
    const staleRoot = {
      ...root,
      styles: { ...root.styles, boxSizing: "border-box" },
    };
    const freshRoot = {
      ...root,
      styles: {
        ...root.styles,
        boxSizing: "content-box",
        paddingLeft: "6px",
        paddingRight: "6px",
        borderLeftWidth: "2px",
        borderRightWidth: "2px",
      },
    };
    const runtime = await showRuntime(staleRoot, false, sourceVersion, {
      frameSelected: true,
      selectedNodeId: null,
      selectedNodeIds: [],
    });
    runtime.getNodeDetails.mockResolvedValue(freshRoot);
    let prepared: { operations: Array<{ type: string; styles?: Record<string, string | null> }> } | undefined;
    mocks.applyEdit.mockImplementation((_workspaceId, _frame, intent) => {
      if (typeof intent !== "function") return Promise.resolve({ result: null });
      return Promise.resolve(intent({ assertCurrent: () => {} })).then((transaction) => {
        if (transaction) prepared = transaction;
        return { result: null };
      });
    });

    const width = container
      .querySelector<HTMLButtonElement>('button[aria-label="Scrub W"]')
      ?.closest<HTMLElement>("[data-design-inspector-field]")
      ?.querySelector<HTMLInputElement>("input");
    expect(width).toBeInstanceOf(HTMLInputElement);
    await act(async () => {
      width!.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(width, "480");
      width!.dispatchEvent(new Event("input", { bubbles: true }));
      width!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(mocks.applyEdit).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(prepared).toBeDefined());

    expect(runtime.getNodeDetails).toHaveBeenCalledWith(root.oid);
    expect(prepared?.operations[0]).toMatchObject({
      type: "node.set-styles",
      nodeId: root.oid,
      styles: { width: "calc(100% - 16px)" },
    });
    expect(prepared?.operations[1]).toMatchObject({
      type: "frame.set-geometry",
      frame: "home.html",
      geometry: { x: 0, y: 0, width: 480, height: 300, z: 0 },
    });
  });

  it("keeps layout actions enabled when history fails", async () => {
    let rejectUndo: ((error: Error) => void) | undefined;
    mocks.applyHistory.mockImplementationOnce(() => new Promise((_, reject) => { rejectUndo = reject; }));
    await showRuntime();
    const rotate = container.querySelector<HTMLButtonElement>('button[aria-label="Rotate 90° clockwise"]')!;
    await act(async () => { fieldInput("opacity").focus(); });
    try {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(mocks.applyHistory).toHaveBeenCalledOnce());
      expect(rotate.disabled).toBe(false);
      await act(async () => {
        rejectUndo?.(new Error("history failed"));
        await Promise.resolve();
      });
      expect(rotate.disabled).toBe(false);
    } finally {
      rejectUndo?.(new Error("test cleanup"));
    }
  });

  it("admits queued history before a direct workspace mutation", async () => {
    const actions: string[] = [];
    const enqueueMutation = serialMutationLane();
    let releaseUndo: (() => void) | undefined;
    mocks.applyHistory
      .mockImplementationOnce(() => enqueueMutation(async () => {
        actions.push("undo-1");
        await new Promise<void>((resolve) => { releaseUndo = resolve; });
        return { result: null };
      }))
      .mockImplementationOnce(() => enqueueMutation(async () => {
        actions.push("undo-2");
        return { result: null };
      }));
    mocks.applyEdit.mockImplementation(() => enqueueMutation(async () => {
      actions.push("canvas");
      return { result: null };
    }));
    await showRuntime();
    await act(async () => { fieldInput("opacity").focus(); });
    try {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      expect(mocks.applyHistory).toHaveBeenCalledTimes(1);
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(mocks.applyHistory).toHaveBeenCalledTimes(2));
      expect(actions).toEqual(["undo-1"]);
      let canvasEdit!: Promise<unknown>;
      await act(async () => {
        canvasEdit = mocks.applyEdit("w", { file: "home.html", sourceVersion }, { operations: [] });
        await Promise.resolve();
      });
      expect(actions).toEqual(["undo-1"]);
      await act(async () => { releaseUndo?.(); await canvasEdit; });
      await vi.waitFor(() => expect(actions).toEqual(["undo-1", "undo-2", "canvas"]));
    } finally {
      releaseUndo?.();
    }
  });

  it("does not publish history selection after the directory changes", async () => {
    const settleHistorySelection = vi.spyOn(designSelection, "settleDesignHistorySelection");
    useDesignWorkspaceUiStore.getState().bindDirectory("w", "design-a");
    await showRuntime();
    const rotate = container.querySelector<HTMLButtonElement>('button[aria-label="Rotate 90° clockwise"]')!;
    await act(async () => { fieldInput("opacity").focus(); });
    mocks.applyHistory.mockResolvedValue({ result: null, historyFrame: "home.html" });
    try {
      expect(isDesignHistoryFocusOwner("w", true)).toBe(true);
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
        useDesignWorkspaceUiStore.getState().bindDirectory("w", "design-b");
        await Promise.resolve();
      });
      expect(mocks.applyHistory.mock.calls.map(([, , direction]) => direction)).toEqual(["undo"]);
      expect(settleHistorySelection).not.toHaveBeenCalled();
      expect(rotate.disabled).toBe(false);
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: "z", metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
        }));
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(mocks.applyHistory.mock.calls.some(([, , direction]) => direction === "redo")).toBe(true));
      expect(mocks.applyHistory.mock.calls.map(([, , direction]) => direction)).toEqual(["undo", "redo"]);
      expect(settleHistorySelection).toHaveBeenCalledOnce();
      expect(settleHistorySelection).toHaveBeenCalledWith("w", "home.html");
    } finally {
      settleHistorySelection.mockRestore();
    }
  });

  it("keeps frame geometry inert while its Style panel is hidden", async () => {
    await showFrameOnlyMain();
    const stylePanel = container.querySelector<HTMLElement>("[data-design-style-panel]")!;
    const xField = stylePanel.querySelector<HTMLInputElement>('input[aria-label="X"]')!;
    expect(stylePanel.getAttribute("aria-hidden")).toBe("true");
    expect(stylePanel.hasAttribute("inert")).toBe(true);
    expect(xField.value).toBe("0");

    await act(async () => {
      publishDesignFrameGeometryLive("w", "home.html", { x: 42, y: 0, w: 400, h: 300 }, { settle: true });
    });
    expect(designFrameGeometryLiveValue("w", "home.html", "x")).toBe(42);
    expect(xField.value).toBe("0");

    const styleTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.trim() === "Style")!;
    await act(async () => {
      styleTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    expect(container.querySelector<HTMLElement>("[data-design-style-panel]")?.getAttribute("aria-hidden")).toBe("false");
    expect(container.querySelector<HTMLInputElement>('[data-design-style-panel] input[aria-label="X"]')?.value).toBe("42");
  });
});
