// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignFrameInstances } from "@zeros/protocol/design-catalog";
import type { DesignCanvasFrameWire, DesignWorkspaceSnapshotWire } from "../../../platform/git";
import { readDesignWorkspaceSource } from "./workspace-source";

const producer = vi.hoisted(() => ({ deleteFrame: vi.fn() }));
vi.mock("../../../platform/git", async (original) => ({
  ...await original<typeof import("../../../platform/git")>(),
  designDeleteFrame: producer.deleteFrame,
}));

import { designFrameMissingComponents, designFrameOptionsProblem, designLayerDisplayName, designMissingComponentOf } from "../state/design-component-parts";
import { designComponentRecordProblem, designInstanceIgnoredAttributes } from "../state/design-component-options";
import { deleteDesignFrameCached, designWorkspaceSnapshotCache, resetDesignWorkspaceCacheForTests } from "../state/design-workspace-cache";
import { DesignComponentOptions } from "../design-component-options";
import { DesignFrameDeleteDialog } from "../design-frame-delete-dialog";
import { DesignFrameLoadError, DesignFrameProblemLabel, DesignFrameProblemMark } from "../design-frame-load-error";
import { DesignFramePreparation } from "../state/design-workspace-preparation";
import { designFramePreparationProblem, designFrameViews } from "../state/design-frame-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const source = readDesignWorkspaceSource();
const instances = (hosts: DesignFrameInstances["hosts"]): DesignFrameInstances => ({
  key: "0".repeat(16),
  components: { card: { elements: [], reach: {}, file: "page-1/card.html", frame: true } },
  hosts,
});

describe("an instance whose component is gone", () => {
  const frame = { instances: instances({
    gone: { component: "chip", attributes: {}, missing: true },
    other: { component: "chip", attributes: {}, missing: true },
    kept: { component: "card", attributes: {} },
  }) };

  it("names the missing component for the selected instance, and nothing for one that resolves", () => {
    expect(designMissingComponentOf(frame, "gone")).toBe("chip");
    expect(designMissingComponentOf(frame, "kept")).toBeNull();
    expect(designMissingComponentOf(frame, "constructor")).toBeNull();
    expect(designMissingComponentOf({}, "gone")).toBeNull();
  });

  it("lists each missing component once for its host frame", () => {
    expect(designFrameMissingComponents(frame)).toEqual(["chip"]);
    expect(designFrameMissingComponents({ instances: instances({ kept: { component: "card", attributes: {} } }) })).toEqual([]);
  });

  it("is shown on the host frame's label and in the panel, not as a Frame", () => {
    expect(source).toContain("designFrameMissingComponents(frame)");
    expect(source).toContain('<DesignFrameProblemMark kind="missing-component"');
    expect(source).toContain("designMissingComponentOf(frame, instanceNodeId)");
    expect(source).toContain("data-design-component-missing=");
  });

  it("is named zd-<name> in Layers and in the selection path, not Frame", () => {
    const node = (oid: string, tag: string, name = tag) => ({ oid, tag, name, children: [] });
    expect(designLayerDisplayName(frame, node("gone", "zd-chip"))).toBe("zd-chip");
    expect(designLayerDisplayName(frame, { ...node("gone", "zd-chip"), layerName: "Status" })).toBe("zd-chip");
    expect(designLayerDisplayName(frame, node("kept", "zd-card"))).toBe("Frame");
    expect(designLayerDisplayName(frame, node("p", "p", "Before"))).toBe("Before");
    expect(designLayerDisplayName({}, node("gone", "zd-chip"))).toBe("Frame");
    const panels = readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer/features/design-workspace/design-workspace-sidebar-panels.tsx"), "utf8");
    expect(panels).toContain("designLayerDisplayName(frame, layer.node)");
    expect(panels).toContain("designLayerDisplayName(selectedFrame, node)");
  });
});

describe("an instance attribute that names no option", () => {
  it("says which attribute and value the component ignores", () => {
    expect(designInstanceIgnoredAttributes({ component: "chip", attributes: { mood: "calm" }, ignored: { tone: "loud" } }))
      .toEqual(['This component has no option tone; tone="loud" is ignored.']);
    expect(designInstanceIgnoredAttributes({ component: "chip", attributes: {} })).toEqual([]);
    const optionsSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer/features/design-workspace/design-component-options.tsx"), "utf8");
    expect(optionsSource).toContain("designInstanceIgnoredAttributes(host)");
    expect(optionsSource).toContain("data-design-options-ignored");
  });
});

describe("deleting a main component frame", () => {
  const workspaceId = "personal";
  const snapshot = { directoryId: "design_test", protocolCapability: null, tokens: [], tokenSourceVersion: "t", assets: [],
    lint: { workspacePath: "/w", checkedFiles: [], violations: [], healedOids: 0 }, frames: [] } as unknown as DesignWorkspaceSnapshotWire;
  beforeEach(() => {
    resetDesignWorkspaceCacheForTests();
    producer.deleteFrame.mockReset();
  });

  it("asks the engine to keep a main its instances use, and publishes nothing when it does", async () => {
    designWorkspaceSnapshotCache.setData(workspaceId, snapshot);
    const usage = { component: "chip", title: "Chip", instances: 3, frames: 2 };
    producer.deleteFrame.mockResolvedValueOnce({ inUse: usage });
    expect(await deleteDesignFrameCached(workspaceId, "page-1/chip.html", { ifUnused: true })).toEqual({ inUse: usage });
    expect(producer.deleteFrame).toHaveBeenCalledWith(workspaceId, "page-1/chip.html", { ifUnused: true });
    expect(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data).toBe(snapshot);
    // Deleting first asks; the confirmation deletes without the flag.
    expect(source).toContain("deleteDesignFrameCached(workspaceId, candidate.file, confirmed ? undefined : { ifUnused: true })");
    expect(source).toContain("<DesignFrameDeleteDialog");
  });

  describe("the confirmation", () => {
    let host: HTMLDivElement;
    afterEach(() => host?.remove());
    it("names the component and how many instances and frames use it", async () => {
      host = document.createElement("div");
      document.body.append(host);
      const onDelete = vi.fn();
      const root = createRoot(host);
      await act(async () => {
        root.render(createElement(DesignFrameDeleteDialog, {
          usage: { component: "chip", title: "Chip", instances: 3, frames: 2 }, onCancel: () => {}, onDelete,
        }));
      });
      const dialog = document.body.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).toContain("Delete component Chip?");
      expect(dialog.textContent).toContain("3 instances in 2 frames use zd-chip");
      const button = [...dialog.querySelectorAll("button")].find((candidate) => candidate.textContent === "Delete")!;
      await act(async () => button.click());
      expect(onDelete).toHaveBeenCalledOnce();
      await act(async () => root.unmount());
    });
  });
});

describe("a frame whose source cannot be read", () => {
  const canvasSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer/features/design-workspace/design-canvas.tsx"), "utf8");
  const frame = (file: string): DesignCanvasFrameWire => ({ file, frameId: file.replace(".html", ""), pageId: "page", title: file, kind: "frame",
    x: 0, y: 0, width: 100, height: 100, z: 0, nodeCount: 1, modifiedAt: 0, sourceVersion: "a".repeat(24) });
  // A frame shown before (its pixels kept as `previous`) whose next preparation fails.
  const shown = (): DesignWorkspaceSnapshotWire => {
    const prepared = frame("f0.html");
    const { sourceVersion: _s, nodeCount: _n, layerCount: _l, modifiedAt: _m, ...metadata } = prepared;
    return { directoryId: "design_test", protocolCapability: null, frames: [prepared], tokens: [], tokenSourceVersion: "t", assets: [],
      lint: { workspacePath: "/w", checkedFiles: [], violations: [], healedOids: 0 },
      preparation: { revision: "a".repeat(64), epoch: 1, current: [], errors: {}, descriptions: [{ ...metadata, preparation: "unprepared" }] } } as DesignWorkspaceSnapshotWire;
  };

  it.each([
    ["the whole request fails", () => Promise.reject(new Error("The Local engine is unavailable."))],
    ["its own file is missing", async () => ({ catalogRevision: "a".repeat(64), frames: [],
      errors: [{ file: "f0.html", message: "The registered Design source is unavailable or exceeds its limit." }] })],
  ])("names the problem of a frame already shown when %s", async (_case, prepare) => {
    let current = shown();
    const coordinator = new DesignFramePreparation({ snapshot: () => current, publish: (_, next) => { current = next; }, canPrepare: () => true, prepare });
    coordinator.setDemand({}, { workspaceId: "local", files: ["f0.html"] });
    await vi.waitFor(() => expect(current.preparation!.errors["f0.html"]).toBeDefined());
    const view = designFrameViews(current)[0]!;
    expect(view).toHaveProperty("previous");
    expect(designFramePreparationProblem(current, view)).toBe(current.preparation!.errors["f0.html"]);
    expect(designFramePreparationProblem({ ...current, preparation: { ...current.preparation!, current: ["f0.html"] } }, current.frames[0]!)).toBeNull();
  });

  it("marks the frame's label, and shows the message and Retry only where they fit on screen", () => {
    const html = renderToStaticMarkup(createElement(DesignFrameLoadError, { message: "The registered Design source is unavailable.", onRetry: () => {} }));
    expect(html).toContain("data-design-frame-problem-surface");
    expect(html).toContain("data-design-frame-load-error");
    expect(html).toContain("Couldn’t load this frame.");
    expect(html).toContain("Retry frame");
    // Without a label of its own the surface carries a screen-size mark for small frames.
    expect(html).toContain('data-design-frame-problem="load-error"');
    const labelled = renderToStaticMarkup(createElement(DesignFrameLoadError, { message: "x", labelled: true, onRetry: () => {} }));
    expect(labelled).not.toContain('data-design-frame-problem="load-error"');
    const mark = renderToStaticMarkup(createElement(DesignFrameProblemMark, { message: "The registered Design source is unavailable." }));
    expect(mark).toContain('data-design-frame-problem="load-error"');
    expect(mark).toContain('title="The registered Design source is unavailable."');
    const label = renderToStaticMarkup(createElement(DesignFrameProblemLabel, { title: "QA Chip", message: "gone" }));
    expect(label).toContain("QA Chip");
    expect(label).toContain('data-design-frame-problem="load-error"');
  });

  it("is drawn on frames never shown and on frames that keep earlier pixels", () => {
    expect(canvasSource).toContain("designFramePreparationProblem(snapshot, description)");
    expect(canvasSource.match(/<DesignFrameLoadError/g)?.length).toBe(2);
    expect(canvasSource).toContain("<DesignFrameProblemLabel");
    expect(canvasSource).toContain("<DesignFrameProblemMark");
    expect(source).not.toMatch(/preparation\?\.errors \?\? \{\}\)\[0\]/);
  });
});

describe("a component whose options do not apply", () => {
  const canvasSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer/features/design-workspace/design-canvas.tsx"), "utf8");
  const main = (notApplied?: "last-good" | "defaults" | "nothing") => ({ component: { elements: [], reach: {}, ...(notApplied ? { notApplied } : {}) } });
  const hosting = (failed: boolean, notApplied?: "last-good" | "defaults" | "nothing"): { instances: DesignFrameInstances } => ({ instances: {
    ...instances({ a: { component: "card", attributes: {}, ...(failed ? { failed: true as const } : {}) }, b: { component: "card", attributes: {} } }),
    ...(notApplied ? { notApplied } : {}),
  } });

  it("says on its main frame what the frame shows instead", () => {
    expect(designFrameOptionsProblem(main("last-good"))).toBe("These options could not be applied. The frame shows its last good render.");
    expect(designFrameOptionsProblem(main("defaults"))).toBe("These options could not be applied. The frame shows the component's defaults.");
    expect(designFrameOptionsProblem(main())).toBeNull();
    expect(designFrameOptionsProblem({})).toBeNull();
  });

  it("says a main or an instance whose template fails with no last good render shows nothing", () => {
    expect(designFrameOptionsProblem(main("nothing"))).toBe("These options could not be applied. The frame shows nothing in its place.");
    expect(designFrameOptionsProblem(hosting(true, "nothing"))).toBe("The options of zd-card could not be applied. The frame shows nothing in its place.");
  });

  it("says on every frame hosting a failed instance which component and what it shows", () => {
    expect(designFrameOptionsProblem(hosting(true, "last-good"))).toBe("The options of zd-card could not be applied. The frame shows its last good render.");
    // A host that failed with no fallback named shows the defaults, as its Options section says.
    expect(designFrameOptionsProblem(hosting(true))).toBe("The options of zd-card could not be applied. The frame shows the component's defaults.");
    expect(designFrameOptionsProblem(hosting(false))).toBeNull();
    // The same record answers the same text, so the canvas can compare it cheaply.
    const frame = hosting(true, "last-good");
    expect(designFrameOptionsProblem(frame)).toBe(designFrameOptionsProblem(frame));
  });

  it("is a closed mark kind carrying the reason as its title and accessible name", () => {
    const message = "These options could not be applied. The frame shows its last good render.";
    const mark = renderToStaticMarkup(createElement(DesignFrameProblemMark, { kind: "options-not-applied", message }));
    expect(mark).toContain('data-design-frame-problem="options-not-applied"');
    expect(mark).toContain(`title="${message}"`);
    expect(mark).toContain(`aria-label="${message}"`);
    expect(mark).toContain("text-red-primary");
  });

  it("is drawn on the frame's label before anything is selected", () => {
    expect(canvasSource).toContain("designFrameOptionsProblem(frame)");
    expect(canvasSource).toContain('<DesignFrameProblemMark kind="options-not-applied" message={optionsProblem} />');
    const optionsSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer/features/design-workspace/design-component-options.tsx"), "utf8");
    expect(optionsSource).toContain("DESIGN_OPTIONS_NOT_APPLIED_MESSAGES[notApplied]");
  });
});

describe("a component whose declaration is too large to show", () => {
  it("says in its Options why there are none to show, for the main and its instances", () => {
    expect(designComponentRecordProblem({ elements: [], reach: {}, exceeds: "elements" }, "QA Chip"))
      .toBe("The options of QA Chip cannot be shown: its declaration has more than 160 elements.");
    expect(designComponentRecordProblem({ elements: [], reach: {}, file: "page-1/chip.html", frame: true, exceeds: "attribute-value" }, "Chip"))
      .toBe("The options of Chip cannot be shown: a declaration attribute's value is longer than 2,048 characters.");
    expect(designComponentRecordProblem({ elements: [], reach: {} }, "Chip")).toBeNull();
    const optionsSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer/features/design-workspace/design-component-options.tsx"), "utf8");
    expect(optionsSource).toContain("designComponentRecordProblem(target.component, title)");
    expect(optionsSource).toContain("data-design-options-too-large");
  });
});

describe("the Options section of a component it cannot list", () => {
  const sectionOf = (target: Parameters<typeof DesignComponentOptions>[0]["target"]) => {
    const html = renderToStaticMarkup(createElement(DesignComponentOptions, {
      workspaceId: "local", directory: "Zeros - Design", lint: null, disabled: false, target,
      frame: { file: "page-1/big.html", frameId: "big", pageId: "page", title: "QA Big", kind: "frame", x: 0, y: 0, width: 100, height: 100,
        z: 0, nodeCount: 1, modifiedAt: 0, sourceVersion: "a".repeat(24) } as DesignCanvasFrameWire,
    }));
    const host = document.createElement("div");
    host.innerHTML = html;
    return host;
  };
  /** The element and everything in it can wrap: nothing cuts its text to one line. */
  const wraps = (element: Element) => [element, ...element.querySelectorAll("*")]
    .every((node) => !/\b(truncate|text-ellipsis|whitespace-nowrap|line-clamp-\d)\b/.test(node.getAttribute("class") ?? ""));
  const SENTENCE = "The options of QA Big cannot be shown: its declaration has more than 160 elements.";

  it("says why in full, and offers no variants it cannot read, on the main", () => {
    const section = sectionOf({ kind: "main", component: { elements: [], reach: {}, exceeds: "elements" } });
    const message = section.querySelector('[data-design-options-too-large="elements"]')!;
    expect(message.textContent).toBe(SENTENCE);
    expect(wraps(message)).toBe(true);
    expect(section.querySelector("[data-design-options-variant]")).toBeNull();
    expect(section.querySelector('[aria-label="Save as variant"]')).toBeNull();
    expect(section.querySelector("[data-design-options-ask]")).not.toBeNull();
    // A main whose declaration arrived keeps its Variant row.
    expect(sectionOf({ kind: "main", component: { elements: [], reach: {} } }).querySelector("[data-design-options-variant]")).not.toBeNull();
  });

  it("says why in full on an instance, and shows an ignored attribute whole", () => {
    const section = sectionOf({ kind: "instance", nodeId: "bh-inst", title: "QA Big",
      host: { component: "qa-big", attributes: {}, ignored: { tone: "loud" } },
      component: { elements: [], reach: {}, file: "page-1/big.html", frame: true, exceeds: "elements" } });
    const message = section.querySelector('[data-design-options-too-large="elements"]')!;
    expect(message.textContent).toBe(SENTENCE);
    expect(wraps(message)).toBe(true);
    const ignored = section.querySelector("[data-design-options-ignored]")!;
    expect(ignored.textContent).toBe('This component has no option tone; tone="loud" is ignored.');
    expect(wraps(ignored)).toBe(true);
    expect(section.querySelector("[data-design-options-variant]")).toBeNull();
  });
});
