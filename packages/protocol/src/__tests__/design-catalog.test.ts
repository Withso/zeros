import { describe, expect, it } from "vitest";
import { COMPONENT_OPTION_LIMITS } from "@zeros/design-core/component-options";
import {
  DESIGN_CATALOG_WIDE_BATCH_ENTRIES,
  DESIGN_COMPONENT_RECORD_LIMITS,
  designComponentRecordWithinLimits,
  designFrameComponentSchema,
  designFrameInstanceComponentSchema,
  designCatalogBatchSchema,
  designCatalogReadSchema,
  designCatalogReplySchema,
  parseDesignFramesPrepareReply,
  designFramesLintReplySchema,
  designFramesLintSchema,
} from "../design-catalog";

describe("what a frame whose options do not apply says it shows", () => {
  const frame = { file: "page/a.html", frameId: "a", pageId: "page", title: "A", kind: "frame", x: 0, y: 0, width: 1, height: 1, z: 0,
    sourceVersion: "b".repeat(24), nodeCount: 1, modifiedAt: 0 };
  const reply = (notApplied: string) => ({ directoryId: "design_test", catalogRevision: "a".repeat(64), errors: [], frames: [
    { ...frame, component: { elements: [], reach: {}, notApplied } },
    { ...frame, file: "page/b.html", frameId: "b", instances: { key: "0".repeat(16), components: {}, hosts: {}, notApplied } }] });
  it("accepts nothing only from a reply the renderer negotiated it for", () => {
    const negotiated = parseDesignFramesPrepareReply(reply("nothing"), { optionsShowNothing: true });
    expect(negotiated.errors).toEqual([]);
    expect(negotiated.frames.map((candidate) => candidate.component?.notApplied ?? candidate.instances?.notApplied)).toEqual(["nothing", "nothing"]);
    const legacy = parseDesignFramesPrepareReply(reply("nothing"));
    expect(legacy.frames).toEqual([]);
    expect(legacy.errors.map((error) => error.file)).toEqual(["page/a.html", "page/b.html"]);
    for (const shows of ["last-good", "defaults"])
      expect(parseDesignFramesPrepareReply(reply(shows)).frames).toHaveLength(2);
    expect(parseDesignFramesPrepareReply(reply("everything"), { optionsShowNothing: true }).frames).toEqual([]);
  });
});

const batch = {
  kind: "design-catalog",
  version: 1,
  status: "ready",
  owner: {
    workspaceId: "local",
    directoryId: "design_test",
    organizationId: null,
    placement: "local",
  },
  binding: "b".repeat(64),
  revision: "a".repeat(64),
  intent: 1,
  pages: [{ id: "p", title: "Page", folder: "", count: 1 }],
  total: 1,
  offset: 0,
  frames: [
    {
      id: "home",
      source: "home.html",
      pageId: "p",
      title: "Home",
      kind: "html",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      z: 0,
      order: 0,
      preparation: "unprepared",
    },
  ],
  coverage: "complete",
  nextCursor: null,
};

describe("metadata-only Design catalog wire", () => {
  it("rejects a batch whose descriptor order disagrees with its coverage offset", () => {
    expect(
      designCatalogBatchSchema.safeParse({
        ...batch,
        total: 2,
        pages: [{ ...batch.pages[0], count: 2 }],
        frames: [{ ...batch.frames[0], order: 1 }],
        coverage: "partial",
        nextCursor: "remaining",
      }).success,
    ).toBe(false);
  });
  it("distinguishes a complete batch from the terminal fragment of a progressive read", () => {
    expect(designCatalogBatchSchema.parse(batch)).toEqual(batch);
    const last = {
      ...batch,
      offset: 1,
      total: 2,
      frames: [{ ...batch.frames[0], order: 1 }],
      pages: [{ ...batch.pages[0], count: 2 }],
      coverage: "partial",
    };
    expect(designCatalogBatchSchema.safeParse(last).success).toBe(true);
    expect(
      designCatalogBatchSchema.safeParse({ ...last, coverage: "complete" })
        .success,
    ).toBe(false);
    expect(
      designCatalogBatchSchema.safeParse({ ...batch, nextCursor: "more" })
        .success,
    ).toBe(false);
  });
  it("keeps the operation explicit and rejects old snapshots, excess fields, unsafe owners and memberships", () => {
    const input = {
      version: 1,
      workspaceId: "local",
      directoryId: "design_test",
      intent: 1,
    };
    expect(designCatalogReadSchema.parse(input)).toEqual(input);
    for (const value of [
      { ...input, version: 2 },
      { ...input, limit: DESIGN_CATALOG_WIDE_BATCH_ENTRIES + 1 },
      { ...input, root: "/other" },
      { ...input, intent: -1 },
    ])
      expect(designCatalogReadSchema.safeParse(value).success).toBe(false);
    for (const value of [
      { frames: [], tokens: [], assets: [], protocolCapability: null },
      { ...batch, sourceVersion: "a".repeat(24) },
      { ...batch, owner: { ...batch.owner, placement: "cloud" } },
      { ...batch, frames: [{ ...batch.frames[0], pageId: "missing" }] },
      { ...batch, frames: [{ ...batch.frames[0], source: "../outside.html" }] },
      { ...batch, frames: [{ ...batch.frames[0], order: 1 }] },
    ])
      expect(designCatalogReplySchema.safeParse(value).success).toBe(false);
  });
  it("lets a request ask for a wide batch, and no wider", () => {
    const request = { version: 1, workspaceId: "local", directoryId: "design_test", intent: 1 };
    expect(DESIGN_CATALOG_WIDE_BATCH_ENTRIES).toBe(4096);
    expect(designCatalogReadSchema.safeParse({ ...request, limit: DESIGN_CATALOG_WIDE_BATCH_ENTRIES }).success).toBe(true);
    expect(designCatalogReadSchema.safeParse({ ...request, limit: DESIGN_CATALOG_WIDE_BATCH_ENTRIES + 1 }).success).toBe(false);
  });
  it("bounds encoded UTF-8 bytes independently of descriptor count", () => {
    // Past the wide batch's 1 MB: a wide batch may hold more than 256 KB.
    const frames = Array.from({ length: 256 }, (_, i) => ({
      ...batch.frames[0],
      id: `f${i}`,
      source: `${i}${"x".repeat(4000)}.html`,
      order: i,
    }));
    expect(
      designCatalogBatchSchema.safeParse({
        ...batch,
        frames,
        total: frames.length,
        pages: [{ ...batch.pages[0], count: frames.length }],
      }).success,
    ).toBe(false);
  });
});

describe("a component record past the declaration limits", () => {
  const oversize = Array.from({ length: DESIGN_COMPONENT_RECORD_LIMITS.elements + 1 }, () => ({ tag: "zd-note", attributes: [] }));
  // The longest file and option name authored input can reach: a 64-character page folder, a
  // 255-character file name (the file system's longest), and a 32-character option name.
  const longestFile = `${"p".repeat(64)}/${"f".repeat(250)}.html`;
  const longestOption = `o${"-a".repeat(15)}0`;

  it("still holds its schema, for a main frame and for an instance's component", () => {
    expect(longestOption).toHaveLength(COMPONENT_OPTION_LIMITS.name);
    expect(DESIGN_COMPONENT_RECORD_LIMITS.optionName).toBe(COMPONENT_OPTION_LIMITS.name);
    const main = designComponentRecordWithinLimits({ elements: oversize, reach: { [longestOption]: "css" as const }, notApplied: "defaults" as const,
      boundText: { b: [longestOption] } });
    expect(main).toMatchObject({ elements: [], reach: {}, exceeds: "elements" });
    expect(designFrameComponentSchema.safeParse(main).success).toBe(true);
    const placed = designComponentRecordWithinLimits({ elements: oversize, reach: { [longestOption]: "structure" as const }, file: longestFile, frame: true },
      designFrameInstanceComponentSchema);
    expect(placed).toMatchObject({ elements: [], reach: {}, exceeds: "elements", file: longestFile });
    expect(designFrameInstanceComponentSchema.safeParse(placed).success).toBe(true);
  });
});

describe("design.frames.lint", () => {
  const version = "b".repeat(24);
  const request = { workspaceId: "local", directoryId: "design_test", frames: [{ file: "page/a.html", sourceVersion: version }] };

  it("names each frame once, at an exact source version, at most 16 a request", () => {
    expect(designFramesLintSchema.parse(request)).toEqual(request);
    for (const frames of [[], [...request.frames, ...request.frames], [{ file: "page/a.html", sourceVersion: "not-a-version" }],
      Array.from({ length: 17 }, (_, index) => ({ file: `page/f${index}.html`, sourceVersion: version }))])
      expect(designFramesLintSchema.safeParse({ ...request, frames }).success).toBe(false);
    expect(designFramesLintSchema.safeParse({ ...request, lintFiles: ["page/a.html"] }).success).toBe(false);
  });

  it("replies with the frames it linted and their rows only", () => {
    const reply = { frames: request.frames, checkedFiles: ["page/a.html"],
      violations: [{ ruleId: "unknown-token", severity: "warning", message: "Unknown", file: "page/a.html", line: 1, column: 1 }] };
    expect(designFramesLintReplySchema.parse(reply)).toEqual(reply);
    expect(designFramesLintReplySchema.safeParse({ ...reply, workspacePath: "/x" }).success).toBe(false);
  });
});
