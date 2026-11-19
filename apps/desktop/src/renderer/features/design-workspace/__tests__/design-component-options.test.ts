import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), apply: vi.fn(async () => ({})), pause: vi.fn(), resume: vi.fn() }));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: mocks.runtime }));
vi.mock("../state/design-workspace-cache", () => ({ applyDesignEditCached: mocks.apply }));
vi.mock("../state/design-background-work", () => ({ designBackgroundWork: { pause: mocks.pause } }));

import type { DesignFrameComponent } from "@zeros/protocol/design-catalog";
import { designComponentSlotNodeId } from "@zeros/protocol/design-runtime";
import { DesignTransactionSession, type DesignOperation } from "@zeros/design-core";
import type { ComponentOptionValue } from "@zeros/design-core/component-options";
import { createDesignWebDocumentState, designWebTransactionAdapter } from "@zeros/design-web";
import { expandDesignComponentsForRender } from "../../../../engine/design/components";
import {
  commitDesignComponentOption,
  commitDesignComponentVariant,
  commitDesignInstanceAllOverridesReset,
  commitDesignInstanceAttributes,
  commitDesignInstanceOverridesReset,
  commitDesignInstanceSlotReset,
  commitDesignInstanceText,
  createDesignComponentPreview,
  designComponentVariantName,
  designInstanceOptionState,
  designInstanceVisualStyleProperties,
  designComponentPreviewMessagesForTests,
  designComponentPreviewProperties,
  designInstanceHasSuppliedContent,
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

  it("resets only explicitly written option attributes, not the selected variant", () => {
    const declaration = readDesignFrameComponent({
      elements: [
        element("zd-option", { name: "label", type: "text", default: "Go" }),
        element("zd-variant", { name: "primary", label: "Go" }),
      ],
      reach: { label: "structure" },
    } as DesignFrameComponent).declaration;

    expect(designInstanceOptionState(declaration, { "zd-variant": "primary" }).resettable).toBe(false);
    const explicitInherited = designInstanceOptionState(declaration, { "zd-variant": "primary", label: "Go" });
    expect(explicitInherited.resettable).toBe(true);
    expect(explicitInherited.overridden).toEqual(new Set(["label"]));
    expect(explicitInherited.changed.has("label")).toBe(false);
    expect(designInstanceOptionState(declaration, { "data-zd-unknown": "kept" }).resettable).toBe(false);
    expect(designInstanceOptionState(declaration, { "zd-variant": "primary", "data-zd-unknown": "kept" }).overridden).toEqual(new Set());
  });

  it("resets visual size, margins and transforms but preserves canvas positioning", () => {
    expect(designInstanceVisualStyleProperties(
      "position: absolute; left: 12px; top: 24px; width: 300px; height: 120px; margin: 8px; transform: rotate(5deg); translate: 2px; background: red",
    )).toEqual(["width", "height", "margin", "transform", "translate", "background"]);
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

const RESET_FILE = "home/index.html";
const RESET_SOURCE = '<!doctype html><html><body><main data-oid="main"><zd-card data-oid="host" width="800" zd-variant="compact" zd-style-root="color: red" style="position: absolute; left: 12px; top: 24px; width: 300px; background: red">Before &amp;<!--keep--><span data-oid="default-layer">Default</span><b data-oid="named-layer" slot="actions">Named</b><i class="untracked">Keep</i>after &amp;</zd-card></main></body></html>';
const RESET_COMPONENT = '<!doctype html><html><head><template data-zd-options><zd-option name="width" type="number" default="1120" min="640" max="1440" unit="px"></zd-option><zd-variant name="compact" width="800"></zd-variant></template></head><body><article data-zid="root"><slot></slot><div data-zd-slot="actions"><slot name="actions"></slot></div></article></body></html>';
const RESET_FALLBACK_SOURCE = '<!doctype html><html><body><zd-card data-oid="host">custom<!--keep--></zd-card></body></html>';
const RESET_FALLBACK_CASES = [
  {
    kind: "plain",
    components: { "components/card.html": '<!doctype html><html><body><article data-zid="root"><slot>plain-fallback</slot></article></body></html>' },
    registry: new Map<string, string>(),
    fallback: "plain-fallback",
  },
  {
    kind: "templated",
    components: { "parts/card.html": '<!doctype html><html><head><template data-zd-options><zd-option name="label" type="text" default="Card"></zd-option></template></head><body><article data-zid="root"><slot>templated-fallback</slot></article></body></html>' },
    registry: new Map<string, string>([["card", "parts/card.html"]]),
    fallback: "templated-fallback",
  },
] as const;

const resetCatalogHost = async () => {
  const result = await expandDesignComponentsForRender(
    "/work/reset",
    RESET_SOURCE,
    { "parts/card.html": RESET_COMPONENT },
    RESET_FILE,
    { registry: new Map([["card", "parts/card.html"]]) },
    false,
  );
  const host = result.instances?.hosts.host;
  if (!host) throw new Error("The expanded frame did not report its component instance.");
  return host;
};

type CapturedEdit = {
  transactionId: string;
  actor: { kind: "human"; id: string };
  intent: string;
  createdAt: number;
  operations: DesignOperation[];
};

const latestCapturedEdit = () =>
  (mocks.apply.mock.calls as unknown as [string, unknown, CapturedEdit][]).at(-1)![2];

const applyCapturedEdit = (source: string, edit: CapturedEdit) => {
  const initial = createDesignWebDocumentState({ documentId: RESET_FILE, entryFile: RESET_FILE, files: { [RESET_FILE]: source } });
  const session = new DesignTransactionSession(initial, designWebTransactionAdapter);
  const outcome = session.apply({
    schemaVersion: 1,
    transactionId: edit.transactionId,
    documentId: initial.documentId,
    baseRevision: initial.revision,
    actor: edit.actor,
    intent: edit.intent,
    createdAt: edit.createdAt,
    operations: edit.operations,
  });
  return { initial, session, outcome };
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

  it("resets an instance's overrides in one transaction: each part's attribute, and each property its own style sets on its root", async () => {
    const frame = { file: "home.html", sourceVersion: V1 } as never;
    await commitDesignInstanceOverridesReset("w", frame, "inst", ["cc-send", "chip#1"],
      'position: absolute; left: 12px; top: 24px; width: 300px; height: 120px; margin: 8px; transform: rotate(5deg); background: url("a;b.png"); --Gap: 2px');
    expect(calls()[0]![2].intent).toBe("Reset overrides");
    expect(calls()[0]![2].operations).toEqual([
      expect.objectContaining({ type: "node.set-attribute", nodeId: "inst", attribute: "zd-style-cc-send", value: null }),
      expect.objectContaining({ type: "node.set-attribute", nodeId: "inst", attribute: "zd-style-chip", value: null }),
      expect.objectContaining({ type: "node.set-styles", nodeId: "inst", scope: "inline", styles: {
        width: null, height: null, margin: null, transform: null, background: null, "--Gap": null,
      } }),
    ]);
    await commitDesignInstanceOverridesReset("w", frame, "inst", ["cc-send"], undefined);
    expect(calls()[1]![2].operations).toHaveLength(1);
  });

  it("resets options, style, part and supplied content in one transaction without resetting variant or placement", async () => {
    const frame = { file: "home.html", sourceVersion: V1 } as never;
    await commitDesignInstanceAllOverridesReset("w", frame, "inst", ["label"], ["cc-send"],
      "position: absolute; left: 12px; top: 24px; width: 300px; background: red", ["slot-content"], true);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]![2].intent).toBe("Reset all overrides");
    expect(calls()[0]![2].operations).toEqual([
      expect.objectContaining({ type: "node.set-attribute", nodeId: "inst", attribute: "label", value: null }),
      expect.objectContaining({ type: "node.set-attribute", nodeId: "inst", attribute: "zd-style-cc-send", value: null }),
      expect.objectContaining({ type: "node.set-styles", nodeId: "inst", styles: { width: null, background: null } }),
      expect.objectContaining({ type: "node.delete", nodeId: "slot-content" }),
      expect.objectContaining({ type: "node.set-text", nodeId: designComponentSlotNodeId("inst", ""), text: "" }),
    ]);
    expect(calls()[0]![2].operations).not.toContainEqual(expect.objectContaining({ attribute: "zd-variant" }));
  });

  it("confirms Reset All only when a slot or host text has supplied content", () => {
    expect(designInstanceHasSuppliedContent([], undefined)).toBe(false);
    expect(designInstanceHasSuppliedContent([], "")).toBe(false);
    expect(designInstanceHasSuppliedContent([], " ")).toBe(true);
    expect(designInstanceHasSuppliedContent(["slot-layer"], undefined)).toBe(true);
  });

  it("resets supplied slot layers in one undoable edit and skips an empty slot", async () => {
    const frame = { file: "home.html", sourceVersion: V1 } as never;
    await commitDesignInstanceSlotReset("w", frame, ["slot-a", "slot-b"], "Actions");
    expect(calls()).toHaveLength(1);
    expect(calls()[0]![2].intent).toBe("Reset Actions");
    expect(calls()[0]![2].operations).toEqual([
      expect.objectContaining({ type: "node.delete", nodeId: "slot-a" }),
      expect.objectContaining({ type: "node.delete", nodeId: "slot-b" }),
    ]);
    await expect(commitDesignInstanceSlotReset("w", frame, [], "Actions")).resolves.toBeUndefined();
    expect(calls()).toHaveLength(1);
  });

  it("does not submit an empty Reset All transaction", async () => {
    await expect(commitDesignInstanceAllOverridesReset("w", { file: "home.html", sourceVersion: V1 }, "inst", [], [], undefined, [], false))
      .resolves.toBeUndefined();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("preserves a failed Reset All transaction for the caller to report", async () => {
    mocks.apply.mockRejectedValueOnce(new Error("stale component instance"));
    await expect(commitDesignInstanceAllOverridesReset("w", { file: "home.html", sourceVersion: V1 }, "inst", ["label"], [], undefined, [], false))
      .rejects.toThrow("stale component instance");
  });

  it("writes a plain component instance's slot text as its host's text, in one transaction", async () => {
    const frame = { file: "start/welcome.html", sourceVersion: V1 } as never;
    await commitDesignInstanceText("w", frame, "tour-1", "How to move");
    expect(calls()[0]![1]).toBe(frame);
    expect(calls()[0]![2].intent).toBe("Set text");
    expect(calls()[0]![2].operations).toEqual([expect.objectContaining({ type: "node.set-text", nodeId: designComponentSlotNodeId("tour-1", ""), text: "How to move" })]);
  });

  it("edits direct text through the catalog default slot without touching mixed children", async () => {
    const host = await resetCatalogHost();
    expect(host.text).toBe("Before &after &");
    await commitDesignInstanceText("w", { file: RESET_FILE, sourceVersion: V1 } as never, "host", "Changed & <safe>");
    const edit = latestCapturedEdit();
    expect(edit.operations).toEqual([expect.objectContaining({
      type: "node.set-text",
      nodeId: designComponentSlotNodeId("host", ""),
      text: "Changed & <safe>",
    })]);

    const { outcome } = applyCapturedEdit(RESET_SOURCE, edit);
    const changed = outcome.state.files[RESET_FILE]!;
    expect(changed).toContain("Changed &amp; &lt;safe&gt;");
    expect(changed).toContain("<!--keep-->");
    expect(changed).toContain('data-oid="default-layer"');
    expect(changed).toContain('data-oid="named-layer" slot="actions"');
    expect(changed).toContain('<i class="untracked">Keep</i>');
    expect(changed).not.toContain("Before &amp;");
    expect(changed).not.toContain("after &amp;");
  });

  it("resets only catalog-reported slot layers and direct text in one undoable edit", async () => {
    const host = await resetCatalogHost();
    expect(host.text).toBe("Before &after &");
    expect(host.slotted).toEqual({ "": ["default-layer"], actions: ["named-layer"] });
    await commitDesignInstanceAllOverridesReset(
      "w",
      { file: RESET_FILE, sourceVersion: V1 } as never,
      "host",
      ["width"],
      ["root"],
      "position: absolute; left: 12px; top: 24px; width: 300px; background: red",
      Object.values(host.slotted ?? {}).flat(),
      host.text !== undefined,
    );
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    const edit = latestCapturedEdit();
    expect(edit.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "node.set-text", nodeId: designComponentSlotNodeId("host", ""), text: "" }),
      expect.objectContaining({ type: "node.delete", nodeId: "default-layer" }),
      expect.objectContaining({ type: "node.delete", nodeId: "named-layer" }),
    ]));
    const { initial, session, outcome } = applyCapturedEdit(RESET_SOURCE, edit);
    const reset = outcome.state.files[RESET_FILE]!;
    expect(reset).toContain('zd-variant="compact"');
    expect(reset).toContain("position: absolute");
    expect(reset).toContain("left: 12px");
    expect(reset).toContain("top: 24px");
    expect(reset).toContain("<!--keep-->");
    expect(reset).toMatch(/<i class="untracked"[^>]*>Keep<\/i>/);
    expect(reset).not.toContain('width="800"');
    expect(reset).not.toContain("zd-style-root");
    expect(reset).not.toContain("background: red");
    expect(reset).not.toContain("default-layer");
    expect(reset).not.toContain("named-layer");
    expect(reset).not.toContain("Before &amp;");
    expect(reset).not.toContain("after &amp;");
    expect(session.undo()?.state.files[RESET_FILE]).toBe(initial.files[RESET_FILE]);
    expect(session.undo()).toBeNull();
    expect(session.redo()?.state.files[RESET_FILE]).toBe(reset);
    expect(session.redo()).toBeNull();
  });

  it.each(RESET_FALLBACK_CASES.flatMap((component) => [
    { ...component, resetKind: "text" as const },
    { ...component, resetKind: "all" as const },
  ]))("restores the $kind default-slot fallback after Reset $resetKind leaves its comment", async ({ components, registry, fallback, resetKind }) => {
    const frame = { file: RESET_FILE, sourceVersion: V1 } as never;
    const before = await expandDesignComponentsForRender(
      "/work/reset",
      RESET_FALLBACK_SOURCE,
      components,
      RESET_FILE,
      { registry },
      false,
    );
    expect(before.instances?.hosts.host?.text).toBe("custom");

    if (resetKind === "text") await commitDesignInstanceText("w", frame, "host", "");
    else await commitDesignInstanceAllOverridesReset("w", frame, "host", [], [], undefined, [], true);

    const { outcome } = applyCapturedEdit(RESET_FALLBACK_SOURCE, latestCapturedEdit());
    const reset = outcome.state.files[RESET_FILE]!;
    expect(reset).toContain("<!--keep-->");
    expect(reset).not.toContain("custom");
    const after = await expandDesignComponentsForRender(
      "/work/reset",
      reset,
      components,
      RESET_FILE,
      { registry },
      false,
    );
    expect(after.html).toContain(fallback);
    expect(after.html).toContain("<!--keep-->");
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
