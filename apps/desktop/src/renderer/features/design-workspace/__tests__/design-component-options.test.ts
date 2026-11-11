import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), apply: vi.fn(async () => ({})), pause: vi.fn(), resume: vi.fn() }));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: mocks.runtime }));
vi.mock("../state/design-workspace-cache", () => ({ applyDesignEditCached: mocks.apply }));
vi.mock("../state/design-background-work", () => ({ designBackgroundWork: { pause: mocks.pause } }));

import type { DesignFrameComponent } from "@zeros/protocol/design-catalog";
import {
  commitDesignComponentOption,
  createDesignComponentPreview,
  designComponentPreviewMessagesForTests,
  designComponentPreviewProperties,
  readDesignFrameComponent,
  resetDesignComponentOptionsForTests,
} from "../state/design-component-options";

const V1 = "1".repeat(24);
const element = (tag: string, attributes: Record<string, string>) => ({ tag, attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })) });
const COMPONENT: DesignFrameComponent = {
  elements: [
    element("zd-option", { name: "width", type: "number", default: "1120", min: "640", max: "1440", unit: "px" }),
    element("zd-option", { name: "label", type: "text", default: "Send" }),
    element("zd-option", { name: "motion", type: "easing", default: "ease-out 150ms" }),
    element("zd-derive", { name: "half", value: "width / 2", unit: "px" }),
  ],
  reach: { width: "css", label: "structure", motion: "css" },
};

describe("a component frame's options in the panel", () => {
  beforeEach(() => {
    resetDesignComponentOptionsForTests();
    mocks.runtime.mockReset();
    mocks.apply.mockClear();
  });

  it("reads the declaration once per record", () => {
    const first = readDesignFrameComponent(COMPONENT);
    expect(first.declaration.options.map((option) => option.name)).toEqual(["width", "label", "motion"]);
    expect(readDesignFrameComponent(COMPONENT)).toBe(first);
  });

  it("previews the custom properties a value change sets, derived values included, and never text", () => {
    const { declaration } = readDesignFrameComponent(COMPONENT);
    expect(designComponentPreviewProperties(declaration, new Map([["width", 800]]))).toEqual({
      "--zd-width": "800px", "--zd-motion-easing": "ease-out", "--zd-motion-duration": "150ms", "--zd-half": "400px",
    });
  });

  it("writes one option's default in one transaction", async () => {
    const frame = { file: "chat/composer.html", sourceVersion: V1 } as never;
    await commitDesignComponentOption("w", frame, "width", 960);
    await commitDesignComponentOption("w", frame, "motion", { curve: "spring(0.2)", duration: 300 });
    const calls = mocks.apply.mock.calls as unknown as [string, unknown, { operations: unknown[]; intent: string }][];
    expect(calls.map(([, , intent]) => intent.operations)).toEqual([
      [expect.objectContaining({ type: "component.set-option", file: "chat/composer.html", option: "width", variant: null, value: 960 })],
      [expect.objectContaining({ type: "component.set-option", option: "motion", value: "spring(0.2) 300ms" })],
    ]);
    expect(calls[0]![2].intent).toBe("Set width");
  });
});

describe("previewing while a row is dragged", () => {
  let frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    resetDesignComponentOptionsForTests();
    frames = [];
    mocks.pause.mockReset().mockReturnValue(mocks.resume);
    mocks.resume.mockReset();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());
  const runtime = (sourceVersion = V1) => ({
    sourceVersion,
    supports: (method: string) => method === "previewComponentOptions",
    previewComponentOptions: vi.fn(async () => ({ sourceVersion, applied: 1 })),
  });
  const tick = () => {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(0);
  };

  it("sends at most one message per animation frame, the latest values", () => {
    const connection = runtime();
    mocks.runtime.mockReturnValue(connection);
    const preview = createDesignComponentPreview("w", "chat/composer.html", V1);
    preview.set({ "--zd-width": "700px" });
    preview.set({ "--zd-width": "710px" });
    preview.set({ "--zd-width": "720px" });
    expect(connection.previewComponentOptions).not.toHaveBeenCalled();
    tick();
    expect(connection.previewComponentOptions).toHaveBeenCalledExactlyOnceWith({ "--zd-width": "720px" });
    preview.set({ "--zd-width": "730px" });
    tick();
    tick();
    expect(connection.previewComponentOptions).toHaveBeenCalledTimes(2);
    expect(designComponentPreviewMessagesForTests()).toBe(2);
    // Background captures wait from the first value until the preview is cleared.
    expect(mocks.pause).toHaveBeenCalledTimes(1);
    expect(mocks.resume).not.toHaveBeenCalled();
    preview.clear();
    expect(mocks.resume).toHaveBeenCalledTimes(1);
  });

  it("clears what it showed, and only then", () => {
    const connection = runtime();
    mocks.runtime.mockReturnValue(connection);
    const idle = createDesignComponentPreview("w", "chat/composer.html", V1);
    idle.clear();
    expect(connection.previewComponentOptions).not.toHaveBeenCalled();
    const shown = createDesignComponentPreview("w", "chat/composer.html", V1);
    shown.set({ "--zd-width": "700px" });
    tick();
    shown.clear();
    expect(connection.previewComponentOptions).toHaveBeenLastCalledWith(null);
    // A frame still waiting for its first send sends nothing at all.
    const pending = createDesignComponentPreview("w", "chat/composer.html", V1);
    pending.set({ "--zd-width": "700px" });
    pending.clear();
    tick();
    expect(connection.previewComponentOptions).toHaveBeenCalledTimes(2);
  });

  it("sends nothing to another generation's document, or to one that cannot preview", () => {
    const stale = runtime("2".repeat(24));
    mocks.runtime.mockReturnValue(stale);
    const preview = createDesignComponentPreview("w", "chat/composer.html", V1);
    preview.set({ "--zd-width": "700px" });
    tick();
    expect(stale.previewComponentOptions).not.toHaveBeenCalled();
    mocks.runtime.mockReturnValue({ ...runtime(), supports: () => false });
    preview.set({ "--zd-width": "710px" });
    tick();
    expect(designComponentPreviewMessagesForTests()).toBe(0);
  });
});
