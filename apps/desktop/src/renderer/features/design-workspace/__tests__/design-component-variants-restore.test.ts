// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignFrameComponent } from "@zeros/protocol/design-catalog";
import type { DesignWorkspaceSnapshotWire } from "../../../platform/git";

const FILE = "qa/chip.html";
const option = { tag: "zd-option", attributes: [{ name: "name", value: "label" }, { name: "type", value: "text" }, { name: "default", value: "Send" }] };
const variant = (name: string) => ({ tag: "zd-variant", attributes: [{ name: "name", value: name }, { name: "label", value: name }] });
const component = (...variants: string[]): DesignFrameComponent => ({ elements: [option, ...variants.map(variant)], reach: { label: "structure" } });

type Frame = DesignWorkspaceSnapshotWire["frames"][number];
const frame = (file: string, extra: Partial<Frame> = {}): Frame => ({
  file, frameId: `frame_${file.replace(/\W/g, "_")}`, pageId: "page_qa", title: file, kind: "frame", width: 320, height: 120,
  x: 0, y: 0, z: 0, nodeCount: 3, modifiedAt: 1, sourceVersion: "a".repeat(24), surfaceCost: { sourceBytes: 100, nodes: 3, imageBytes: 0 }, ...extra,
});
/** The engine's aggregate read of a directory: every record is current. */
const aggregate = (frames: Frame[], files = frames.map((entry) => entry.file)): DesignWorkspaceSnapshotWire => ({
  protocolCapability: "c".repeat(64), directoryId: "design_qa",
  pages: [{ id: "page_qa", title: "QA", folder: "qa", frameFiles: files, frameIds: files.map((file) => `frame_${file.replace(/\W/g, "_")}`) }],
  frames, tokens: [], tokenSourceVersion: "b".repeat(24), assets: [],
  lint: { workspacePath: "/work/qa", checkedFiles: frames.map((entry) => entry.file), violations: [], healedOids: 0 },
});
/** A lazily prepared catalog: `current` lists the records prepared for it. */
const navigation = (frames: Frame[], current: string[], files = frames.map((entry) => entry.file)): DesignWorkspaceSnapshotWire => ({
  ...aggregate(frames, files),
  preparation: { revision: "d".repeat(64), epoch: 1, current, errors: {}, descriptions: files.map((file) => {
    const { frameId, pageId, title, kind, x, y, width, height, z } = frame(file);
    return { preparation: "unprepared" as const, file, frameId, pageId, title, kind, x, y, width, height, z };
  }) },
});

async function realm() {
  vi.resetModules();
  return {
    variants: await import("../state/design-component-variants"),
    boot: await import("../state/design-workspace-boot-cache"),
  };
}

describe("the variant a main component frame shows, across a relaunch", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it("survives the boot preview, whose records carry no component", async () => {
    vi.useFakeTimers();
    const before = await realm();
    before.variants.showDesignComponentVariant("ws1", FILE, "compact");
    before.variants.flushDesignComponentVariantsForTests();
    before.boot.queueDesignWorkspaceBootSnapshot("ws1", aggregate([frame(FILE, { component: component("compact") })]));
    vi.runAllTimers();
    vi.useRealTimers();

    const after = await realm();
    const preview = after.boot.readDesignWorkspaceBootSnapshots().get("ws1")!;
    expect(preview.frames.map((entry) => entry.file)).toEqual([FILE]);
    expect(preview.frames[0]!.component).toBeUndefined();
    after.variants.pruneDesignComponentVariantsFor("ws1", preview);
    expect(after.variants.designComponentVariantsForTests("ws1")).toEqual({ [FILE]: "compact" });
    // The first catalog keeps the preview's records until they are prepared.
    after.variants.pruneDesignComponentVariantsFor("ws1", navigation(preview.frames, []));
    expect(after.variants.designComponentVariantsForTests("ws1")).toEqual({ [FILE]: "compact" });
    after.variants.pruneDesignComponentVariantsFor("ws1", navigation([frame(FILE, { component: component("compact") })], [FILE]));
    expect(after.variants.designComponentVariantsForTests("ws1")).toEqual({ [FILE]: "compact" });
  });

  it("survives the boot preview as the workspace reads it from the snapshot cache", async () => {
    vi.useFakeTimers();
    const before = await realm();
    before.variants.showDesignComponentVariant("ws1", FILE, "compact");
    before.variants.flushDesignComponentVariantsForTests();
    before.boot.queueDesignWorkspaceBootSnapshot("ws1", aggregate([frame(FILE, { component: component("compact") })]));
    vi.runAllTimers();
    vi.useRealTimers();

    const after = await realm();
    const { designWorkspaceSnapshotCache } = await import("../state/design-workspace-cache");
    const cached = designWorkspaceSnapshotCache.peekSnapshot("ws1").data!;
    expect(cached.frames.map((entry) => entry.file)).toEqual([FILE]);
    expect(after.boot.isDesignWorkspaceBootPreview(cached)).toBe(true);
    after.variants.pruneDesignComponentVariantsFor("ws1", cached);
    expect(after.variants.designComponentVariantsForTests("ws1")).toEqual({ [FILE]: "compact" });
  });

  it("reads nothing from a snapshot when its workspace stores no variant", async () => {
    const { variants } = await realm();
    variants.showDesignComponentVariant("ws1", FILE, "compact");
    const untouchable = new Proxy({} as DesignWorkspaceSnapshotWire, {
      get: (_target, key) => { throw new Error(`read ${String(key)}`); },
    });
    expect(() => variants.pruneDesignComponentVariantsFor("ws2", untouchable)).not.toThrow();
    expect(variants.designComponentVariantsForTests("ws1")).toEqual({ [FILE]: "compact" });
  });

  it("survives a boot preview older than the frame", async () => {
    vi.useFakeTimers();
    const before = await realm();
    before.boot.queueDesignWorkspaceBootSnapshot("ws1", aggregate([frame("qa/other.html")]));
    vi.runAllTimers();
    before.variants.showDesignComponentVariant("ws1", FILE, "compact");
    before.variants.flushDesignComponentVariantsForTests();
    vi.useRealTimers();
    const after = await realm();
    after.variants.pruneDesignComponentVariantsFor("ws1", after.boot.readDesignWorkspaceBootSnapshots().get("ws1")!);
    expect(after.variants.designComponentVariantsForTests("ws1")).toEqual({ [FILE]: "compact" });
  });

  it("is dropped once a prepared record no longer declares it", async () => {
    const { variants } = await realm();
    variants.showDesignComponentVariant("ws1", FILE, "compact");
    variants.pruneDesignComponentVariantsFor("ws1", navigation([frame(FILE, { component: component("loud") })], [FILE]));
    expect(variants.designComponentVariantsForTests("ws1")).toEqual({});
  });

  it("is dropped once a current record is no longer a component", async () => {
    const { variants } = await realm();
    variants.showDesignComponentVariant("ws1", FILE, "compact");
    variants.pruneDesignComponentVariantsFor("ws1", aggregate([frame(FILE)]));
    expect(variants.designComponentVariantsForTests("ws1")).toEqual({});
  });

  it("is dropped once the frame leaves the catalog, prepared or not", async () => {
    const { variants } = await realm();
    variants.showDesignComponentVariant("ws1", FILE, "compact");
    variants.showDesignComponentVariant("ws1", "qa/gone.html", "compact");
    variants.pruneDesignComponentVariantsFor("ws1", navigation([], [], [FILE]));
    expect(variants.designComponentVariantsForTests("ws1")).toEqual({ [FILE]: "compact" });
    variants.pruneDesignComponentVariantsFor("ws1", aggregate([frame("qa/other.html")]));
    expect(variants.designComponentVariantsForTests("ws1")).toEqual({});
  });

  it("stays with its own workspace", async () => {
    const { variants } = await realm();
    variants.showDesignComponentVariant("ws1", FILE, "compact");
    const record = frame(FILE, { component: component("compact") });
    expect(variants.designShownComponentVariant("ws2", record)).toBeNull();
    variants.pruneDesignComponentVariantsFor("ws2", aggregate([frame(FILE)]));
    expect(variants.designComponentVariantsForTests("ws1")).toEqual({ [FILE]: "compact" });
    expect(variants.designShownComponentVariant("ws1", record)).toBe("compact");
  });
});
