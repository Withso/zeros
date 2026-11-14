import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), apply: vi.fn(async () => ({})), pause: vi.fn(), resume: vi.fn() }));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: mocks.runtime }));
vi.mock("../state/design-workspace-cache", () => ({ applyDesignEditCached: mocks.apply }));
vi.mock("../state/design-background-work", () => ({ designBackgroundWork: { pause: mocks.pause } }));

import type { DesignFrameComponent } from "@zeros/protocol/design-catalog";
import type { ComponentOptionValue } from "@zeros/design-core/component-options";
import {
  commitDesignComponentOption,
  commitDesignComponentVariant,
  commitDesignInstanceAttributes,
  commitDesignInstanceText,
  createDesignComponentPreview,
  designComponentVariantName,
  designInstanceOptionState,
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

const VARIANTS: DesignFrameComponent = {
  elements: [...COMPONENT.elements, element("zd-variant", { name: "compact", width: "700" })],
  reach: COMPONENT.reach,
};

describe("variants and instances", () => {
  beforeEach(() => mocks.apply.mockClear());
  const calls = () => mocks.apply.mock.calls as unknown as [string, { file: string }, { operations: Record<string, unknown>[]; intent: string }][];

  it("writes the shown variant's own line, and saves a new one with the values that differ from the defaults", async () => {
    const frame = { file: "chat/composer.html", sourceVersion: V1 } as never;
    await commitDesignComponentOption("w", frame, "width", 680, "compact");
    expect(calls()[0]![2].operations).toEqual([expect.objectContaining({ type: "component.set-option", option: "width", variant: "compact", value: 680 })]);
    const { declaration } = readDesignFrameComponent(VARIANTS);
    await commitDesignComponentVariant("w", frame, declaration, "wide-plan", new Map<string, ComponentOptionValue>([["width", 1400], ["label", "Send"], ["motion", { curve: "ease-out", duration: 150 }]]));
    expect(calls()[1]![2].operations).toEqual([expect.objectContaining({ type: "component.save-variant", file: "chat/composer.html", name: "wide-plan", values: { width: 1400 } })]);
    expect(calls()[1]![2].intent).toBe("Save variant wide-plan");
  });

  it("turns a typed variant name into one the format accepts, or says why not", () => {
    const { declaration } = readDesignFrameComponent(VARIANTS);
    expect(designComponentVariantName(declaration, "Wide plan")).toEqual({ name: "wide-plan" });
    expect(designComponentVariantName(declaration, "  Two  words ")).toEqual({ name: "two-words" });
    expect(designComponentVariantName(declaration, "Compact")).toEqual({ error: "There is already a variant compact." });
    expect(designComponentVariantName(declaration, "Default")).toEqual({ error: "Default is the declared defaults; choose another name." });
    expect("error" in designComponentVariantName(declaration, "")).toBe(true);
    expect("error" in designComponentVariantName(declaration, "1st")).toBe(true);
    expect("error" in designComponentVariantName(declaration, "x".repeat(40))).toBe(true);
  });

  it("reads an instance's values, what it inherits and what differs", () => {
    const { declaration } = readDesignFrameComponent(VARIANTS);
    const state = designInstanceOptionState(declaration, { width: "700", "zd-variant": "compact", label: "Go" });
    expect(state.variant).toBe("compact");
    expect(state.values.get("width")).toBe(700);
    expect(state.inherited.get("width")).toBe(700);
    expect(state.changed).toEqual(new Set(["label"]));
    expect(state.resettable).toBe(true);
    expect(designInstanceOptionState(declaration, {}).resettable).toBe(false);
    // A variant the component no longer declares shows as Default.
    expect(designInstanceOptionState(declaration, { "zd-variant": "gone" }).variant).toBeNull();
  });

  it("writes an instance's values as attributes in one transaction, removing those that land on what it inherits", async () => {
    const frame = { file: "home.html", sourceVersion: V1 } as never;
    await commitDesignInstanceAttributes("w", frame, "inst", { width: "760", label: null, "zd-variant": null }, "Reset Chat composer");
    expect(calls()[0]![1]).toBe(frame);
    expect(calls()[0]![2].intent).toBe("Reset Chat composer");
    expect(calls()[0]![2].operations).toEqual([
      expect.objectContaining({ type: "node.set-attribute", nodeId: "inst", attribute: "width", value: "760" }),
      expect.objectContaining({ type: "node.set-attribute", nodeId: "inst", attribute: "label", value: null }),
      expect.objectContaining({ type: "node.set-attribute", nodeId: "inst", attribute: "zd-variant", value: null }),
    ]);
  });

  it("writes a plain component instance's slot text as its host's text, in one transaction", async () => {
    const frame = { file: "start/welcome.html", sourceVersion: V1 } as never;
    await commitDesignInstanceText("w", frame, "tour-1", "How to move");
    expect(calls()[0]![1]).toBe(frame);
    expect(calls()[0]![2].intent).toBe("Set text");
    expect(calls()[0]![2].operations).toEqual([expect.objectContaining({ type: "node.set-text", nodeId: "tour-1", text: "How to move" })]);
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

  it("previews one instance through its host, once per animation frame", () => {
    const connection = { ...runtime(), supports: (method: string) => method === "previewComponentInstanceOptions",
      previewComponentInstanceOptions: vi.fn(async () => ({ sourceVersion: V1, applied: 1 })) };
    mocks.runtime.mockReturnValue(connection);
    const preview = createDesignComponentPreview("w", "home.html", V1, "inst");
    preview.set({ "--zd-width": "700px" });
    preview.set({ "--zd-width": "720px" });
    tick();
    expect(connection.previewComponentInstanceOptions).toHaveBeenCalledExactlyOnceWith("inst", { "--zd-width": "720px" });
    expect(connection.previewComponentOptions).not.toHaveBeenCalled();
    preview.clear();
    expect(connection.previewComponentInstanceOptions).toHaveBeenLastCalledWith("inst", null);
    // A host the runtime could not name in its selector is never previewed.
    expect(createDesignComponentPreview("w", "home.html", V1, 'a"b').supported()).toBe(false);
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
