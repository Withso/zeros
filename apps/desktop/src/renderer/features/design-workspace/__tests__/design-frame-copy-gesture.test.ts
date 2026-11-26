import { beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { startDesignFrameCopy } from "../design-frame-copy-gesture";
import type { beginDesignPointerGesture } from "../design-pointer-gesture";

const mocks = vi.hoisted(() => ({
  gesture: null as Parameters<typeof beginDesignPointerGesture>[0] | null,
  wait: vi.fn(), duplicate: vi.fn(), transfer: vi.fn(), select: vi.fn(), resume: vi.fn(),
  runtime: null as any, runtimeState: null as any, destination: null as any, copyVariant: null as string | null, statePreview: false,
  identity: "main" as "main" | "ordinary" | "instance" | "unknown",
  captureAvailable: true,
  presentation: { hasPixels: true, sharp: true, wantedScale: 2, paint: vi.fn(), remove: vi.fn(), handoff: vi.fn(async () => {}), adopt: vi.fn(), element: { dataset: {} } },
}));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: () => mocks.runtime, waitForDesignFrameRuntime: mocks.wait }));
vi.mock("../design-pointer-gesture", () => ({ beginDesignPointerGesture: (input: Parameters<typeof beginDesignPointerGesture>[0]) => {
  mocks.gesture = input;
  return input.onCancel;
} }));
vi.mock("../design-drag-presentation", async (original) => ({
  ...await original<typeof import("../design-drag-presentation")>(),
  createDesignDragPresentation: vi.fn(() => mocks.presentation),
}));
vi.mock("../design-layout-transfer", () => ({ designCanvasFrameAt: () => mocks.destination, transferDesignLayerOnCanvas: mocks.transfer }));
vi.mock("../state/design-workspace-cache", () => ({
  designWorkspaceSnapshotCache: { peekSnapshot: () => ({ data: { frames: [] } }) }, duplicateDesignFrameCached: mocks.duplicate,
}));
vi.mock("../state/design-workspace-ui", () => ({
  captureDesignPageOwner: () => ({ workspaceId: "local", pageId: "page", revision: 1 }),
  designWorkspaceView: () => ({ selectionEvent: 1 }), isCurrentDesignPageOwner: () => true,
}));
vi.mock("../state/design-runtime-store", () => ({ designRuntimeFrameState: () => mocks.runtimeState }));
vi.mock("../state/design-component-variants", () => ({ captureDesignFrameComponentCopy: (_workspaceId: string, view: { sourceVersion: string }) => {
  if (!mocks.captureAvailable) return null;
  if (mocks.identity === "unknown") return { frame: view, sourceVersion: view.sourceVersion, componentCopy: undefined, statePreview: false, identityUnknown: true };
  if (mocks.identity !== "main") return { frame: view, sourceVersion: view.sourceVersion, statePreview: false, identityUnknown: false };
  return { frame: view, sourceVersion: view.sourceVersion, componentCopy: { variant: mocks.copyVariant }, statePreview: mocks.statePreview, identityUnknown: false };
} }));
vi.mock("../state/design-selection", () => ({ selectDesignFrame: mocks.select }));
vi.mock("../state/design-background-work", () => ({ designBackgroundWork: { pause: () => mocks.resume } }));

const frame = { file: "page/home.html", frameId: "home", pageId: "page", title: "Home", x: 10, y: 20, width: 100, height: 80,
  z: 0, nodeCount: 1, modifiedAt: 1, sourceVersion: "a".repeat(24) };
/** The source frame's article: its attributes and the name it shows. */
function sourceArticle(name = "Home") {
  const attributes = new Map<string, string>();
  return {
    attributes,
    setAttribute: (key: string, value: string) => { attributes.set(key, value); },
    removeAttribute: (key: string) => { attributes.delete(key); },
    hasAttribute: (key: string) => attributes.has(key),
    querySelector: (selector: string) => selector === "[data-design-frame-name]" ? { textContent: name } : null,
  };
}
function start(article: object = sourceArticle()) {
  const event = { currentTarget: { closest: () => article }, clientX: 15, clientY: 25, pointerId: 1,
    preventDefault() {}, stopPropagation() {} } as unknown as React.PointerEvent<HTMLElement>;
  const input = { event, workspaceId: "local", folder: "/local", frame,
    point: ({ clientX, clientY }: { clientX: number; clientY: number }) => ({ x: clientX, y: clientY }),
    current: () => true, nest: vi.fn(), finished: vi.fn(), saving: vi.fn(), failed: vi.fn(), statePreviewed: vi.fn(), unprepared: vi.fn() };
  const cancel = startDesignFrameCopy(input);
  return { input, cancel };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.gesture = null;
  mocks.runtime = null;
  mocks.runtimeState = null;
  mocks.destination = null;
  mocks.copyVariant = null;
  mocks.statePreview = false;
  mocks.identity = "main";
  mocks.captureAvailable = true;
  Object.assign(mocks.presentation, { hasPixels: true, sharp: true, wantedScale: 2 });
});

describe("canvas frame Option copy", () => {
  it("carries the name on the moving copy and leaves the source unselected until the copy is saved", async () => {
    let saved!: (value: unknown) => void;
    mocks.duplicate.mockReturnValue(new Promise(resolve => { saved = resolve; }));
    mocks.select.mockResolvedValue(undefined);
    const create = vi.mocked((await import("../design-drag-presentation")).createDesignDragPresentation);
    const article = sourceArticle("Checkout");
    const { input } = start(article);
    // A press alone changes nothing.
    expect(article.attributes.has("data-design-frame-gesture")).toBe(false);
    mocks.gesture!.onMove({ clientX: 65, clientY: 75 } as PointerEvent);
    expect(article.attributes.get("data-design-frame-gesture")).toBe("copy-source");
    expect(create.mock.calls.at(-1)?.[4]).toMatchObject({ name: { text: "Checkout", component: false } });
    mocks.gesture!.onFinish();
    // The copy is not on the canvas yet: the source must not take the selection back.
    expect(article.attributes.get("data-design-frame-gesture")).toBe("copy-source");
    const copy = { ...frame, file: "page/home-copy.html" };
    saved({ frame: { file: copy.file }, snapshot: { frames: [copy] } });
    await input.saving.mock.calls[0]?.[0];
    await vi.waitFor(() => expect(article.attributes.has("data-design-frame-gesture")).toBe(false));
    expect(mocks.select).toHaveBeenCalledWith("local", copy, expect.objectContaining({ selected: true }));
  });

  it("gives the source its selection back when the drag is cancelled", () => {
    const article = sourceArticle();
    const { cancel } = start(article);
    mocks.gesture!.onMove({ clientX: 65, clientY: 75 } as PointerEvent);
    expect(article.attributes.get("data-design-frame-gesture")).toBe("copy-source");
    cancel();
    expect(article.attributes.has("data-design-frame-gesture")).toBe(false);
  });

  it("gives the source its selection back when the copy fails", async () => {
    mocks.duplicate.mockRejectedValue(new Error("disk full"));
    const article = sourceArticle();
    const { input } = start(article);
    mocks.gesture!.onMove({ clientX: 65, clientY: 75 } as PointerEvent);
    mocks.gesture!.onFinish();
    await vi.waitFor(() => expect(input.failed).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(article.attributes.has("data-design-frame-gesture")).toBe(false));
  });

  it("keeps an Option-click free of editor readiness and capture work", () => {
    mocks.wait.mockResolvedValue(null);
    const { cancel } = start();
    cancel();
    expect(mocks.wait).not.toHaveBeenCalled();
    expect(mocks.duplicate).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalledOnce();
  });

  it("copies at release without waiting for a live editor over empty canvas", async () => {
    let release!: () => void;
    mocks.wait.mockReturnValue(new Promise(resolve => { release = () => resolve(null); }));
    mocks.duplicate.mockResolvedValue({ frame: { file: "copy.html" }, snapshot: { frames: [] } });
    const { input } = start();
    mocks.gesture!.onMove({ clientX: 65, clientY: 75 } as PointerEvent);
    mocks.gesture!.onFinish();
    try {
      await vi.waitFor(() => expect(mocks.duplicate).toHaveBeenCalledExactlyOnceWith("local", frame.file, "page", {
        sourceVersion: frame.sourceVersion, componentCopy: { variant: null },
        geometry: { x: 60, y: 70, w: 100, h: 80, z: 1 },
      }));
      await input.saving.mock.calls[0]?.[0];
      expect(mocks.wait).not.toHaveBeenCalled();
      expect(input.failed).not.toHaveBeenCalled();
    } finally { release?.(); }
  });

  it("lands the copy on whole canvas pixels and selects it, like a moved frame", async () => {
    const copy = { ...frame, file: "page/home-copy.html", frameId: "copy" };
    mocks.duplicate.mockResolvedValue({ frame: { file: copy.file }, snapshot: { frames: [copy] } });
    mocks.select.mockResolvedValue(undefined);
    const article = sourceArticle();
    const event = { currentTarget: { closest: () => article }, clientX: 15, clientY: 25, pointerId: 1,
      preventDefault() {}, stopPropagation() {} } as unknown as React.PointerEvent<HTMLElement>;
    // A zoomed camera maps screen pixels to fractional canvas positions.
    const input = { event, workspaceId: "local", folder: "/local", frame,
      point: ({ clientX, clientY }: { clientX: number; clientY: number }) => ({ x: clientX / 0.48, y: clientY / 0.48 }),
      current: () => true, nest: vi.fn(), finished: vi.fn(), saving: vi.fn(), failed: vi.fn() };
    startDesignFrameCopy(input);
    mocks.gesture!.onMove({ clientX: 65.3, clientY: 275.6 } as PointerEvent);
    mocks.gesture!.onFinish();
    await vi.waitFor(() => expect(mocks.duplicate).toHaveBeenCalledOnce());
    const geometry = mocks.duplicate.mock.calls[0]![3].geometry;
    expect(geometry).toEqual({ x: Math.round(10 + 50.3 / 0.48), y: Math.round(20 + 250.6 / 0.48), w: 100, h: 80, z: 1 });
    await input.saving.mock.calls[0]?.[0];
    expect(mocks.select).toHaveBeenCalledWith("local", copy, expect.objectContaining({ selected: true }));
  });

  it("pins a named preview through a nested drop on the runtime component root", async () => {
    const runtime = {
      sourceVersion: frame.sourceVersion,
      getSnapshot: vi.fn(async () => ({ frame: { oid: "cc-root" } })),
      getNodeDetails: vi.fn(async (oid: string) => ({ oid, rect: { x: 0, y: 0, width: 100, height: 80 } })),
    };
    mocks.runtime = runtime;
    mocks.runtimeState = { snapshot: { frame: { oid: "cc-root" } } };
    mocks.wait.mockResolvedValue(runtime);
    mocks.destination = { ...frame, file: "page/board.html", frameId: "board", x: 0, y: 0, width: 500, height: 400 };
    mocks.transfer.mockResolvedValue(true);
    mocks.copyVariant = "compact";
    const { input } = start();
    mocks.copyVariant = "spacious";
    mocks.gesture!.onMove({ clientX: 65, clientY: 75 } as PointerEvent);
    mocks.gesture!.onFinish();
    await vi.waitFor(() => expect(mocks.transfer).toHaveBeenCalledOnce());
    expect(runtime.getNodeDetails).toHaveBeenCalledWith("cc-root", expect.anything(), { relocation: true });
    expect(mocks.transfer).toHaveBeenCalledWith(expect.objectContaining({
      componentCopy: { variant: "compact" },
      details: expect.objectContaining({ oid: "cc-root" }),
      destination: expect.objectContaining({ file: "page/board.html" }),
    }));
    expect(input.statePreviewed).not.toHaveBeenCalled();
    await input.saving.mock.calls[0]?.[0];
  });

  it("captures a blurry copy's pixels again at the resolution they are drawn", async () => {
    const capture = { sourceVersion: frame.sourceVersion, dataUrl: "data:image/png;base64,sharp", scale: 2, nodeId: null };
    const runtime = { sourceVersion: frame.sourceVersion, captureScreenshot: vi.fn(async () => capture) };
    mocks.runtime = runtime;
    Object.assign(mocks.presentation, { hasPixels: true, sharp: false, wantedScale: 2 });
    start();
    mocks.gesture!.onMove({ clientX: 65, clientY: 75 } as PointerEvent);
    mocks.gesture!.onMove({ clientX: 70, clientY: 80 } as PointerEvent);
    expect(runtime.captureScreenshot).toHaveBeenCalledExactlyOnceWith(null, 2, expect.anything(), "explicit");
    await vi.waitFor(() => expect(mocks.presentation.adopt).toHaveBeenCalledWith({ ...capture, nodeId: "::zeros-document-body" }));
  });

  it("keeps an already sharp copy free of capture work", () => {
    const runtime = { sourceVersion: frame.sourceVersion, captureScreenshot: vi.fn() };
    mocks.runtime = runtime;
    start();
    mocks.gesture!.onMove({ clientX: 65, clientY: 75 } as PointerEvent);
    expect(runtime.captureScreenshot).not.toHaveBeenCalled();
  });

  it("notifies when a state preview is copied as Default", () => {
    mocks.copyVariant = null;
    mocks.statePreview = true;
    mocks.duplicate.mockResolvedValue({ frame: { file: "copy.html" }, snapshot: { frames: [] } });
    const { input } = start();
    mocks.gesture!.onMove({ clientX: 65, clientY: 75 } as PointerEvent);
    mocks.gesture!.onFinish();
    expect(input.statePreviewed).toHaveBeenCalledOnce();
  });

  it("clearly rejects a cold frame without preparing an optimistic copy", () => {
    mocks.captureAvailable = false;
    const { input } = start();
    expect(input.unprepared).toHaveBeenCalledOnce();
    expect(mocks.gesture).toBeNull();
    expect(mocks.duplicate).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown identity before creating a gesture or copy", () => {
    mocks.identity = "unknown";
    const { input } = start();
    expect(input.failed).toHaveBeenCalledOnce();
    expect(input.failed.mock.calls[0]?.[0]?.message).toContain("Duplicate as independent frame");
    expect(mocks.gesture).toBeNull();
    expect(mocks.duplicate).not.toHaveBeenCalled();
  });

  it.each(["ordinary", "instance"] as const)("keeps %s identity on the independent legacy copy path", async (identity) => {
    mocks.identity = identity;
    mocks.duplicate.mockResolvedValue({ frame: { file: "copy.html" }, snapshot: { frames: [] } });
    const { input } = start();
    mocks.gesture!.onMove({ clientX: 65, clientY: 75 } as PointerEvent);
    mocks.gesture!.onFinish();
    await vi.waitFor(() => expect(mocks.duplicate).toHaveBeenCalledOnce());
    expect(mocks.duplicate.mock.calls[0]?.[3]).toEqual({
      sourceVersion: frame.sourceVersion,
      geometry: { x: 60, y: 70, w: 100, h: 80, z: 1 },
    });
    expect(input.statePreviewed).not.toHaveBeenCalled();
  });
});
