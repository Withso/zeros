// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignFrameView } from "../state/design-frame-view";

const STORAGE_KEY = "zeros:design-component-variants-v1";

const component = (variants: string[]) => ({
  elements: [
    { tag: "zd-option", attributes: [{ name: "name", value: "width" }, { name: "type", value: "number" }, { name: "default", value: "1" }] },
    ...variants.map((name) => ({ tag: "zd-variant", attributes: [{ name: "name", value: name }, { name: "width", value: "2" }] })),
  ],
  reach: { width: "css" as const },
});

async function load() {
  vi.resetModules();
  return import("../state/design-component-variants");
}

describe("the variant a main component frame shows", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("is personal view state per workspace and frame, restored synchronously", async () => {
    const first = await load();
    const frame = { file: "home/main.html", component: component(["compact", "wide-plan"]) };
    expect(first.designShownComponentVariant("ws1", frame)).toBeNull();
    first.showDesignComponentVariant("ws1", frame.file, "compact");
    expect(first.designShownComponentVariant("ws1", frame)).toBe("compact");
    expect(first.designShownComponentVariant("ws2", frame)).toBeNull();
    first.flushDesignComponentVariantsForTests();
    // A reload reads it back before anything renders.
    const second = await load();
    expect(second.designShownComponentVariant("ws1", frame)).toBe("compact");
    second.showDesignComponentVariant("ws1", frame.file, null);
    expect(second.designShownComponentVariant("ws1", frame)).toBeNull();
  });

  it("shows only a variant the frame declares, and forgets one it no longer does", async () => {
    const variants = await load();
    variants.showDesignComponentVariant("ws1", "home/main.html", "compact");
    variants.showDesignComponentVariant("ws1", "home/gone.html", "compact");
    variants.showDesignComponentVariant("ws1", "home/other.html", "compact");
    expect(variants.designShownComponentVariant("ws1", { file: "home/main.html", component: component(["wide-plan"]) })).toBeNull();
    expect(variants.designShownComponentVariant("ws1", { file: "home/main.html" })).toBeNull();
    variants.pruneDesignComponentVariants("ws1", {
      frames: [{ file: "home/main.html", component: component(["wide-plan"]) }, { file: "home/other.html", component: component(["compact"]) }],
      files: ["home/main.html", "home/other.html"],
    });
    expect(variants.designComponentVariantsForTests("ws1")).toEqual({ "home/other.html": "compact" });
  });

  it("captures the shown named variant synchronously per workspace and maps interaction previews to defaults", async () => {
    const variants = await load();
    const frame = { file: "home/main.html", component: component(["compact", "wide-plan", "hover"]) };
    variants.showDesignComponentVariant("ws1", frame.file, "compact");
    const captured = variants.designComponentCopyVariant("ws1", frame);
    variants.showDesignComponentVariant("ws1", frame.file, "wide-plan");
    expect(captured).toBe("compact");
    expect(variants.designComponentCopyVariant("ws2", frame)).toBeNull();
    const stateFrame = { file: "home/state.html", component: { elements: [
      { tag: "zd-variant", attributes: [{ name: "name", value: "hover" }, { name: "zd-state", value: "hover" }] },
    ], reach: { width: "css" as const } } };
    variants.showDesignComponentVariant("ws1", stateFrame.file, "hover");
    expect(variants.designComponentCopyVariant("ws1", stateFrame)).toBeNull();
  });

  it("pins a presented generation and its named variant together", async () => {
    const variants = await load();
    const prepared: DesignFrameView = {
      file: "home/main.html", frameId: "main", pageId: "page", title: "Main", kind: "frame",
      x: 0, y: 0, width: 800, height: 600, z: 0, nodeCount: 1, layerCount: 1, modifiedAt: 1,
      sourceVersion: "a".repeat(24), component: component(["compact", "wide-plan"]),
    };
    const descriptor: DesignFrameView = {
      file: prepared.file, frameId: prepared.frameId, pageId: prepared.pageId, title: prepared.title, kind: prepared.kind,
      x: prepared.x, y: prepared.y, width: prepared.width, height: prepared.height, z: prepared.z,
      preparation: "unprepared", previous: prepared,
    };
    variants.showDesignComponentVariant("ws1", prepared.file, "compact");
    const captured = variants.captureDesignFrameComponentCopy("ws1", descriptor);
    variants.showDesignComponentVariant("ws1", prepared.file, "wide-plan");
    expect(captured).toMatchObject({
      frame: prepared,
      sourceVersion: prepared.sourceVersion,
      componentCopy: { variant: "compact" },
      statePreview: false,
    });
    expect(variants.captureDesignFrameComponentCopy("ws1", { ...descriptor, file: "home/cold.html", previous: undefined })).toBeNull();
  });

  it("refuses names that are not a variant's and keeps its store bounded", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ws1: { frames: { "home/a.html": "Bad name", "home/b.html": "ok", "../x.html": "ok" }, updatedAt: 1 },
      "": { frames: {}, updatedAt: 2 },
    }));
    const variants = await load();
    expect(variants.designComponentVariantsForTests("ws1")).toEqual({ "home/b.html": "ok" });
    expect(() => variants.showDesignComponentVariant("ws1", "home/a.html", "Bad name")).toThrow();
    for (let index = 0; index < 80; index += 1) variants.showDesignComponentVariant("ws1", `home/f${index}.html`, "compact");
    expect(Object.keys(variants.designComponentVariantsForTests("ws1")).length).toBeLessThanOrEqual(64);
    expect(variants.designComponentVariantsForTests("ws1")["home/f79.html"]).toBe("compact");
  });
});
