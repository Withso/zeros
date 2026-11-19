// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignRuntimeNodeDetails, DesignRuntimeSnapshot } from "@zeros/protocol/design-runtime";

const previews = vi.hoisted((): Record<string, string | null>[] => []);
const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  applyEdit: vi.fn(async () => ({})),
  updateStyles: vi.fn(async () => ({})),
}));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: mocks.runtime }));
vi.mock("../../../platform/bridge/active-bridge", () => ({ onActiveBridgeConnected: vi.fn(() => () => {}) }));
vi.mock("../state/design-live-preview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/design-live-preview")>();
  return {
    ...actual,
    publishDesignLivePreviewStyles: (...args: Parameters<typeof actual.publishDesignLivePreviewStyles>) => {
      previews.push(args[3] as Record<string, string | null>);
      return actual.publishDesignLivePreviewStyles(...args);
    },
  };
});
vi.mock("../state/design-workspace-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/design-workspace-cache")>()),
  applyDesignEditCached: mocks.applyEdit,
  updateDesignNodeStylesCached: mocks.updateStyles,
}));

import { TooltipProvider } from "../../../shared/ui/primitives";
import { DesignInspector } from "../design-inspector";
import { resetDesignRuntimeStoreForTests, useDesignRuntimeStore } from "../state/design-runtime-store";
import { resetDesignHeldStateForTests } from "../state/design-held-state";
import { clearCommittedDesignLivePreviewStyles, resetDesignLivePreviewForTests } from "../state/design-live-preview";

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

const version = (n: number) => String(n).repeat(24).slice(0, 24);
const root = (sourceVersion: string): DesignRuntimeNodeDetails => ({
  sourceVersion, oid: "root", tag: "main", name: "Root", text: null, selector: '[data-oid="root"]',
  visible: true, breadcrumb: [], rect: { x: 0, y: 0, width: 400, height: 300 }, styles: { position: "static" },
  layout: { x: 0, y: 0, parentId: null, parentWidth: 400, parentHeight: 300, parentDisplay: "block", parentPosition: "static",
    isContainingBlock: true, widthValue: "fit-content", heightValue: "fit-content" } as never,
});
const card = (sourceVersion: string, opacity: string): DesignRuntimeNodeDetails => ({
  ...root(sourceVersion), oid: "card", tag: "section", name: "Card", selector: '[data-oid="card"]',
  rect: { x: 10, y: 10, width: 200, height: 100 }, styles: { position: "static", display: "block", opacity },
  authoredStyleProperties: ["opacity"],
  authoredStyles: { opacity: { origin: "inline", scope: "inline", value: opacity, declared: "opacity" } } as never,
  layout: { ...(root(sourceVersion).layout as object), parentId: "root" } as never,
});

function runtime(sourceVersion: string, details: DesignRuntimeNodeDetails) {
  return {
    sourceVersion,
    supports: () => false,
    previewStyles: vi.fn(async () => details),
    clearPreviewStyles: vi.fn(async () => details),
    getNodeDetails: vi.fn(async () => details),
  };
}

let container: HTMLDivElement;
let reactRoot: Root | null = null;

async function show(sourceVersion: string, opacity: string) {
  const details = card(sourceVersion, opacity);
  mocks.runtime.mockReturnValue(runtime(sourceVersion, details));
  const frame = { file: "home.html", sourceVersion, title: "Home", x: 0, y: 0, z: 0, width: 400, height: 300 } as never;
  // A confirmed save publishes the new source and drops the written value
  // from the live preview in the same turn.
  const saved = mocks.updateStyles.mock.calls.at(-1) as unknown as
    | [string, { frame: string; nodeId: string; styles: Record<string, string | null> }]
    | undefined;
  if (saved) clearCommittedDesignLivePreviewStyles(saved[0], saved[1].frame, saved[1].nodeId, saved[1].styles);
  const snapshot = { sourceVersion, revision: 1, tree: [], warnings: [], frame: root(sourceVersion),
    viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0 } } as DesignRuntimeSnapshot;
  useDesignRuntimeStore.getState().publishSnapshot("w", "/repo", "home.html", snapshot, sourceVersion);
  await act(async () => {
    reactRoot ??= createRoot(container);
    reactRoot.render(React.createElement(TooltipProvider, null,
      React.createElement(DesignInspector, {
        workspaceId: "w", folder: "/repo", frame, frameSelected: false, selectedNodeId: "card", selectedNodeIds: ["card"],
        details, lint: null, active: true, canvasBackground: "white", onCanvasBackgroundChange: () => {},
        motionTimelineOpen: false, motionProperties: [], onOpenMotionTimeline: () => {}, zoomActionsRef: { current: null },
      } as never)));
  });
  await act(async () => {});
}

const opacityInput = () => container.querySelector<HTMLInputElement>('[data-design-style-property="opacity"] input')!;
const scrubButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Scrub Opacity"]')!;
const pointer = (type: string, clientX: number) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 0 });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  return event;
};
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
const writes = () => mocks.updateStyles.mock.calls.length + mocks.applyEdit.mock.calls.length;
const writtenOpacity = () => {
  const calls = [...mocks.updateStyles.mock.calls, ...mocks.applyEdit.mock.calls] as unknown[][];
  return JSON.stringify(calls.at(-1)).match(/"opacity":"([^"]*)"/)?.[1] ?? null;
};

async function typeOpacity(text: string) {
  const input = opacityInput();
  act(() => input.focus());
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
}

async function scrub(distance: number, check: (shown: string) => void) {
  act(() => { scrubButton().dispatchEvent(pointer("pointerdown", 100)); });
  for (let step = 1; step <= 10; step += 1) {
    act(() => { window.dispatchEvent(pointer("pointermove", 100 + (distance * step) / 10)); });
    await settle();
    check(opacityInput().value);
  }
  act(() => { window.dispatchEvent(pointer("pointerup", 100 + distance)); });
  await settle();
}

describe("a bounded field scrubbed past its range", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    resetDesignRuntimeStoreForTests();
    resetDesignHeldStateForTests();
    resetDesignLivePreviewForTests();
    mocks.applyEdit.mockClear();
    mocks.updateStyles.mockClear();
    previews.length = 0;
  });
  afterEach(() => {
    act(() => reactRoot?.unmount());
    reactRoot = null;
    container.remove();
  });

  it("shows what it writes past the top, during the scrub, after release, undo and redo", async () => {
    await show(version(1), "0.5");
    expect(opacityInput().value).toBe("50");
    await scrub(200, (shown) => {
      expect(Number(shown)).toBeLessThanOrEqual(100);
      expect(Number(shown)).toBeGreaterThanOrEqual(0);
      expect(previews.at(-1)?.opacity).toBe(String(Number(shown) / 100));
    });
    expect(opacityInput().value).toBe("100");
    expect(writes()).toBe(1);
    expect(writtenOpacity()).toBe("1");
    await show(version(2), "1");
    expect(opacityInput().value).toBe("100");
    await show(version(3), "0.5");
    expect(opacityInput().value).toBe("50");
    await show(version(4), "1");
    expect(opacityInput().value).toBe("100");
  });

  it("shows what it writes below the bottom", async () => {
    await show(version(1), "0.5");
    await scrub(-200, (shown) => {
      expect(Number(shown)).toBeGreaterThanOrEqual(0);
      expect(previews.at(-1)?.opacity).toBe(String(Number(shown) / 100));
    });
    expect(opacityInput().value).toBe("0");
    expect(writtenOpacity()).toBe("0");
    await show(version(2), "0");
    expect(opacityInput().value).toBe("0");
  });

  it("writes nothing when a scrub from the top only pushes past it", async () => {
    await show(version(1), "1");
    await scrub(200, (shown) => expect(shown).toBe("100"));
    expect(opacityInput().value).toBe("100");
    expect(writes()).toBe(0);
  });

  it.each(["var(--muted)", "calc(50%)", "inherit"])(
    "previews and writes valid non-numeric CSS unchanged: %s",
    async (typed) => {
      await show(version(1), "0.5");
      await typeOpacity(typed);
      expect(previews.at(-1)?.opacity).toBe(typed);
      expect(writtenOpacity()).toBe(typed);
      expect(writes()).toBe(1);
    },
  );

  it.each([
    ["25", "0.25"],
    ["50%", "0.5"],
    ["0", "0"],
    ["100", "1"],
    ["120", "1"],
    ["-20", "0"],
    ["1e-1", "0.001"],
    ["1e3", "1"],
  ])("converts the display percentage %s to %s in preview and write", async (typed, written) => {
    await show(version(1), "0.37");
    await typeOpacity(typed);
    expect(previews.at(-1)?.opacity).toBe(written);
    expect(writtenOpacity()).toBe(written);
    expect(writes()).toBe(1);
  });

  it("does not write when the confirmed top value is typed again", async () => {
    await show(version(1), "1");
    await typeOpacity("100");
    expect(writes()).toBe(0);
    expect(opacityInput().value).toBe("100");
  });
});
