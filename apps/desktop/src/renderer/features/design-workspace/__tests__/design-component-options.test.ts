import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    runtime: vi.fn(),
    waitRuntime: vi.fn(),
    snapshot: { frames: [] as unknown[] } as { frames: unknown[] },
    resolved: undefined as unknown,
    apply: vi.fn(async (_workspace: string, _frame: unknown, intent: unknown) => {
      state.resolved = typeof intent === "function"
        ? await (intent as (context: { assertCurrent: () => void }) => unknown)({ assertCurrent: () => {} })
        : intent;
      return {};
    }),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  return state;
});
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: mocks.runtime, waitForDesignFrameRuntime: mocks.waitRuntime }));
vi.mock("../state/design-workspace-cache", () => ({
  applyDesignEditCached: mocks.apply,
  designWorkspaceSnapshotCache: { peekSnapshot: () => ({ data: mocks.snapshot }) },
}));
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
  commitDesignInstanceOlderOverridesReset,
  designInstanceOlderOverrideCount,
  designInstanceOlderOverrideProperties,
  commitDesignInstanceSlotReset,
  commitDesignInstanceText,
  designInstanceResetAllFits,
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
    mocks.waitRuntime.mockReset();
    mocks.apply.mockClear();
    mocks.resolved = undefined;
    mocks.snapshot = { frames: [] };
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
  (mocks.resolved ?? (mocks.apply.mock.calls as unknown as [string, unknown, CapturedEdit][]).at(-1)![2]) as CapturedEdit;

const prepareResetSnapshot = (file: string, nodeId: string, host: Record<string, unknown>, component: unknown = VARIANTS) => {
  mocks.snapshot = {
    frames: [{ file, sourceVersion: V1, frameId: "frame", instances: {
      components: { card: component },
      hosts: { [nodeId]: { component: "card", attributes: {}, ...host } },
    } }],
  };
};

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
  beforeEach(() => {
    mocks.apply.mockClear();
    mocks.waitRuntime.mockReset();
    mocks.resolved = undefined;
    mocks.snapshot = { frames: [] };
  });
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

  it("counts an instance's older overrides: each part override and each host style outside its size and place", () => {
    const style = 'position: absolute; left: 12px; top: 24px; width: 300px; height: 120px; flex-grow: 1; rotate: 5deg; transform: rotate(5deg); transform-origin: 0 0; translate: 1px 2px; margin: 8px; opacity: .5; scale: 2; background: url("a;b.png"); --Gap: 2px';
    expect(designInstanceOlderOverrideProperties(style)).toEqual(["margin", "opacity", "scale", "background", "--Gap"]);
    expect(designInstanceOlderOverrideCount({ component: "card", attributes: {}, overrides: { "cc-send": "x", "chip#1": "y" }, style })).toBe(7);
    expect(designInstanceOlderOverrideCount({ component: "card", attributes: {}, style: "width: 200px; left: 4px" })).toBe(0);
    expect(designInstanceOlderOverrideCount({ component: "card", attributes: {} })).toBe(0);
  });

  it("counts a size or size limit on an axis a control drives as an older override, keeping the other axis and the place", () => {
    const style = "width: 200px; min-width: 100px; max-height: 80px; height: 40px; left: 4px; opacity: .5";
    const bound = { width: true, height: false };
    expect(designInstanceOlderOverrideProperties(style, bound)).toEqual(["width", "min-width", "opacity"]);
    expect(designInstanceOlderOverrideCount({ component: "card", attributes: {}, style }, bound)).toBe(3);
    expect(designInstanceOlderOverrideProperties(style)).toEqual(["opacity"]);
  });

  it("resets a raw size over a bound axis with the other older overrides", async () => {
    const frame = { file: "home.html", sourceVersion: V1 } as never;
    prepareResetSnapshot("home.html", "inst", { style: "width: 200px; min-width: 100px; height: 40px; left: 4px; opacity: .5" },
      { ...VARIANTS, bindings: { root: "card-root", layers: { "card-root": { styles: { width: ["width"] } } } } });
    await commitDesignInstanceOlderOverridesReset("w", frame, "inst");
    expect(latestCapturedEdit().operations).toEqual([
      expect.objectContaining({ type: "node.set-styles", nodeId: "inst", styles: { width: null, "min-width": null, opacity: null } }),
    ]);
  });

  it("resets an instance's older overrides in one transaction, keeping its size and place", async () => {
    const frame = { file: "home.html", sourceVersion: V1 } as never;
    prepareResetSnapshot("home.html", "inst", { overrides: { "cc-send": "x", "chip#1": "y" }, style: 'position: absolute; left: 12px; top: 24px; width: 300px; height: 120px; margin: 8px; transform: matrix(1, 0, 0, 1, 6, 8); background: url("a;b.png"); --Gap: 2px' });
    await commitDesignInstanceOlderOverridesReset("w", frame, "inst");
    expect(latestCapturedEdit().intent).toBe("Reset older overrides");
    expect(latestCapturedEdit().operations).toEqual([
      expect.objectContaining({ type: "node.set-attribute", nodeId: "inst", attribute: "zd-style-cc-send", value: null }),
      expect.objectContaining({ type: "node.set-attribute", nodeId: "inst", attribute: "zd-style-chip", value: null }),
      expect.objectContaining({ type: "node.set-styles", nodeId: "inst", scope: "inline", styles: { margin: null, background: null, "--Gap": null } }),
    ]);
    // Placement stays, so a legacy translate needs no fold.
    expect(mocks.waitRuntime).not.toHaveBeenCalled();
    prepareResetSnapshot("home.html", "inst", { overrides: { "cc-send": "x" }, style: "width: 300px" });
    await commitDesignInstanceOlderOverridesReset("w", frame, "inst");
    expect(latestCapturedEdit().operations).toHaveLength(1);
  });

  it("recomputes a current legacy matrix placement and folds it into reset pins", async () => {
    const details = {
      sourceVersion: V1,
      oid: "inst",
      tag: "div",
      name: "Instance",
      text: null,
      selector: '[data-oid="inst"]',
      visible: true,
      breadcrumb: [],
      rect: { x: 0, y: 0, width: 100, height: 50 },
      layout: { x: 10, y: 20, parentId: "parent", parentWidth: 400, parentHeight: 300, parentDisplay: "block", parentPosition: "relative", isContainingBlock: true },
      styles: { position: "absolute", left: "10px", top: "20px", right: "auto", bottom: "auto", transform: "matrix(1, 0, 0, 1, 6, 8)", transformOrigin: "0px 0px", width: "100px", height: "50px" },
      authoredStyleProperties: ["left", "top", "transform"],
      authoredStyles: { transform: { origin: "inline", value: "matrix(1, 0, 0, 1, 6, 8)" } },
    };
    const runtime = { sourceVersion: V1, getNodeDetails: vi.fn(async () => details) };
    mocks.runtime.mockReturnValue(runtime);
    mocks.waitRuntime.mockResolvedValue(runtime);
    prepareResetSnapshot("home.html", "inst", { style: "position: absolute; left: 10px; top: 20px; transform: matrix(1, 0, 0, 1, 6, 8); width: 100px" });
    await commitDesignInstanceAllOverridesReset("w", { file: "home.html", sourceVersion: V1 }, "inst");
    const styles = latestCapturedEdit().operations.find((operation) => operation.type === "node.set-styles") as Extract<DesignOperation, { type: "node.set-styles" }>;
    expect(styles.styles).toMatchObject({ left: "16px", top: "28px", width: null, transform: null });
    expect(mocks.waitRuntime).toHaveBeenCalledWith("w", "home.html", 2_000, { sourceVersion: V1 });
    expect(runtime.getNodeDetails).toHaveBeenCalledWith("inst", undefined, { relocation: true });
  });

  it("falls back to ordinary reset when current matrix details prove nonlegacy placement", async () => {
    const details = {
      sourceVersion: V1,
      oid: "inst",
      tag: "div",
      name: "Instance",
      text: null,
      selector: '[data-oid="inst"]',
      visible: true,
      breadcrumb: [],
      rect: { x: 0, y: 0, width: 100, height: 50 },
      layout: { x: 10, y: 20, parentId: "parent", parentWidth: 400, parentHeight: 300, parentDisplay: "block", parentPosition: "relative", isContainingBlock: false },
      styles: { position: "relative", left: "10px", top: "20px", transform: "matrix(1, 0, 0, 1, 6, 8)", transformOrigin: "50% 50%", width: "100px", height: "50px" },
      authoredStyleProperties: ["transform"],
      authoredStyles: { transform: { origin: "inline", value: "matrix(1, 0, 0, 1, 6, 8)" } },
    };
    const runtime = { sourceVersion: V1, getNodeDetails: vi.fn(async () => details) };
    mocks.runtime.mockReturnValue(runtime);
    mocks.waitRuntime.mockResolvedValue(runtime);
    prepareResetSnapshot("home.html", "inst", { style: "position: relative; transform: matrix(1, 0, 0, 1, 6, 8); width: 100px" });

    await commitDesignInstanceAllOverridesReset("w", { file: "home.html", sourceVersion: V1 }, "inst");

    const styles = latestCapturedEdit().operations.find((operation) => operation.type === "node.set-styles") as Extract<DesignOperation, { type: "node.set-styles" }>;
    expect(styles.styles).toMatchObject({ transform: null, width: null });
    expect(styles.styles).not.toHaveProperty("left", "16px");
  });

  it("aborts legacy reset when the runtime returns retired node details", async () => {
    const details = {
      sourceVersion: V1,
      oid: "retired",
      tag: "div",
      name: "Retired",
      text: null,
      selector: '[data-oid="retired"]',
      visible: true,
      breadcrumb: [],
      rect: { x: 0, y: 0, width: 100, height: 50 },
      layout: { x: 10, y: 20, parentId: "parent", parentWidth: 400, parentHeight: 300, parentDisplay: "block", parentPosition: "relative", isContainingBlock: true },
      styles: { position: "absolute", left: "10px", top: "20px", transform: "matrix(1, 0, 0, 1, 6, 8)", transformOrigin: "0px 0px", width: "100px", height: "50px" },
      authoredStyleProperties: ["transform"],
      authoredStyles: { transform: { origin: "inline", value: "matrix(1, 0, 0, 1, 6, 8)" } },
    };
    const runtime = { sourceVersion: V1, getNodeDetails: vi.fn(async () => details) };
    mocks.runtime.mockReturnValue(runtime);
    mocks.waitRuntime.mockResolvedValue(runtime);
    prepareResetSnapshot("home.html", "inst", { style: "position: absolute; transform: matrix(1, 0, 0, 1, 6, 8)" });

    await expect(commitDesignInstanceAllOverridesReset("w", { file: "home.html", sourceVersion: V1 }, "inst"))
      .rejects.toThrow(/runtime details for inst are stale/);
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(mocks.resolved).toBeUndefined();
  });

  it("aborts legacy reset when the runtime identity retires after measurement", async () => {
    const details = {
      sourceVersion: V1,
      oid: "inst",
      tag: "div",
      name: "Instance",
      text: null,
      selector: '[data-oid="inst"]',
      visible: true,
      breadcrumb: [],
      rect: { x: 0, y: 0, width: 100, height: 50 },
      layout: { x: 10, y: 20, parentId: "parent", parentWidth: 400, parentHeight: 300, parentDisplay: "block", parentPosition: "relative", isContainingBlock: true },
      styles: { position: "absolute", left: "10px", top: "20px", transform: "matrix(1, 0, 0, 1, 6, 8)", transformOrigin: "0px 0px", width: "100px", height: "50px" },
      authoredStyleProperties: ["transform"],
      authoredStyles: { transform: { origin: "inline", value: "matrix(1, 0, 0, 1, 6, 8)" } },
    };
    const runtime = { sourceVersion: V1, getNodeDetails: vi.fn(async () => { mocks.runtime.mockReturnValue({}); return details; }) };
    mocks.runtime.mockReturnValue(runtime);
    mocks.waitRuntime.mockResolvedValue(runtime);
    prepareResetSnapshot("home.html", "inst", { style: "position: absolute; transform: matrix(1, 0, 0, 1, 6, 8)" });

    await expect(commitDesignInstanceAllOverridesReset("w", { file: "home.html", sourceVersion: V1 }, "inst"))
      .rejects.toThrow(/runtime details for inst are stale/);
    expect(mocks.resolved).toBeUndefined();
  });

  it("fails closed when the captured frame or host is no longer current", async () => {
    await expect(commitDesignInstanceOlderOverridesReset("w", { file: "home.html", sourceVersion: V1, frameId: "old" }, "inst"))
      .rejects.toThrow(/no longer available/);
    mocks.snapshot = {
      frames: [{ file: "home.html", sourceVersion: V1, instances: {
        components: { card: VARIANTS },
        hosts: { inst: { component: "card", attributes: {}, style: "width: 10px" } },
      } }],
    };
    await expect(commitDesignInstanceOlderOverridesReset("w", { file: "home.html", sourceVersion: V1, frameId: "old" }, "inst"))
      .rejects.toThrow(/no longer available/);
    prepareResetSnapshot("home.html", "other", { style: "width: 10px" });
    await expect(commitDesignInstanceAllOverridesReset("w", { file: "home.html", sourceVersion: V1 }, "inst"))
      .rejects.toThrow(/no longer available/);
  });

  it("does not turn an empty default-slot text record into a reset override", async () => {
    prepareResetSnapshot("home.html", "inst", { text: "" });
    await commitDesignInstanceAllOverridesReset("w", { file: "home.html", sourceVersion: V1 }, "inst");
    expect(mocks.resolved).toBeNull();
  });

  it("resets options, style, part and supplied content in one transaction without resetting variant or placement", async () => {
    const frame = { file: "home.html", sourceVersion: V1 } as never;
    prepareResetSnapshot("home.html", "inst", { attributes: { label: "Go", "zd-variant": "compact" }, overrides: { "cc-send": "x" },
      style: "position: absolute; left: 12px; top: 24px; width: 300px; background: red", slotted: { "": ["slot-content"] }, text: "supplied", mixedText: true });
    await commitDesignInstanceAllOverridesReset("w", frame, "inst");
    expect(calls()).toHaveLength(1);
    expect(latestCapturedEdit().intent).toBe("Reset all overrides");
    expect(latestCapturedEdit().operations).toEqual([
      expect.objectContaining({ type: "node.set-attribute", nodeId: "inst", attribute: "label", value: null }),
      expect.objectContaining({ type: "node.set-attribute", nodeId: "inst", attribute: "zd-style-cc-send", value: null }),
      expect.objectContaining({ type: "node.set-styles", nodeId: "inst", styles: { width: null, background: null } }),
      expect.objectContaining({ type: "node.delete", nodeId: "slot-content" }),
      expect.objectContaining({ type: "node.set-text", nodeId: designComponentSlotNodeId("inst", ""), text: "" }),
    ]);
    expect(latestCapturedEdit().operations).not.toContainEqual(expect.objectContaining({ attribute: "zd-variant" }));
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
    prepareResetSnapshot("home.html", "inst", {});
    await expect(commitDesignInstanceAllOverridesReset("w", { file: "home.html", sourceVersion: V1 }, "inst"))
      .resolves.toEqual({});
    expect(mocks.resolved).toBeNull();
  });

  it("keeps Reset All within one transaction: 256 resets fit, 257 are refused before submitting", async () => {
    const slot = (name: string) => Array.from({ length: 64 }, (_, index) => `${name}-${index}`);
    const full = { a: slot("a"), b: slot("b"), c: slot("c"), d: slot("d") };
    expect(designInstanceResetAllFits({ options: 0, parts: 0, style: false, slotted: 256, text: false })).toBe(true);
    expect(designInstanceResetAllFits({ options: 1, parts: 0, style: false, slotted: 256, text: false })).toBe(false);
    prepareResetSnapshot("home.html", "inst", { attributes: { label: "Go" }, slotted: full });
    await expect(commitDesignInstanceAllOverridesReset("w", { file: "home.html", sourceVersion: V1 }, "inst"))
      .rejects.toThrow("too many layers to reset in one step");
    prepareResetSnapshot("home.html", "inst", { slotted: full });
    await commitDesignInstanceAllOverridesReset("w", { file: "home.html", sourceVersion: V1 }, "inst");
    expect(latestCapturedEdit().operations).toHaveLength(256);
  });

  it("preserves a failed Reset All transaction for the caller to report", async () => {
    mocks.apply.mockRejectedValueOnce(new Error("stale component instance"));
    await expect(commitDesignInstanceAllOverridesReset("w", { file: "home.html", sourceVersion: V1 }, "inst"))
      .rejects.toThrow("stale component instance");
  });

  it("writes a plain component instance's slot text as its host's text, in one transaction", async () => {
    const frame = { file: "start/welcome.html", sourceVersion: V1 } as never;
    await commitDesignInstanceText("w", frame, "tour-1", "How to move");
    expect(calls()[0]![1]).toBe(frame);
    expect(calls()[0]![2].intent).toBe("Set text");
    expect(calls()[0]![2].operations).toEqual([expect.objectContaining({ type: "node.set-text", nodeId: "tour-1", text: "How to move" })]);
  });

  it("writes text beside other children through the virtual default slot, as its record says, whatever the connection reports", async () => {
    await commitDesignInstanceText("w", { file: "start/welcome.html", sourceVersion: V1 } as never, "tour-1", "How to move", { mixedText: true });
    expect(calls().at(-1)![2].operations).toEqual([expect.objectContaining({ type: "node.set-text", nodeId: designComponentSlotNodeId("tour-1", ""), text: "How to move" })]);
  });

  it("edits direct text through the catalog default slot without touching mixed children", async () => {
    const host = await resetCatalogHost();
    expect(host.text).toBe("Before &after &");
    expect(host.mixedText).toBe(true);
    await commitDesignInstanceText("w", { file: RESET_FILE, sourceVersion: V1 } as never, "host", "Changed & <safe>", host);
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
    prepareResetSnapshot(RESET_FILE, "host", { attributes: { width: "800", "zd-variant": "compact" }, overrides: { root: "color: red" },
      style: "position: absolute; left: 12px; top: 24px; width: 300px; background: red", slotted: host.slotted, text: host.text, mixedText: host.mixedText });
    await commitDesignInstanceAllOverridesReset("w", { file: RESET_FILE, sourceVersion: V1 } as never, "host");
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
    // Its comment sits beside the text, so the record says to write the default slot.
    expect(before.instances?.hosts.host?.mixedText).toBe(true);

    if (resetKind === "text") await commitDesignInstanceText("w", frame, "host", "", before.instances!.hosts.host!);
    else {
      prepareResetSnapshot(RESET_FILE, "host", { attributes: {}, text: "custom", component: "card", mixedText: true });
      await commitDesignInstanceAllOverridesReset("w", frame, "host");
    }

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
